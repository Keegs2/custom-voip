import { useQuery } from '@tanstack/react-query';
import { listTrunkTiers, listApiTiers } from '../../api/tiers';
import { listCallPaths } from '../../api/trunks';
import type { Tier } from '../../types/tier';
import { Spinner } from '../../components/ui/Spinner';
import { Badge } from '../../components/ui/Badge';
import { Table, Thead, Th, Td, Tr } from '../../components/ui/Table';
import { IconTrunk, IconAPI, IconRCF } from '../../components/icons/ProductIcons';
import { fmtMoney } from '../../utils/format';

/**
 * Flat RCF price — mirrors the backend `RCF_LINE_MRC` constant. RCF has no tier
 * table (it is a single flat per-line MRC), so it is surfaced as a labeled
 * constant rather than fetched. Keep in sync with the backend value.
 */
const RCF_LINE_MRC = 5.0;

/**
 * Maps internal API-tier names to their customer-facing product names.
 * The backend stores api_basic / api_standard / api_premium; the sales-facing
 * names are Starter / Growth / Scale.
 */
const API_DISPLAY_NAMES: Record<string, string> = {
  api_basic: 'Starter',
  api_standard: 'Growth',
  api_premium: 'Scale',
};

/** Title-cases an underscore/snake name, stripping a leading product prefix. */
function toTitleCase(str: string): string {
  return str.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function trunkDisplayName(name: string): string {
  return toTitleCase(name.replace(/^trunk_/, ''));
}

function apiDisplayName(name: string): string {
  return API_DISPLAY_NAMES[name] ?? toTitleCase(name.replace(/^api_/, ''));
}

/** Coerce the API's possibly-stringified numerics into a real number. */
function num(value: unknown): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : 0;
}

/** "$0.010/call" style label; empty string when there is no per-call fee. */
function perCallLabel(fee: unknown): string {
  const n = num(fee);
  if (n <= 0) return '';
  // API per-call fees are sub-cent — show 3 decimals so $0.005 is legible.
  return `$${n.toFixed(3)}/call`;
}

// ---------------------------------------------------------------------------
// Shared section shell
// ---------------------------------------------------------------------------

interface ProductSectionProps {
  icon: React.ReactNode;
  accent: string;
  title: string;
  subtitle: string;
  badge?: React.ReactNode;
  premium?: boolean;
  children: React.ReactNode;
}

/** Glass panel wrapper for one product. Premium variant adds a soft blue glow. */
function ProductSection({ icon, accent, title, subtitle, badge, premium, children }: ProductSectionProps) {
  return (
    <section
      className="glass-surface"
      style={{
        borderRadius: 16,
        padding: 24,
        boxShadow: premium ? '0 0 0 1px rgba(59,130,246,0.18), 0 0 28px rgba(59,130,246,0.08)' : undefined,
      }}
    >
      <div
        className="flex items-start justify-between flex-wrap"
        style={{ gap: 12, marginBottom: 20 }}
      >
        <div className="flex items-center" style={{ gap: 12 }}>
          <div
            className="flex items-center justify-center flex-shrink-0"
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              background: `${accent}1a`,
              border: `1px solid ${accent}40`,
              color: accent,
            }}
          >
            {icon}
          </div>
          <div>
            <h2 style={{ fontSize: '1rem', fontWeight: 700, color: '#e2e8f0', margin: 0, letterSpacing: '-0.01em' }}>
              {title}
            </h2>
            <p style={{ fontSize: '0.8rem', color: '#718096', marginTop: 3, lineHeight: 1.5 }}>{subtitle}</p>
          </div>
        </div>
        {badge && <div className="flex-shrink-0">{badge}</div>}
      </div>
      {children}
    </section>
  );
}

/** Uniform per-section loading / error / empty states. */
function SectionState({
  isLoading,
  isError,
  isEmpty,
  loadingLabel,
  errorLabel,
  emptyLabel,
}: {
  isLoading: boolean;
  isError: boolean;
  isEmpty: boolean;
  loadingLabel: string;
  errorLabel: string;
  emptyLabel: string;
}): React.ReactElement | null {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2.5 text-[#718096] py-5">
        <Spinner /> {loadingLabel}
      </div>
    );
  }
  if (isError) return <p className="text-red-400 text-sm py-4">{errorLabel}</p>;
  if (isEmpty) return <p className="text-[#718096] text-sm py-4">{emptyLabel}</p>;
  return null;
}

