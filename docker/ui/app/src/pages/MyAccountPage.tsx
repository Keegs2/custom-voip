/**
 * MyAccountPage — the customer's self-service account console.
 *
 * Tabs: Overview (identity + estimated bill + product counts), Users & Access
 * (read-only team roster), Products (per-product provisioning lists), and
 * Your Account (identity facts + display name + password, PUT /auth/me —
 * absorbed the retired standalone /account page).
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` classes in index.css,
 * aliased from the RCF console primitives) — paper canvas, quiet breadcrumb
 * header, white panels, ink text, azure accents.
 *
 * React #310: every hook in every component below is called unconditionally at
 * the top of its function, before any early return.
 */

import {
  useState,
  useMemo,
  useCallback,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  IdCard,
  Users,
  Boxes,
  ShieldCheck,
  PhoneForwarded,
  Server,
  Code2,
  Sparkles,
  AlertTriangle,
  Receipt,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { apiRequest, ApiError } from '../api/client';
import { getMyCustomer, getMyBilling, listMyTeam } from '../api/account';
import { listRcf } from '../api/rcf';
import { listTrunks } from '../api/trunks';
import { listApiDids } from '../api/apiDids';
import type { MyCustomer, BillingLineItem, TeamMember, TeamRole } from '../types/account';
import type { User } from '../types/auth';
import type { AccountType } from '../types/customer';
import { Spinner } from '../components/ui/Spinner';
import { fmt, fmtMoney } from '../utils/format';

/* ─── Design tokens (mirror the .rcf-scope / .dl-scope CSS vars) ─── */

const INK = '#0e1726';
const INK_SOFT = '#46566f';
const INK_DIM = '#5d6f8c';
const AZURE_DEEP = '#1d63dd';

const MONO =
  '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';

const ARCHIVO = '"Archivo", "IBM Plex Sans", sans-serif';

/* ─── Shared body for the update-me PUT (/auth/me) ───────── */

interface UpdateMeBody {
  name?: string;
  current_password?: string;
  new_password?: string;
}

/* ─── Small formatting helpers ───────────────────────────── */

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    dateStyle: 'medium',
  } as Intl.DateTimeFormatOptions);
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function accountTypeLabel(t: AccountType): string {
  switch (t) {
    case 'rcf': return 'Remote Call Forwarding';
    case 'api': return 'API Calling';
    case 'trunk': return 'SIP Trunking';
    case 'hybrid': return 'Hybrid (API + Trunk)';
    case 'ucaas': return 'UCaaS';
  }
}

const ROLE_LABEL: Record<TeamRole, string> = {
  admin: 'Administrator',
  user: 'User',
  readonly: 'Read-only',
};

/* ─── Daylight chips (replace the dark Badge component on this page) ─── */

/** Green/red status pill (active vs suspended/disabled); slate tag for closed. */
function StatusChip({ status }: { status: string }) {
  if (status === 'closed') {
    return <span className="dl-tag dl-tag-slate">{status}</span>;
  }
  const on = status === 'active';
  return (
    <span className={on ? 'dl-pill dl-pill-on' : 'dl-pill dl-pill-off'}>{status}</span>
  );
}

/** Boolean enabled/disabled pill for product rows. */
function EnabledPill({ enabled }: { enabled: boolean }) {
  return (
    <span className={enabled ? 'dl-pill dl-pill-on' : 'dl-pill dl-pill-off'}>
      {enabled ? 'Active' : 'Disabled'}
    </span>
  );
}

/* ─── Section shell — a titled daylight panel ─────────────── */

interface SectionProps {
  title: string;
  subtitle?: string;
  icon: ReactNode;
  actions?: ReactNode;
  /** Render children flush against the panel edges (tables). */
  flush?: boolean;
  children: ReactNode;
}

