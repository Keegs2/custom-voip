/**
 * TiersTab — service-tier ladders for every product (/admin/platform/tiers).
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` in index.css, plus the
 * admin `dlx-*` layer in styles/dl-admin.css and the platform-scoped `dlx2-*`
 * layer in styles/dl-platform.css). Renders INSIDE the PlatformManagementPage
 * shell, which owns the paper canvas (`dl-scope`) — this page contributes
 * only the per-product tier panels.
 *
 * React #310: every hook is called unconditionally at the top.
 */
import { useQuery } from '@tanstack/react-query';
import { listTrunkTiers, listApiTiers } from '../../api/tiers';
import { listCallPaths } from '../../api/trunks';
import type { Tier } from '../../types/tier';
import { Spinner } from '../../components/ui/Spinner';
import { IconTrunk, IconAPI, IconRCF } from '../../components/icons/ProductIcons';
import { fmtMoney } from '../../utils/format';
import '../../styles/dl-admin.css';
import '../../styles/dl-platform.css';

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

/* Shared cell styles — daylight numerics are right-aligned and tabular. */
const numCell: React.CSSProperties = {
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--rcf-ink)',
};

const numCellDim: React.CSSProperties = {
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--rcf-ink-dim)',
};

// ---------------------------------------------------------------------------
// Shared section shell
// ---------------------------------------------------------------------------

interface ProductSectionProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  badge?: React.ReactNode;
  premium?: boolean;
  children: React.ReactNode;
}