// ---------------------------------------------------------------------------
// SIP Trunking
// ---------------------------------------------------------------------------

function TrunkTierRows({ tiers }: { tiers: Tier[] }) {
  const sorted = [...tiers].sort((a, b) => a.cps_limit - b.cps_limit);
  return (
    <Table>
      <Thead>
        <tr>
          <Th>Tier</Th>
          <Th className="text-right">CPS</Th>
          <Th className="text-right">Included Paths</Th>
          <Th className="text-right">Monthly</Th>
          <Th className="text-right">Per-Call</Th>
        </tr>
      </Thead>
      <tbody>
        {sorted.map((t) => {
          const perCall = perCallLabel(t.per_call_fee);
          return (
            <Tr key={t.id}>
              <Td>
                <div className="flex flex-col" style={{ gap: 2 }}>
                  <span className="font-semibold text-[#e2e8f0]">{trunkDisplayName(t.name)}</span>
                  {t.description && <span className="text-[#718096] text-xs">{t.description}</span>}
                </div>
              </Td>
              <Td className="text-right tabular-nums text-[#cbd5e1]">{t.cps_limit}</Td>
              <Td className="text-right tabular-nums text-[#cbd5e1]">
                {t.call_paths != null ? t.call_paths : '--'}
              </Td>
              <Td className="text-right tabular-nums font-semibold text-[#e2e8f0]">{fmtMoney(num(t.monthly_fee))}/mo</Td>
              <Td className="text-right tabular-nums text-[#718096]">{perCall || '--'}</Td>
            </Tr>
          );
        })}
      </tbody>
    </Table>
  );
}

interface CallPathAddOn {
  id: number;
  name: string;
  paths: number | null;
  monthly_fee: number;
  description?: string | null;
}