function Section({ title, subtitle, icon, actions, flush, children }: SectionProps) {
  return (
    <section className="dl-panel">
      <div className="dl-panel-head" style={{ flexWrap: 'nowrap' }}>
        <span
          aria-hidden="true"
          style={{ display: 'inline-flex', color: AZURE_DEEP, flexShrink: 0 }}
        >
          {icon}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 className="dl-panel-title" style={{ margin: 0 }}>{title}</h2>
          {subtitle && (
            <p style={{ margin: '2px 0 0', fontSize: '0.72rem', color: INK_DIM, lineHeight: 1.4 }}>
              {subtitle}
            </p>
          )}
        </div>
        {actions && <div style={{ flexShrink: 0 }}>{actions}</div>}
      </div>
      {flush ? children : <div className="dl-panel-body">{children}</div>}
    </section>
  );
}

/* ─── Stat tile ──────────────────────────────────────────── */

interface TileProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}

function Tile({ label, value, hint }: TileProps) {
  return (
    <div className="dl-tile">
      <span className="dl-tile-label">{label}</span>
      <span className="dl-tile-value">{value}</span>
      {hint && <span className="dl-tile-hint">{hint}</span>}
    </div>
  );
}

/* ─── Definition row (key → value) ───────────────────────── */

function DefRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="dl-kv" style={{ padding: '10px 0' }}>
      <span className="dl-kv-label">{label}</span>
      <span className="dl-kv-value">{children}</span>
    </div>
  );
}

/* ─── Empty state within a section ───────────────────────── */

function InlineEmpty({ message }: { message: string }) {
  return <div className="dl-empty">{message}</div>;
}

/* ═════════════════ Estimated monthly bill ═════════════════ */

/** One product line on the estimate. Discriminates on `product` to render
 *  either a `qty × unit_price` line (rcf/voicemail) or a subtotal with a
 *  named component breakdown (trunk/api). */
