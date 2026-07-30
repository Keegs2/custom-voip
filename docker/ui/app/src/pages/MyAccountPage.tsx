import {
  useState,
  useMemo,
  useCallback,
  type FormEvent,
  type CSSProperties,
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
import { Badge } from '../components/ui/Badge';
import { Spinner } from '../components/ui/Spinner';
import { fmt, fmtMoney } from '../utils/format';

/* ─── Design tokens ──────────────────────────────────────── */

const COLORS = {
  bg: '#0f1117',
  text: '#e2e8f0',
  secondary: '#94a3b8',
  muted: '#475569',
  faint: '#334155',
  border: 'rgba(42,47,69,0.6)',
  primary: '#3b82f6',
  primaryLight: '#60a5fa',
  success: '#22c55e',
  successLight: '#4ade80',
  warning: '#f59e0b',
  error: '#f87171',
} as const;

const MONO =
  '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';

/* ─── Shared body for the update-me PUT (mirrors AccountPage) ── */

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

/* ─── Section shell — a titled glass surface ─────────────── */

interface SectionProps {
  title: string;
  subtitle?: string;
  icon: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

function Section({ title, subtitle, icon, actions, children }: SectionProps) {
  return (
    <section
      className="glass-surface"
      style={{ borderRadius: 18, padding: '24px 28px', overflow: 'hidden' }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 22,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <span
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: COLORS.primaryLight,
              background:
                'linear-gradient(135deg, rgba(59,130,246,0.16) 0%, rgba(59,130,246,0.07) 100%)',
              border: '1px solid rgba(59,130,246,0.24)',
            }}
          >
            {icon}
          </span>
          <div style={{ minWidth: 0 }}>
            <h2
              style={{
                margin: 0,
                fontSize: '0.98rem',
                fontWeight: 700,
                color: COLORS.text,
                letterSpacing: '-0.01em',
                lineHeight: 1.2,
              }}
            >
              {title}
            </h2>
            {subtitle && (
              <p
                style={{
                  margin: '3px 0 0',
                  fontSize: '0.78rem',
                  color: COLORS.muted,
                  lineHeight: 1.4,
                }}
              >
                {subtitle}
              </p>
            )}
          </div>
        </div>
        {actions && <div style={{ flexShrink: 0 }}>{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/* ─── Glass metric tile ──────────────────────────────────── */

interface TileProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  accent?: string;
}

function Tile({ label, value, hint, accent = COLORS.primary }: TileProps) {
  return (
    <div
      className="glass-surface"
      style={{
        padding: '16px 18px',
        borderRadius: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: 0,
      }}
    >
      <span
        style={{
          fontSize: '0.62rem',
          fontWeight: 600,
          color: COLORS.muted,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: '1.35rem',
          fontWeight: 800,
          color: COLORS.text,
          lineHeight: 1.1,
          fontVariantNumeric: 'tabular-nums',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value}
      </span>
      {hint && (
        <span style={{ fontSize: '0.7rem', color: accent, fontWeight: 500 }}>
          {hint}
        </span>
      )}
    </div>
  );
}

/* ─── Definition row (key → value) ───────────────────────── */

function DefRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '11px 0',
        borderBottom: `1px solid ${COLORS.border}`,
      }}
    >
      <span style={{ fontSize: '0.78rem', color: COLORS.muted, fontWeight: 500 }}>
        {label}
      </span>
      <span
        style={{
          fontSize: '0.82rem',
          color: COLORS.text,
          fontWeight: 600,
          textAlign: 'right',
          minWidth: 0,
        }}
      >
        {children}
      </span>
    </div>
  );
}

/* ─── Empty state within a section ───────────────────────── */

function InlineEmpty({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: '28px 20px',
        textAlign: 'center',
        borderRadius: 12,
        border: '1px dashed rgba(59,130,246,0.14)',
        background: 'rgba(59,130,246,0.02)',
        color: COLORS.muted,
        fontSize: '0.82rem',
      }}
    >
      {message}
    </div>
  );
}