function AddOnsTable({ addOns }: { addOns: CallPathAddOn[] }) {
  const sorted = [...addOns].sort((a, b) => (a.paths ?? 0) - (b.paths ?? 0));
  return (
    <Table>
      <Thead>
        <tr>
          <Th>Add-On</Th>
          <Th className="text-right">Additional Paths</Th>
          <Th className="text-right">Monthly</Th>
        </tr>
      </Thead>
      <tbody>
        {sorted.map((p) => (
          <Tr key={p.id}>
            <Td>
              <div className="flex flex-col" style={{ gap: 2 }}>
                <span className="font-semibold text-[#e2e8f0]">{p.name || `${p.paths ?? '--'} Paths`}</span>
                {p.description && <span className="text-[#718096] text-xs">{p.description}</span>}
              </div>
            </Td>
            <Td className="text-right tabular-nums text-[#cbd5e1]">
              {p.paths != null ? `+${p.paths}` : '--'}
            </Td>
            <Td className="text-right tabular-nums font-semibold text-[#e2e8f0]">{fmtMoney(num(p.monthly_fee))}/mo</Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// API Calling
// ---------------------------------------------------------------------------

/** Sort helper so Starter → Growth → Scale render in product order. */
const API_ORDER: Record<string, number> = { api_basic: 0, api_standard: 1, api_premium: 2 };

function ApiTierRows({ tiers }: { tiers: Tier[] }) {
  const sorted = [...tiers].sort(
    (a, b) => (API_ORDER[a.name] ?? a.cps_limit) - (API_ORDER[b.name] ?? b.cps_limit),
  );
  return (
    <Table>
      <Thead>
        <tr>
          <Th>Plan</Th>
          <Th className="text-right">CPS</Th>
          <Th className="text-right">Monthly</Th>
          <Th className="text-right">Per-Call</Th>
        </tr>
      </Thead>
      <tbody>
        {sorted.map((t) => {
          const perCall = perCallLabel(t.per_call_fee);
          return (
            <Tr key={t.id}>
              <Td>
                <div className="flex flex-col" style={{ gap: 2 }}>
                  <span className="font-semibold" style={{ color: '#c4b5fd' }}>
                    {apiDisplayName(t.name)}
                  </span>
                  {t.description && <span className="text-[#718096] text-xs">{t.description}</span>}
                </div>
              </Td>
              <Td className="text-right tabular-nums text-[#cbd5e1]">{t.cps_limit}</Td>
              <Td className="text-right tabular-nums font-semibold text-[#e2e8f0]">{fmtMoney(num(t.monthly_fee))}/mo</Td>
              <Td className="text-right tabular-nums text-[#cbd5e1]">{perCall || '--'}</Td>
            </Tr>
          );
        })}
      </tbody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const ACCENT_TRUNK = '#22c55e';
const ACCENT_API = '#a855f7';
const ACCENT_RCF = '#3b82f6';

export function TiersTab() {
  const trunkQuery = useQuery({ queryKey: ['tiers', 'trunk'], queryFn: listTrunkTiers });
  const apiQuery = useQuery({ queryKey: ['tiers', 'api'], queryFn: listApiTiers });
  const addOnsQuery = useQuery({ queryKey: ['trunks', 'call-paths'], queryFn: listCallPaths });

  const trunkTiers = trunkQuery.data ?? [];
  const apiTiers = apiQuery.data ?? [];
  const addOns: CallPathAddOn[] = (addOnsQuery.data ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    // The endpoint uses either `call_paths` or `paths` depending on backend version.
    paths: p.call_paths ?? p.paths ?? null,
    monthly_fee: num(p.monthly_fee),
    description: p.description,
  }));

  return (
    <div className="flex flex-col" style={{ gap: 20 }}>
      {/* 1) SIP Trunking */}
      <ProductSection
        icon={<IconTrunk size={20} />}
        accent={ACCENT_TRUNK}
        title="SIP Trunking"
        subtitle="Bundled CPS + included call paths with a flat MRC. Fully customizable and upsellable."
      >
        <SectionState
          isLoading={trunkQuery.isLoading}
          isError={trunkQuery.isError}
          isEmpty={trunkTiers.length === 0}
          loadingLabel="Loading trunk tiers…"
          errorLabel="Failed to load trunk tiers."
          emptyLabel="No trunk tiers configured."
        />
        {!trunkQuery.isLoading && !trunkQuery.isError && trunkTiers.length > 0 && (
          <>
            <TrunkTierRows tiers={trunkTiers} />
            <p
              className="text-[#718096]"
              style={{ fontSize: '0.75rem', lineHeight: 1.5, marginTop: 12 }}
            >
              Tiers are a starting point — CPS and included paths are customizable, and every tier is
              upsellable with call-path add-ons below.
            </p>
          </>
        )}

        {/* Call-path add-ons (secondary) */}
        <div style={{ marginTop: 20 }}>
          <div
            className="uppercase"
            style={{
              fontSize: '0.68rem',
              fontWeight: 600,
              letterSpacing: '0.05em',
              color: '#64748b',
              marginBottom: 8,
            }}
          >
            Call-Path Add-Ons
          </div>
          <SectionState
            isLoading={addOnsQuery.isLoading}
            isError={addOnsQuery.isError}
            isEmpty={addOns.length === 0}
            loadingLabel="Loading add-ons…"
            errorLabel="Failed to load call-path add-ons."
            emptyLabel="No call-path add-ons configured."
          />
          {!addOnsQuery.isLoading && !addOnsQuery.isError && addOns.length > 0 && (
            <AddOnsTable addOns={addOns} />
          )}
        </div>
      </ProductSection>

      {/* 2) API Calling — premium */}
      <ProductSection
        icon={<IconAPI size={20} />}
        accent={ACCENT_API}
        title="API Calling"
        subtitle="Programmable voice with the highest CPS. Metered per-call on top of the plan MRC."
        premium
        badge={<Badge variant="premium">Premium</Badge>}
      >
        <SectionState
          isLoading={apiQuery.isLoading}
          isError={apiQuery.isError}
          isEmpty={apiTiers.length === 0}
          loadingLabel="Loading API plans…"
          errorLabel="Failed to load API plans."
          emptyLabel="No API plans configured."
        />
        {!apiQuery.isLoading && !apiQuery.isError && apiTiers.length > 0 && (
          <ApiTierRows tiers={apiTiers} />
        )}
      </ProductSection>

      {/* 3) RCF — flat per-line MRC */}
      <ProductSection
        icon={<IconRCF size={20} />}
        accent={ACCENT_RCF}
        title="Remote Call Forwarding"
        subtitle="Flat monthly recurring charge, billed per forwarding line. No tiers, no per-call fees."
        badge={<Badge variant="rcf">Flat Rate</Badge>}
      >
        <div className="flex items-baseline flex-wrap" style={{ gap: 8 }}>
          <span style={{ fontSize: '1.9rem', fontWeight: 800, color: '#e2e8f0', lineHeight: 1 }} className="tabular-nums">
            {fmtMoney(RCF_LINE_MRC)}
          </span>
          <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#94a3b8' }}>/ line / month</span>
        </div>
      </ProductSection>
    </div>
  );
}