function BillLineRow({ item }: { item: BillingLineItem }) {
  const hasBreakdown = item.product === 'trunk' || item.product === 'api';

  return (
    <div
      className="dl-item"
      style={{ display: 'flex', flexDirection: 'column', gap: hasBreakdown ? 10 : 4 }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 16,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '0.84rem', fontWeight: 700, color: INK }}>
            {item.label}
          </div>
          {(item.product === 'rcf' || item.product === 'voicemail') && (
            <div style={{ fontSize: '0.72rem', color: INK_DIM, marginTop: 2 }}>
              {item.qty.toLocaleString()} {item.unit}
              {item.qty === 1 ? '' : 's'} × {fmtMoney(item.unit_price)}
            </div>
          )}
        </div>
        <div
          style={{
            fontSize: '0.9rem',
            fontWeight: 700,
            color: INK,
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}
        >
          {fmtMoney(item.subtotal)}
        </div>
      </div>

      {/* Component breakdown for trunk / api lines */}
      {hasBreakdown && item.components.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 5,
            paddingTop: 8,
            borderTop: '1px solid var(--rcf-line)',
          }}
        >
          {item.components.map((c, i) => (
            <div
              key={`${c.label}-${i}`}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 12,
                fontSize: '0.74rem',
              }}
            >
              <span style={{ color: INK_SOFT }}>{c.label}</span>
              <span
                style={{
                  color: INK_SOFT,
                  fontVariantNumeric: 'tabular-nums',
                  whiteSpace: 'nowrap',
                }}
              >
                {fmtMoney(c.amount)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * READ-ONLY "Estimated monthly bill" card.
 *
 * The platform does not invoice — CDRs are rated externally (Equinox). This
 * card fetches the server-computed estimate and lists each product line, a
 * bold monthly total, and the server-authored disclaimer. Handles its own
 * loading / empty / error states so it degrades gracefully.
 */
function MonthlyBillCard() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['my-billing'],
    queryFn: getMyBilling,
    retry: false,
  });

  return (
    <Section
      title="Estimated Monthly Bill"
      subtitle="A read-only estimate — actual charges are billed separately"
      icon={<Receipt size={16} strokeWidth={1.8} />}
    >
      {isLoading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
          <Spinner size="lg" />
        </div>
      ) : isError ? (
        <InlineEmpty message="Unable to load your estimated bill right now." />
      ) : !data || data.line_items.length === 0 ? (
        <InlineEmpty message="No billable products are provisioned yet. Contact support to get started." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Line items */}
          {data.line_items.map((item, i) => (
            <BillLineRow key={`${item.product}-${item.label}-${i}`} item={item} />
          ))}

          {/* Monthly total */}
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 16,
              padding: '15px 16px',
              borderRadius: 10,
              background: 'rgba(47, 125, 246, 0.07)',
              border: '1px solid rgba(47, 125, 246, 0.22)',
            }}
          >
            <span
              style={{
                fontSize: '0.66rem',
                fontWeight: 700,
                color: AZURE_DEEP,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              Estimated Monthly Total
            </span>
            <span
              style={{
                fontFamily: ARCHIVO,
                fontSize: '1.4rem',
                fontWeight: 700,
                color: INK,
                lineHeight: 1,
                fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap',
                letterSpacing: '-0.01em',
              }}
            >
              {fmtMoney(data.total_monthly_estimate)}
            </span>
          </div>

          {/* Server-authored disclaimer — shown verbatim */}
          {data.disclaimer && (
            <p
              style={{
                margin: '2px 2px 0',
                fontSize: '0.7rem',
                color: INK_DIM,
                lineHeight: 1.5,
              }}
            >
              {data.disclaimer}
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

/* ═════════════════ 1. Account Overview tab ═════════════════ */

function OverviewTab({ customer }: { customer: MyCustomer }) {
  return (
    <div className="dl-stack">
      {/* Identity + estimated bill side by side on wide screens */}
      <div className="dl-grid2">
        {/* Identity card */}
        <Section title="Account" subtitle="Your organization on the platform" icon={<IdCard size={16} strokeWidth={1.8} />}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
            <div className="dl-avatar" aria-hidden="true" style={{ width: 50, height: 50 }}>
              {customer.name.charAt(0) || '?'}
            </div>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontFamily: ARCHIVO,
                  fontSize: '1.05rem',
                  fontWeight: 700,
                  color: INK,
                  letterSpacing: '-0.015em',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {customer.name}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                <span className="dl-tag">{customer.account_type}</span>
                <StatusChip status={customer.status} />
              </div>
            </div>
          </div>

          <div>
            <DefRow label="Account type">{accountTypeLabel(customer.account_type)}</DefRow>
            <DefRow label="Traffic grade">
              <span className="dl-tag dl-tag-slate">{customer.traffic_grade}</span>
            </DefRow>
            <DefRow label="Member since">{fmtDate(customer.created_at)}</DefRow>
            <DefRow label="Account ID">
              <span style={{ fontFamily: MONO, fontSize: '0.78rem', color: INK_SOFT }}>
                #{customer.id}
              </span>
            </DefRow>
            {customer.ucaas_enabled && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '11px 0 0',
                }}
              >
                <Sparkles size={14} style={{ color: AZURE_DEEP, flexShrink: 0 }} />
                <span style={{ fontSize: '0.78rem', color: INK_SOFT }}>
                  UCaaS features enabled
                </span>
              </div>
            )}
          </div>
        </Section>

        {/* Estimated monthly bill — replaces the old balance/credit block */}
        <MonthlyBillCard />
      </div>

      {/* Product counts */}
      <Section title="Your Numbers" subtitle="Provisioned across all products" icon={<Boxes size={16} strokeWidth={1.8} />}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 14,
          }}
        >
          <Tile label="RCF numbers" value={customer.counts.rcf} hint="Remote Call Forwarding" />
          <Tile label="SIP trunks" value={customer.counts.trunks} hint="SIP Trunking" />
          <Tile label="API DIDs" value={customer.counts.api_dids} hint="Programmable Voice" />
        </div>
      </Section>
    </div>
  );
}

/* ═════════════════ 2. Users & Access tab ═════════════════ */