/** Daylight panel wrapper for one product. Premium variant adds a faint azure ring. */
function ProductSection({ icon, title, subtitle, badge, premium, children }: ProductSectionProps) {
  return (
    <section
      className="dl-panel"
      style={premium ? { boxShadow: '0 0 0 1px rgba(47, 125, 246, 0.2), 0 1px 2px rgba(14, 23, 38, 0.06), 0 12px 30px -18px rgba(14, 23, 38, 0.18)' } : undefined}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          padding: '16px 20px',
          borderBottom: '1px solid var(--rcf-line)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div className="dlx2-prodicon">{icon}</div>
          <div>
            <h2
              style={{
                fontFamily: '"Archivo", "IBM Plex Sans", sans-serif',
                fontSize: '0.95rem',
                fontWeight: 700,
                letterSpacing: '-0.01em',
                color: 'var(--rcf-ink)',
                margin: 0,
              }}
            >
              {title}
            </h2>
            <p style={{ fontSize: '0.76rem', color: 'var(--rcf-ink-dim)', margin: '3px 0 0', lineHeight: 1.5 }}>
              {subtitle}
            </p>
          </div>
        </div>
        {badge && <div style={{ flexShrink: 0 }}>{badge}</div>}
      </div>
      <div className="dl-panel-body">{children}</div>
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
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          color: 'var(--rcf-ink-dim)',
          fontSize: '0.82rem',
          padding: '18px 0',
        }}
      >
        <Spinner /> {loadingLabel}
      </div>
    );
  }
  if (isError) {
    return (
      <p style={{ color: 'var(--rcf-red)', fontSize: '0.82rem', padding: '14px 0', margin: 0 }}>
        {errorLabel}
      </p>
    );
  }
  if (isEmpty) {
    return (
      <p style={{ color: 'var(--rcf-ink-dim)', fontSize: '0.82rem', padding: '14px 0', margin: 0 }}>
        {emptyLabel}
      </p>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Custom (>10 CPS) — enterprise ladder cap, sold via sales
// ---------------------------------------------------------------------------

/**
 * "Contact sales" price treatment for the Custom tier. CPS above the self-serve
 * cap (10) is an exponentially-priced premium lever quoted per-account, so we
 * show a subtle azure tag instead of a number — mirroring how carriers gate
 * high CPS to sales rather than publishing a rate.
 */
function ContactSalesBadge() {
  return <span className="dl-tag">Contact&nbsp;sales</span>;
}

/**
 * Terminal "Custom" row appended to the bottom of both the SIP Trunking and API
 * Calling ladders. It is the premium/enterprise cap: CPS ">10", no published
 * price. `withPaths` renders the extra trunk-only "Included Paths" cell so the
 * single component serves both the 5-column trunk table and 4-column API table.
 */
function CustomTierRow({ withPaths, label }: { withPaths: boolean; label: string }) {
  return (
    // Reuses the shared `.dl-row` hover language and layers an always-on azure
    // tint + accent leading edge (`.dlx2-caprow`), so it reads as the premium
    // cap of the ladder without breaking the daylight table idiom.
    <tr className="dl-row dlx2-caprow">
      <td className="dlx-td">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontWeight: 700, color: 'var(--rcf-azure-deep)' }}>Custom</span>
          <span style={{ fontSize: '0.72rem', color: 'var(--rcf-ink-dim)', whiteSpace: 'normal' }}>
            Enterprise — quoted per account
          </span>
        </div>
      </td>
      <td className="dlx-td" style={numCell}>&gt;10</td>
      {withPaths && <td className="dlx-td" style={numCellDim}>Custom</td>}
      <td className="dlx-td" style={{ textAlign: 'right' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <ContactSalesBadge />
        </div>
      </td>
      <td className="dlx-td" style={numCellDim}>{label}</td>
    </tr>
  );
}

/**
 * Muted line placed under each tier ladder. Mirrors how carriers
 * quality-gate high CPS: capacity above the published tiers is granted
 * subject to a traffic-quality review (ASR / ACD).
 */
function CpsReviewNote() {
  return (
    <p style={{ fontSize: '0.72rem', lineHeight: 1.5, color: 'var(--rcf-ink-dim)', margin: '10px 0 0' }}>
      Higher CPS is subject to traffic-quality review (ASR / ACD).
    </p>
  );
}

/** Daylight table wrapper — panel-less, sits inside the product panel body. */
function TierTable({ children, minWidth = 560 }: { children: React.ReactNode; minWidth?: number }) {
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--rcf-line)', borderRadius: 10 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth }}>
        {children}
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SIP Trunking
// ---------------------------------------------------------------------------

function TrunkTierRows({ tiers }: { tiers: Tier[] }) {
  const sorted = [...tiers].sort((a, b) => a.cps_limit - b.cps_limit);
  return (
    <TierTable>
      <thead>
        <tr>
          <th className="dl-th">Tier</th>
          <th className="dl-th" style={{ textAlign: 'right' }}>
            <span title="Calls per second — the primary capacity driver and the premium pricing lever">
              CPS
            </span>
          </th>
          <th className="dl-th" style={{ textAlign: 'right' }}>Included Paths</th>
          <th className="dl-th" style={{ textAlign: 'right' }}>Monthly</th>
          <th className="dl-th" style={{ textAlign: 'right' }}>Per-Call</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((t) => {
          const perCall = perCallLabel(t.per_call_fee);
          return (
            <tr key={t.id} className="dl-row">
              <td className="dlx-td">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontWeight: 600, color: 'var(--rcf-ink)' }}>
                    {trunkDisplayName(t.name)}
                  </span>
                  {t.description && (
                    <span style={{ fontSize: '0.72rem', color: 'var(--rcf-ink-dim)', whiteSpace: 'normal' }}>
                      {t.description}
                    </span>
                  )}
                </div>
              </td>
              <td className="dlx-td" style={numCell}>{t.cps_limit}</td>
              <td className="dlx-td" style={numCell}>
                {t.call_paths != null ? t.call_paths : '--'}
              </td>
              <td className="dlx-td" style={{ ...numCell, fontWeight: 700 }}>
                {fmtMoney(num(t.monthly_fee))}/mo
              </td>
              <td className="dlx-td" style={numCellDim}>{perCall || '--'}</td>
            </tr>
          );
        })}
        {/* Enterprise cap: CPS above the self-serve limit (10) is quoted by sales. */}
        <CustomTierRow withPaths label="Custom" />
      </tbody>
    </TierTable>
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
    <TierTable minWidth={440}>
      <thead>
        <tr>
          <th className="dl-th">Add-On</th>
          <th className="dl-th" style={{ textAlign: 'right' }}>Additional Paths</th>
          <th className="dl-th" style={{ textAlign: 'right' }}>Monthly</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((p) => (
          <tr key={p.id} className="dl-row">
            <td className="dlx-td">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontWeight: 600, color: 'var(--rcf-ink)' }}>
                  {p.name || `${p.paths ?? '--'} Paths`}
                </span>
                {p.description && (
                  <span style={{ fontSize: '0.72rem', color: 'var(--rcf-ink-dim)', whiteSpace: 'normal' }}>
                    {p.description}
                  </span>
                )}
              </div>
            </td>
            <td className="dlx-td" style={numCell}>
              {p.paths != null ? `+${p.paths}` : '--'}
            </td>
            <td className="dlx-td" style={{ ...numCell, fontWeight: 700 }}>
              {fmtMoney(num(p.monthly_fee))}/mo
            </td>
          </tr>
        ))}
      </tbody>
    </TierTable>
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
    <TierTable>
      <thead>
        <tr>
          <th className="dl-th">Plan</th>
          <th className="dl-th" style={{ textAlign: 'right' }}>
            <span title="Calls per second — the primary capacity driver and the premium pricing lever">
              CPS
            </span>
          </th>
          <th className="dl-th" style={{ textAlign: 'right' }}>Monthly</th>
          <th className="dl-th" style={{ textAlign: 'right' }}>Per-Call</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((t) => {
          const perCall = perCallLabel(t.per_call_fee);
          return (
            <tr key={t.id} className="dl-row">
              <td className="dlx-td">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontWeight: 600, color: 'var(--rcf-ink)' }}>
                    {apiDisplayName(t.name)}
                  </span>
                  {t.description && (
                    <span style={{ fontSize: '0.72rem', color: 'var(--rcf-ink-dim)', whiteSpace: 'normal' }}>
                      {t.description}
                    </span>
                  )}
                </div>
              </td>
              <td className="dlx-td" style={numCell}>{t.cps_limit}</td>
              <td className="dlx-td" style={{ ...numCell, fontWeight: 700 }}>
                {fmtMoney(num(t.monthly_fee))}/mo
              </td>
              <td className="dlx-td" style={numCell}>{perCall || '--'}</td>
            </tr>
          );
        })}
        {/* Enterprise cap: CPS above the self-serve limit (10) is quoted by sales. */}
        <CustomTierRow withPaths={false} label="--" />
      </tbody>
    </TierTable>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

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
    <div className="dl-stack">
      {/* 1) SIP Trunking */}
      <ProductSection
        icon={<IconTrunk size={20} />}
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
            <p style={{ fontSize: '0.74rem', lineHeight: 1.5, color: 'var(--rcf-ink-dim)', margin: '12px 0 0' }}>
              Tiers are a starting point — CPS and included paths are customizable, and every tier is
              upsellable with call-path add-ons below.
            </p>
            <CpsReviewNote />
          </>
        )}

        {/* Call-path add-ons (secondary) */}
        <div style={{ marginTop: 20 }}>
          <div className="dl-section-title" style={{ marginBottom: 10 }}>
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
        title="API Calling"
        subtitle="Programmable voice with the highest CPS. Metered per-call on top of the plan MRC."
        premium
        badge={<span className="dl-tag">Premium</span>}
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
          <>
            <ApiTierRows tiers={apiTiers} />
            <CpsReviewNote />
          </>
        )}
      </ProductSection>

      {/* 3) RCF — flat per-line MRC */}
      <ProductSection
        icon={<IconRCF size={20} />}
        title="Remote Call Forwarding"
        subtitle="Flat monthly recurring charge, billed per forwarding line. No tiers, no per-call fees."
        badge={<span className="dl-tag">Flat Rate</span>}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
          <span
            style={{
              fontFamily: '"Archivo", "IBM Plex Sans", sans-serif',
              fontSize: '1.9rem',
              fontWeight: 700,
              color: 'var(--rcf-ink)',
              lineHeight: 1,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {fmtMoney(RCF_LINE_MRC)}
          </span>
          <span style={{ fontSize: '0.84rem', fontWeight: 600, color: 'var(--rcf-ink-dim)' }}>
            / line / month
          </span>
        </div>
      </ProductSection>
    </div>
  );
}