/* ─── Status → badge variant maps ────────────────────────── */

function statusVariant(status: string): 'active' | 'suspended' | 'closed' | 'disabled' {
  switch (status) {
    case 'active': return 'active';
    case 'suspended': return 'suspended';
    case 'closed': return 'closed';
    default: return 'disabled';
  }
}

function roleVariant(role: TeamRole): 'premium' | 'standard' {
  return role === 'admin' ? 'premium' : 'standard';
}

/* ═════════════════ Estimated monthly bill ═════════════════ */

/** One product line on the estimate. Discriminates on `product` to render
 *  either a `qty × unit_price` line (rcf/voicemail) or a subtotal with a
 *  named component breakdown (trunk/api). */
function BillLineRow({ item }: { item: BillingLineItem }) {
  const hasBreakdown = item.product === 'trunk' || item.product === 'api';

  return (
    <div
      className="glass-surface"
      style={{
        padding: '14px 18px',
        borderRadius: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: hasBreakdown ? 10 : 4,
      }}
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
          <div style={{ fontSize: '0.88rem', fontWeight: 700, color: COLORS.text }}>
            {item.label}
          </div>
          {(item.product === 'rcf' || item.product === 'voicemail') && (
            <div style={{ fontSize: '0.74rem', color: COLORS.muted, marginTop: 2 }}>
              {item.qty.toLocaleString()} {item.unit}
              {item.qty === 1 ? '' : 's'} × {fmtMoney(item.unit_price)}
            </div>
          )}
        </div>
        <div
          style={{
            fontSize: '0.95rem',
            fontWeight: 700,
            color: COLORS.text,
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
            borderTop: '1px solid rgba(59,130,246,0.10)',
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
                fontSize: '0.76rem',
              }}
            >
              <span style={{ color: COLORS.secondary }}>{c.label}</span>
              <span
                style={{
                  color: COLORS.secondary,
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
      icon={<Receipt size={18} strokeWidth={1.7} />}
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
              padding: '16px 18px',
              borderRadius: 12,
              background:
                'linear-gradient(135deg, rgba(59,130,246,0.14) 0%, rgba(59,130,246,0.06) 100%)',
              border: '1px solid rgba(59,130,246,0.24)',
            }}
          >
            <span
              style={{
                fontSize: '0.72rem',
                fontWeight: 700,
                color: COLORS.primaryLight,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              Estimated Monthly Total
            </span>
            <span
              style={{
                fontSize: '1.55rem',
                fontWeight: 800,
                color: COLORS.text,
                lineHeight: 1,
                fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap',
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
                fontSize: '0.72rem',
                color: COLORS.muted,
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Identity + estimated bill side by side on wide screens */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
          gap: 20,
        }}
      >
        {/* Identity card */}
        <Section title="Account" subtitle="Your organization on the platform" icon={<IdCard size={18} strokeWidth={1.7} />}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 }}>
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: 14,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '1.3rem',
                fontWeight: 800,
                color: COLORS.primaryLight,
                textTransform: 'uppercase',
                background:
                  'linear-gradient(135deg, rgba(59,130,246,0.22) 0%, rgba(59,130,246,0.10) 100%)',
                border: '1px solid rgba(59,130,246,0.30)',
                boxShadow: '0 0 20px rgba(59,130,246,0.14)',
              }}
              aria-hidden="true"
            >
              {customer.name.charAt(0) || '?'}
            </div>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: '1.15rem',
                  fontWeight: 800,
                  color: COLORS.text,
                  letterSpacing: '-0.02em',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {customer.name}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                <Badge variant={customer.account_type}>{customer.account_type}</Badge>
                <Badge variant={statusVariant(customer.status)}>{customer.status}</Badge>
              </div>
            </div>
          </div>

          <div>
            <DefRow label="Account type">{accountTypeLabel(customer.account_type)}</DefRow>
            <DefRow label="Traffic grade">
              <Badge variant={customer.traffic_grade}>{customer.traffic_grade}</Badge>
            </DefRow>
            <DefRow label="Member since">{fmtDate(customer.created_at)}</DefRow>
            <DefRow label="Account ID">
              <span style={{ fontFamily: MONO, fontSize: '0.78rem', color: COLORS.secondary }}>
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
                <Sparkles size={14} style={{ color: COLORS.primaryLight, flexShrink: 0 }} />
                <span style={{ fontSize: '0.78rem', color: COLORS.secondary }}>
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
      <Section title="Your Numbers" subtitle="Provisioned across all products" icon={<Boxes size={18} strokeWidth={1.7} />}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 14,
          }}
        >
          <Tile label="RCF numbers" value={customer.counts.rcf} accent={COLORS.primaryLight} hint="Remote Call Forwarding" />
          <Tile label="SIP trunks" value={customer.counts.trunks} accent={COLORS.successLight} hint="SIP Trunking" />
          <Tile label="API DIDs" value={customer.counts.api_dids} accent={COLORS.primaryLight} hint="Programmable Voice" />
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
      icon={<Users size={18} strokeWidth={1.7} />}
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
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['User', 'Email', 'Role', 'Status', 'Last login'].map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: 'left',
                      padding: '10px 14px',
                      fontSize: '0.6rem',
                      fontWeight: 700,
                      color: COLORS.muted,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      whiteSpace: 'nowrap',
                      borderBottom: '1px solid rgba(59,130,246,0.12)',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} className="glass-row-hover">
                  <td style={{ padding: '13px 14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span
                        style={{
                          width: 30,
                          height: 30,
                          borderRadius: '50%',
                          flexShrink: 0,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '0.72rem',
                          fontWeight: 700,
                          color: COLORS.primaryLight,
                          textTransform: 'uppercase',
                          background:
                            'linear-gradient(135deg, rgba(59,130,246,0.28) 0%, rgba(59,130,246,0.14) 100%)',
                          border: '1px solid rgba(59,130,246,0.3)',
                        }}
                        aria-hidden="true"
                      >
                        {(m.name || m.email).charAt(0)}
                      </span>
                      <span
                        style={{
                          fontSize: '0.85rem',
                          fontWeight: 600,
                          color: COLORS.text,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 7,
                        }}
                      >
                        {m.name || '—'}
                        {m.is_self && (
                          <span
                            style={{
                              fontSize: '0.55rem',
                              fontWeight: 700,
                              letterSpacing: '0.06em',
                              textTransform: 'uppercase',
                              color: COLORS.primaryLight,
                              background: 'rgba(59,130,246,0.15)',
                              border: '1px solid rgba(59,130,246,0.3)',
                              borderRadius: 999,
                              padding: '2px 7px',
                              lineHeight: 1.4,
                            }}
                          >
                            You
                          </span>
                        )}
                      </span>
                    </div>
                  </td>
                  <td
                    style={{
                      padding: '13px 14px',
                      fontSize: '0.8rem',
                      color: COLORS.secondary,
                      fontFamily: MONO,
                    }}
                  >
                    {m.email}
                  </td>
                  <td style={{ padding: '13px 14px' }}>
                    <Badge variant={roleVariant(m.role)}>{ROLE_LABEL[m.role]}</Badge>
                  </td>
                  <td style={{ padding: '13px 14px' }}>
                    <Badge variant={statusVariant(m.status)}>{m.status}</Badge>
                  </td>
                  <td
                    style={{
                      padding: '13px 14px',
                      fontSize: '0.78rem',
                      color: COLORS.muted,
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

/** A compact status pill for product rows. */
function StatusPill({ enabled }: { enabled: boolean }) {
  return (
    <Badge variant={enabled ? 'active' : 'disabled'}>
      {enabled ? 'Active' : 'Disabled'}
    </Badge>
  );
}

function ProductRow({ children }: { children: ReactNode }) {
  return (
    <div
      className="glass-surface"
      style={{
        padding: '14px 18px',
        borderRadius: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        flexWrap: 'wrap',
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
      icon={<PhoneForwarded size={18} strokeWidth={1.7} />}
      actions={<Badge variant="rcf">{rows.length} number{rows.length === 1 ? '' : 's'}</Badge>}
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
                    fontSize: '0.92rem',
                    fontWeight: 700,
                    color: COLORS.text,
                    fontFamily: MONO,
                    letterSpacing: '0.02em',
                  }}
                >
                  {fmt(r.did)}
                </div>
                <div style={{ fontSize: '0.72rem', color: COLORS.muted, marginTop: 2 }}>
                  {r.name ?? 'No label'}
                </div>
              </div>

              <div style={{ minWidth: 150, flex: '1 1 150px' }}>
                <div style={{ fontSize: '0.62rem', color: COLORS.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>
                  Forwards to
                </div>
                <div style={{ fontSize: '0.84rem', color: COLORS.primaryLight, fontFamily: MONO, fontWeight: 600 }}>
                  {fmt(r.forward_to)}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: '0.75rem', color: COLORS.secondary }}>
                <span>
                  <span style={{ color: COLORS.muted }}>Caller ID:</span>{' '}
                  {r.pass_caller_id ? 'Pass-through' : 'Show DID'}
                </span>
                <span>
                  <span style={{ color: COLORS.muted }}>Channels:</span> {r.max_channels}
                </span>
                <span>
                  <span style={{ color: COLORS.muted }}>Ring:</span> {r.ring_timeout}s
                </span>
              </div>

              <div style={{ marginLeft: 'auto' }}>
                <StatusPill enabled={r.enabled} />
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
      icon={<Server size={18} strokeWidth={1.7} />}
      actions={<Badge variant="trunk">{rows.length} trunk{rows.length === 1 ? '' : 's'}</Badge>}
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
                <div style={{ fontSize: '0.9rem', fontWeight: 700, color: COLORS.text }}>
                  {t.trunk_name}
                </div>
                {t.package_name && (
                  <div style={{ fontSize: '0.72rem', color: COLORS.muted, marginTop: 2 }}>
                    {t.package_name}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: '0.75rem', color: COLORS.secondary }}>
                <span>
                  <span style={{ color: COLORS.muted }}>Auth:</span> {t.auth_type}
                </span>
                <span>
                  <span style={{ color: COLORS.muted }}>Auth IPs:</span> {t.ip_count ?? 0}
                </span>
                <span>
                  <span style={{ color: COLORS.muted }}>DIDs:</span> {t.did_count ?? 0}
                </span>
                <span>
                  <span style={{ color: COLORS.muted }}>Channels:</span> {t.max_channels}
                </span>
                <span>
                  <span style={{ color: COLORS.muted }}>CPS:</span> {t.cps_limit}
                </span>
              </div>

              <div style={{ marginLeft: 'auto' }}>
                <StatusPill enabled={t.enabled} />
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
      icon={<Code2 size={18} strokeWidth={1.7} />}
      actions={<Badge variant="api">{rows.length} DID{rows.length === 1 ? '' : 's'}</Badge>}
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
                <div style={{ fontSize: '0.9rem', fontWeight: 700, color: COLORS.text, fontFamily: MONO }}>
                  {fmt(d.did)}
                </div>
              </div>

              <div style={{ minWidth: 200, flex: '1 1 200px' }}>
                <div style={{ fontSize: '0.62rem', color: COLORS.muted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>
                  Voice webhook
                </div>
                <div
                  style={{
                    fontSize: '0.78rem',
                    color: COLORS.primaryLight,
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
                <StatusPill enabled={d.enabled} />
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
      icon={<Sparkles size={18} strokeWidth={1.7} />}
      actions={<Badge variant="ucaas">Enabled</Badge>}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '16px 18px',
          borderRadius: 12,
          background: 'rgba(59,130,246,0.04)',
          border: '1px solid rgba(59,130,246,0.14)',
          color: COLORS.secondary,
          fontSize: '0.82rem',
          lineHeight: 1.5,
        }}
      >
        <Sparkles size={18} style={{ color: COLORS.primaryLight, flexShrink: 0 }} />
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {showRcf && <RcfProductSection />}
      {showTrunk && <TrunkProductSection />}
      {showApi && <ApiDidProductSection />}
      {showUcaas && <UcaasProductSection />}
      {!showRcf && !showTrunk && !showApi && !showUcaas && (
        <Section title="Products" subtitle="No products configured" icon={<Boxes size={18} strokeWidth={1.7} />}>
          <InlineEmpty message="No products are configured for your account. Contact support to get started." />
        </Section>
      )}
    </div>
  );
}

/* ═════════════════ 4. Profile & Security tab ═════════════════ */

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
  const style: CSSProperties = {
    boxSizing: 'border-box',
    color: disabled ? COLORS.muted : COLORS.text,
    cursor: disabled ? 'not-allowed' : 'text',
    opacity: disabled ? 0.6 : 1,
  };
  return (
    <input
      id={id}
      className="form-control"
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoComplete={autoComplete}
      disabled={disabled}
      style={style}
    />
  );
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label
      htmlFor={htmlFor}
      style={{
        fontSize: '0.72rem',
        fontWeight: 600,
        color: COLORS.secondary,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </label>
  );
}

function StatusBanner({ type, message }: { type: 'success' | 'error'; message: string }) {
  const color = type === 'success' ? COLORS.success : COLORS.error;
  return (
    <div
      role="status"
      style={{
        padding: '10px 14px',
        borderRadius: 8,
        background: `${color}14`,
        border: `1px solid ${color}40`,
        color,
        fontSize: '0.8rem',
        fontWeight: 500,
      }}
    >
      {message}
    </div>
  );
}

function SubmitButton({ saving, label }: { saving: boolean; label: string }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="submit"
      disabled={saving}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '9px 22px',
        borderRadius: 8,
        background: hover && !saving ? '#2563eb' : COLORS.primary,
        border: 'none',
        color: '#fff',
        fontSize: '0.82rem',
        fontWeight: 600,
        cursor: saving ? 'not-allowed' : 'pointer',
        opacity: saving ? 0.65 : 1,
        transition: 'background 0.15s, opacity 0.15s',
      }}
    >
      {saving ? 'Saving…' : label}
    </button>
  );
}

/** Edit display name — reuses the exact PUT /auth/me call from AccountPage. */
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
    <Section title="Profile" subtitle="Your personal display details" icon={<IdCard size={18} strokeWidth={1.7} />}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px 20px', marginBottom: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <FieldLabel htmlFor="my-email">Email</FieldLabel>
          <div
            style={{
              padding: '9px 12px',
              borderRadius: 8,
              background: 'rgba(255,255,255,0.02)',
              border: `1px solid ${COLORS.border}`,
              fontSize: '0.85rem',
              color: COLORS.muted,
              userSelect: 'all',
              fontFamily: MONO,
            }}
            id="my-email"
          >
            {user.email}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <FieldLabel htmlFor="my-role">Role</FieldLabel>
          <div
            style={{
              padding: '9px 12px',
              borderRadius: 8,
              background: 'rgba(255,255,255,0.02)',
              border: `1px solid ${COLORS.border}`,
              fontSize: '0.85rem',
              color: COLORS.muted,
            }}
            id="my-role"
          >
            {ROLE_LABEL[user.role]}
          </div>
        </div>
      </div>

      <div style={{ height: 1, background: COLORS.border, marginBottom: 20 }} />

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

/** Change password — reuses the exact PUT /auth/me call + validation from AccountPage. */
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
    <Section title="Change Password" subtitle="Keep your sign-in secure" icon={<ShieldCheck size={18} strokeWidth={1.7} />}>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
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
    <div
      className="glass-surface"
      style={{ display: 'flex', gap: 4, borderRadius: 14, padding: 5, marginBottom: 24, flexWrap: 'wrap' }}
      role="tablist"
    >
      {tabs.map((t) => {
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.id)}
            style={{
              flex: '1 1 140px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: '10px 16px',
              borderRadius: 10,
              border: 'none',
              cursor: 'pointer',
              fontSize: '0.83rem',
              fontWeight: isActive ? 700 : 500,
              fontFamily: 'inherit',
              color: isActive ? COLORS.text : '#64748b',
              background: isActive
                ? 'linear-gradient(135deg, rgba(59,130,246,0.22) 0%, rgba(59,130,246,0.12) 100%)'
                : 'transparent',
              boxShadow: isActive ? '0 0 14px rgba(59,130,246,0.18), inset 0 1px 0 rgba(255,255,255,0.06)' : 'none',
              transition: 'all 0.18s ease',
              whiteSpace: 'nowrap',
            }}
          >
            <span style={{ color: isActive ? COLORS.primaryLight : '#475569', display: 'inline-flex' }}>
              {t.icon}
            </span>
            {t.label}
          </button>
        );
      })}
    </div>
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
      { id: 'security', label: 'Profile & Security', icon: <ShieldCheck size={15} strokeWidth={1.8} /> },
    ],
    [],
  );

  // ── Early returns only after all hooks ──
  if (!user) return null;

  const noCustomer = isError && error instanceof ApiError && error.status === 404;

  return (
    <div style={{ minHeight: '100%', background: COLORS.bg, padding: '32px 32px 56px', width: '100%' }}>
      {/* Header */}
      <div style={{ marginBottom: 26 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: COLORS.primaryLight,
              background: 'linear-gradient(135deg, rgba(59,130,246,0.18) 0%, rgba(59,130,246,0.08) 100%)',
              border: '1px solid rgba(59,130,246,0.28)',
              boxShadow: '0 0 20px rgba(59,130,246,0.16)',
            }}
          >
            <IdCard size={22} strokeWidth={1.7} />
          </span>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.55rem', fontWeight: 800, color: COLORS.text, letterSpacing: '-0.03em', lineHeight: 1.1 }}>
              My Account
            </h1>
            <p style={{ margin: '4px 0 0', fontSize: '0.85rem', color: COLORS.muted }}>
              {customer ? customer.name : 'Your account, team, products, and security'}
            </p>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: '80px 24px', color: COLORS.muted }}>
          <Spinner size="lg" />
          <span style={{ fontSize: '0.85rem' }}>Loading your account…</span>
        </div>
      ) : (
        <>
          <AccountTabBar active={activeTab} onChange={setActiveTab} tabs={tabs} />

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
        </>
      )}
    </div>
  );
}

/** Friendly notice when the caller has no customer record (404) or the load failed. */
function NoCustomerNotice({ noCustomer }: { noCustomer: boolean }) {
  return (
    <Section
      title={noCustomer ? 'No customer account' : 'Unable to load account'}
      subtitle={noCustomer ? 'Your login is not associated with a customer' : 'Please try again shortly'}
      icon={<AlertTriangle size={18} strokeWidth={1.7} />}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '16px 18px',
          borderRadius: 12,
          background: 'rgba(245,158,11,0.06)',
          border: '1px solid rgba(245,158,11,0.18)',
          color: COLORS.secondary,
          fontSize: '0.82rem',
          lineHeight: 1.5,
        }}
      >
        <AlertTriangle size={18} style={{ color: COLORS.warning, flexShrink: 0 }} />
        <span>
          {noCustomer
            ? 'This account is not linked to a customer. You can still manage your profile and password under Profile & Security.'
            : 'We could not load your account details right now. Your profile and password are still available under Profile & Security.'}
        </span>
      </div>
    </Section>
  );
}