function TeamTab() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['my-team'],
    queryFn: listMyTeam,
  });

  const members: TeamMember[] = data ?? [];

  return (
    <Section
      title="Users &amp; Access"
      subtitle="User accounts associated with your organization"
      icon={<Users size={16} strokeWidth={1.8} />}
      flush={!isLoading && !isError && members.length > 0}
    >
      {isLoading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
          <Spinner size="lg" />
        </div>
      ) : isError ? (
        <InlineEmpty message="Unable to load team members right now." />
      ) : members.length === 0 ? (
        <InlineEmpty message="No user accounts are associated with this account yet." />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
            <thead>
              <tr>
                {['User', 'Email', 'Role', 'Status', 'Last login'].map((h) => (
                  <th key={h} className="dl-th">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} className="dl-row">
                  <td style={{ padding: '12px 16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span className="dl-avatar dl-avatar-sm" aria-hidden="true">
                        {(m.name || m.email).charAt(0)}
                      </span>
                      <span
                        style={{
                          fontSize: '0.84rem',
                          fontWeight: 600,
                          color: INK,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 7,
                        }}
                      >
                        {m.name || '—'}
                        {m.is_self && (
                          <span className="dl-tag" style={{ fontSize: '0.55rem', padding: '1px 6px' }}>
                            You
                          </span>
                        )}
                      </span>
                    </div>
                  </td>
                  <td
                    style={{
                      padding: '12px 16px',
                      fontSize: '0.78rem',
                      color: INK_SOFT,
                      fontFamily: MONO,
                    }}
                  >
                    {m.email}
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <span className={m.role === 'admin' ? 'dl-tag' : 'dl-tag dl-tag-slate'}>
                      {ROLE_LABEL[m.role]}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <StatusChip status={m.status} />
                  </td>
                  <td
                    style={{
                      padding: '12px 16px',
                      fontSize: '0.76rem',
                      color: INK_DIM,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {fmtDateTime(m.last_login)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

/* ═════════════════ 3. Products & Services tab ═════════════════ */

function ProductRow({ children }: { children: ReactNode }) {
  return (
    <div
      className="dl-item"
      style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}
    >
      {children}
    </div>
  );
}

/** Small uppercase field caption used inside product rows. */
function RowCaption({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: '0.6rem',
        fontWeight: 700,
        color: INK_DIM,
        textTransform: 'uppercase',
        letterSpacing: '0.07em',
        marginBottom: 3,
      }}
    >
      {children}
    </div>
  );
}

function RcfProductSection() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['my-account-rcf'],
    // No customer_id → backend scopes to the logged-in customer.
    queryFn: () => listRcf(),
  });

  const rows = data?.items ?? [];

  return (
    <Section
      title="Remote Call Forwarding"
      subtitle="Numbers that forward inbound calls to your destinations"
      icon={<PhoneForwarded size={16} strokeWidth={1.8} />}
      actions={<span className="dl-count">{rows.length} number{rows.length === 1 ? '' : 's'}</span>}
    >
      {isLoading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
          <Spinner size="lg" />
        </div>
      ) : isError ? (
        <InlineEmpty message="Unable to load RCF numbers." />
      ) : rows.length === 0 ? (
        <InlineEmpty message="No RCF numbers are provisioned yet. Contact support to add numbers." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map((r) => (
            <ProductRow key={r.id}>
              <div style={{ minWidth: 160, flex: '1 1 160px' }}>
                <div
                  style={{
                    fontSize: '0.88rem',
                    fontWeight: 700,
                    color: INK,
                    fontFamily: MONO,
                    letterSpacing: '0.02em',
                  }}
                >
                  {fmt(r.did)}
                </div>
                <div style={{ fontSize: '0.72rem', color: INK_DIM, marginTop: 2 }}>
                  {r.name ?? 'No label'}
                </div>
              </div>

              <div style={{ minWidth: 150, flex: '1 1 150px' }}>
                <RowCaption>Forwards to</RowCaption>
                <div style={{ fontSize: '0.82rem', color: AZURE_DEEP, fontFamily: MONO, fontWeight: 600 }}>
                  {fmt(r.forward_to)}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: '0.74rem', color: INK_SOFT }}>
                <span>
                  <span style={{ color: INK_DIM }}>Caller ID:</span>{' '}
                  {r.pass_caller_id ? 'Pass-through' : 'Show DID'}
                </span>
                <span>
                  <span style={{ color: INK_DIM }}>Channels:</span> {r.max_channels}
                </span>
                <span>
                  <span style={{ color: INK_DIM }}>Ring:</span> {r.ring_timeout}s
                </span>
              </div>

              <div style={{ marginLeft: 'auto' }}>
                <EnabledPill enabled={r.enabled} />
              </div>
            </ProductRow>
          ))}
        </div>
      )}
    </Section>
  );
}

function TrunkProductSection() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['my-account-trunks'],
    queryFn: () => listTrunks(),
  });

  const rows = data?.items ?? [];

  return (
    <Section
      title="SIP Trunks"
      subtitle="IP-authenticated SIP trunks for your PBX"
      icon={<Server size={16} strokeWidth={1.8} />}
      actions={<span className="dl-count">{rows.length} trunk{rows.length === 1 ? '' : 's'}</span>}
    >
      {isLoading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
          <Spinner size="lg" />
        </div>
      ) : isError ? (
        <InlineEmpty message="Unable to load SIP trunks." />
      ) : rows.length === 0 ? (
        <InlineEmpty message="No SIP trunks are provisioned yet. Contact support to add a trunk." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map((t) => (
            <ProductRow key={t.id}>
              <div style={{ minWidth: 160, flex: '1 1 160px' }}>
                <div style={{ fontSize: '0.86rem', fontWeight: 700, color: INK }}>
                  {t.trunk_name}
                </div>
                {t.package_name && (
                  <div style={{ fontSize: '0.72rem', color: INK_DIM, marginTop: 2 }}>
                    {t.package_name}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: '0.74rem', color: INK_SOFT }}>
                <span>
                  <span style={{ color: INK_DIM }}>Auth:</span> {t.auth_type}
                </span>
                <span>
                  <span style={{ color: INK_DIM }}>Auth IPs:</span> {t.ip_count ?? 0}
                </span>
                <span>
                  <span style={{ color: INK_DIM }}>DIDs:</span> {t.did_count ?? 0}
                </span>
                <span>
                  <span style={{ color: INK_DIM }}>Channels:</span> {t.max_channels}
                </span>
                <span>
                  <span style={{ color: INK_DIM }}>CPS:</span> {t.cps_limit}
                </span>
              </div>

              <div style={{ marginLeft: 'auto' }}>
                <EnabledPill enabled={t.enabled} />
              </div>
            </ProductRow>
          ))}
        </div>
      )}
    </Section>
  );
}

function ApiDidProductSection() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['my-account-api-dids'],
    queryFn: () => listApiDids(),
  });

  const rows = data?.items ?? [];

  return (
    <Section
      title="API DIDs"
      subtitle="Programmable voice numbers routed to your webhooks"
      icon={<Code2 size={16} strokeWidth={1.8} />}
      actions={<span className="dl-count">{rows.length} DID{rows.length === 1 ? '' : 's'}</span>}
    >
      {isLoading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
          <Spinner size="lg" />
        </div>
      ) : isError ? (
        <InlineEmpty message="Unable to load API DIDs." />
      ) : rows.length === 0 ? (
        <InlineEmpty message="No API DIDs are provisioned yet. Contact support to add a number." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map((d) => (
            <ProductRow key={d.id}>
              <div style={{ minWidth: 150, flex: '0 1 auto' }}>
                <div style={{ fontSize: '0.86rem', fontWeight: 700, color: INK, fontFamily: MONO }}>
                  {fmt(d.did)}
                </div>
              </div>

              <div style={{ minWidth: 200, flex: '1 1 200px' }}>
                <RowCaption>Voice webhook</RowCaption>
                <div
                  style={{
                    fontSize: '0.76rem',
                    color: AZURE_DEEP,
                    fontFamily: MONO,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={d.voice_url}
                >
                  {d.voice_url}
                </div>
              </div>

              <div style={{ marginLeft: 'auto' }}>
                <EnabledPill enabled={d.enabled} />
              </div>
            </ProductRow>
          ))}
        </div>
      )}
    </Section>
  );
}

function UcaasProductSection() {
  return (
    <Section
      title="UCaaS"
      subtitle="Unified communications features are enabled for your account"
      icon={<Sparkles size={16} strokeWidth={1.8} />}
      actions={<span className="dl-tag">Enabled</span>}
    >
      <div className="dl-note" style={{ alignItems: 'center', padding: '14px 16px', fontSize: '0.8rem' }}>
        <Sparkles size={17} style={{ color: AZURE_DEEP, flexShrink: 0 }} />
        <span>
          Extensions and voicemail are available on your account. Your administrator
          can configure UCaaS features — contact support for details.
        </span>
      </div>
    </Section>
  );
}

function ProductsTab({ customer }: { customer: MyCustomer }) {
  const type = customer.account_type;
  const showRcf = type === 'rcf' || type === 'hybrid';
  const showTrunk = type === 'trunk' || type === 'hybrid';
  const showApi = type === 'api' || type === 'hybrid';
  // RCF customers must NEVER see UCaaS — gate strictly on the flag and never for rcf.
  const showUcaas = customer.ucaas_enabled === true && type !== 'rcf';

  return (
    <div className="dl-stack">
      {showRcf && <RcfProductSection />}
      {showTrunk && <TrunkProductSection />}
      {showApi && <ApiDidProductSection />}
      {showUcaas && <UcaasProductSection />}
      {!showRcf && !showTrunk && !showApi && !showUcaas && (
        <Section title="Products" subtitle="No products configured" icon={<Boxes size={16} strokeWidth={1.8} />}>
          <InlineEmpty message="No products are configured for your account. Contact support to get started." />
        </Section>
      )}
    </div>
  );
}

/* ═════════════════ 4. Your Account tab ═════════════════ */

function ProfileInput({
  id,
  type = 'text',
  value,
  onChange,
  placeholder,
  autoComplete,
  disabled,
}: {
  id: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
  disabled?: boolean;
}) {
  return (
    <input
      id={id}
      className="dl-input"
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoComplete={autoComplete}
      disabled={disabled}
      style={{ width: '100%' }}
    />
  );
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="dl-flabel" style={{ marginBottom: 0 }}>
      {children}
    </label>
  );
}

function StatusBanner({ type, message }: { type: 'success' | 'error'; message: string }) {
  return (
    <div role="status" className={type === 'success' ? 'dl-banner dl-banner-ok' : 'dl-banner dl-banner-err'}>
      {message}
    </div>
  );
}

function SubmitButton({ saving, label }: { saving: boolean; label: string }) {
  return (
    <button type="submit" className="dl-btn dl-btn-primary" disabled={saving}>
      {saving ? 'Saving…' : label}
    </button>
  );
}

/** Identity facts + edit display name — the retired standalone /account page's
 *  Profile card, merged here: read-only Email / Role / Customer / Last Login
 *  grid plus the exact PUT /auth/me display-name form. */
function ProfileCard({ user, onRefresh }: { user: User; onRefresh: () => Promise<void> }) {
  const [name, setName] = useState(user.name ?? '');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const handleSave = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const trimmed = name.trim();
      if (!trimmed) {
        setStatus({ type: 'error', message: 'Name cannot be empty.' });
        return;
      }
      setSaving(true);
      setStatus(null);
      try {
        await apiRequest<User>('PUT', '/auth/me', { name: trimmed } satisfies UpdateMeBody);
        await onRefresh();
        setStatus({ type: 'success', message: 'Display name updated.' });
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'Failed to save. Please try again.';
        setStatus({ type: 'error', message });
      } finally {
        setSaving(false);
      }
    },
    [name, onRefresh],
  );

  return (
    <Section title="Profile" subtitle="Your identity on the platform" icon={<IdCard size={16} strokeWidth={1.8} />}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px 20px', marginBottom: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <FieldLabel htmlFor="my-email">Email</FieldLabel>
          <div
            className="dl-ro"
            style={{ userSelect: 'all', fontFamily: MONO, fontSize: '0.8rem' }}
            id="my-email"
          >
            {user.email}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <FieldLabel htmlFor="my-role">Role</FieldLabel>
          <div className="dl-ro" id="my-role">
            {ROLE_LABEL[user.role]}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <FieldLabel htmlFor="my-customer">Customer</FieldLabel>
          <div className="dl-ro" id="my-customer">
            {user.customer_name ?? 'None'}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <FieldLabel htmlFor="my-last-login">Last Login</FieldLabel>
          <div className="dl-ro" id="my-last-login">
            {fmtDateTime(user.last_login)}
          </div>
        </div>
      </div>

      <div style={{ height: 1, background: 'var(--rcf-line)', marginBottom: 20 }} />

      <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 420 }}>
          <FieldLabel htmlFor="my-name">Display name</FieldLabel>
          <ProfileInput
            id="my-name"
            value={name}
            onChange={setName}
            placeholder="Your display name"
            autoComplete="name"
            disabled={saving}
          />
        </div>
        {status && <StatusBanner type={status.type} message={status.message} />}
        <div style={{ display: 'flex' }}>
          <SubmitButton saving={saving} label="Save Name" />
        </div>
      </form>
    </Section>
  );
}

/** Change password — the exact PUT /auth/me call + validation from the retired /account page. */
function PasswordCard({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const validate = useCallback((): string | null => {
    if (!currentPassword) return 'Current password is required.';
    if (newPassword.length < 8) return 'New password must be at least 8 characters.';
    if (newPassword !== confirmPassword) return 'Passwords do not match.';
    return null;
  }, [currentPassword, newPassword, confirmPassword]);

  const handleSave = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const validationError = validate();
      if (validationError) {
        setStatus({ type: 'error', message: validationError });
        return;
      }
      setSaving(true);
      setStatus(null);
      try {
        await apiRequest<User>('PUT', '/auth/me', {
          current_password: currentPassword,
          new_password: newPassword,
        } satisfies UpdateMeBody);
        await onRefresh();
        setStatus({ type: 'success', message: 'Password changed successfully.' });
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'Failed to change password. Please try again.';
        setStatus({ type: 'error', message });
      } finally {
        setSaving(false);
      }
    },
    [currentPassword, newPassword, confirmPassword, validate, onRefresh],
  );

  return (
    <Section title="Change Password" subtitle="Keep your sign-in secure" icon={<ShieldCheck size={16} strokeWidth={1.8} />}>
      <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 420 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <FieldLabel htmlFor="cur-pw">Current password</FieldLabel>
          <ProfileInput
            id="cur-pw"
            type="password"
            value={currentPassword}
            onChange={setCurrentPassword}
            placeholder="Your current password"
            autoComplete="current-password"
            disabled={saving}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <FieldLabel htmlFor="new-pw">New password</FieldLabel>
          <ProfileInput
            id="new-pw"
            type="password"
            value={newPassword}
            onChange={setNewPassword}
            placeholder="At least 8 characters"
            autoComplete="new-password"
            disabled={saving}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <FieldLabel htmlFor="confirm-pw">Confirm new password</FieldLabel>
          <ProfileInput
            id="confirm-pw"
            type="password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            placeholder="Repeat new password"
            autoComplete="new-password"
            disabled={saving}
          />
        </div>
        {status && <StatusBanner type={status.type} message={status.message} />}
        <div style={{ display: 'flex' }}>
          <SubmitButton saving={saving} label="Change Password" />
        </div>
      </form>
    </Section>
  );
}

function SecurityTab({ user, onRefresh }: { user: User; onRefresh: () => Promise<void> }) {
  return (
    <div className="dl-stack">
      <ProfileCard user={user} onRefresh={onRefresh} />
      <PasswordCard onRefresh={onRefresh} />
    </div>
  );
}

/* ═════════════════ Tab bar ═════════════════ */

type Tab = 'overview' | 'team' | 'products' | 'security';

interface TabDef {
  id: Tab;
  label: string;
  icon: ReactNode;
}

function AccountTabBar({ active, onChange, tabs }: { active: Tab; onChange: (t: Tab) => void; tabs: TabDef[] }) {
  return (
    <div className="dl-tabs fx-load fx-load-d1" role="tablist">
      {tabs.map((t) => {
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.id)}
            className={isActive ? 'dl-tab dl-tab-active' : 'dl-tab'}
          >
            <span
              style={{
                display: 'inline-flex',
                color: isActive ? 'var(--rcf-azure-deep)' : 'inherit',
                transition: 'color 0.15s ease',
              }}
            >
              {t.icon}
            </span>
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/* ═════════════════ Quiet page header ═════════════════ */

function MyAccountHeader({ customer, loaded }: { customer: MyCustomer | undefined; loaded: boolean }) {
  const counts = customer?.counts;
  const metrics: { value: number; label: string }[] = [];
  if (counts) {
    if (counts.rcf > 0) metrics.push({ value: counts.rcf, label: 'RCF Numbers' });
    if (counts.trunks > 0) metrics.push({ value: counts.trunks, label: 'SIP Trunks' });
    if (counts.api_dids > 0) metrics.push({ value: counts.api_dids, label: 'API DIDs' });
  }

  return (
    <header className="dl-header fx-load">
      <div className="dl-header-id">
        <div className="dl-crumb">
          <span>My Account</span>
          <span className="dl-crumb-sep" aria-hidden="true">/</span>
          <span>Granite CRAG</span>
        </div>
        <h1 className="dl-title">{customer ? customer.name : 'My Account'}</h1>
        <p className="dl-sub">Your organization, users, products, and sign-in security in one place.</p>
      </div>

      {loaded && metrics.length > 0 && (
        <div className="dl-metrics">
          {metrics.map((m) => (
            <div className="dl-metric" key={m.label}>
              <div className="dl-metric-value">{m.value.toLocaleString()}</div>
              <div className="dl-metric-label">{m.label}</div>
            </div>
          ))}
        </div>
      )}
    </header>
  );
}

/* ═════════════════ Page ═════════════════ */

export function MyAccountPage() {
  // ── ALL hooks unconditionally at the top — React #310 guard ──
  const { user, refreshUser } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>('overview');

  const {
    data: customer,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['my-customer'],
    queryFn: getMyCustomer,
    retry: false,
  });

  const tabs = useMemo<TabDef[]>(
    () => [
      { id: 'overview', label: 'Overview', icon: <IdCard size={15} strokeWidth={1.8} /> },
      { id: 'team', label: 'Users & Access', icon: <Users size={15} strokeWidth={1.8} /> },
      { id: 'products', label: 'Products', icon: <Boxes size={15} strokeWidth={1.8} /> },
      { id: 'security', label: 'Your Account', icon: <ShieldCheck size={15} strokeWidth={1.8} /> },
    ],
    [],
  );

  // ── Early returns only after all hooks ──
  if (!user) return null;

  const noCustomer = isError && error instanceof ApiError && error.status === 404;

  return (
    <div className="dl-scope">
      <div className="dl-shell">
        <MyAccountHeader customer={customer} loaded={!isLoading} />

        {isLoading ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 14,
              padding: '80px 24px',
              color: INK_DIM,
            }}
          >
            <Spinner size="lg" />
            <span style={{ fontSize: '0.85rem' }}>Loading your account…</span>
          </div>
        ) : (
          <>
            <AccountTabBar active={activeTab} onChange={setActiveTab} tabs={tabs} />

            <div className="fx-load fx-load-d2">
              {/* Overview / Team / Products depend on the customer record. */}
              {activeTab === 'overview' &&
                (customer ? (
                  <OverviewTab customer={customer} />
                ) : (
                  <NoCustomerNotice noCustomer={noCustomer} />
                ))}

              {activeTab === 'team' && <TeamTab />}

              {activeTab === 'products' &&
                (customer ? (
                  <ProductsTab customer={customer} />
                ) : (
                  <NoCustomerNotice noCustomer={noCustomer} />
                ))}

              {activeTab === 'security' && <SecurityTab user={user} onRefresh={refreshUser} />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Friendly notice when the caller has no customer record (404) or the load failed. */
function NoCustomerNotice({ noCustomer }: { noCustomer: boolean }) {
  return (
    <Section
      title={noCustomer ? 'No customer account' : 'Unable to load account'}
      subtitle={noCustomer ? 'Your login is not associated with a customer' : 'Please try again shortly'}
      icon={<AlertTriangle size={16} strokeWidth={1.8} />}
    >
      <div
        className="dl-banner dl-banner-warn"
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px' }}
      >
        <AlertTriangle size={18} style={{ flexShrink: 0 }} />
        <span>
          {noCustomer
            ? 'This account is not linked to a customer. You can still manage your profile and password under Your Account.'
            : 'We could not load your account details right now. Your profile and password are still available under Your Account.'}
        </span>
      </div>
    </Section>
  );
}
