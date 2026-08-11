/**
 * CustomerAccountPage — the admin Customer 360 (/admin/customers/:customerId):
 * identity header, account tiles, per-product sections (rendered strictly by
 * account_type — rcf/hybrid → RCF, api/hybrid → API, trunk/hybrid → trunks,
 * ucaas or ucaas_enabled → UCaaS), the read-only estimated monthly bill,
 * usage & analytics (30-day chart + recent calls), the inline edit form, and
 * account actions (UCaaS add-on toggle, delete).
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` in index.css, plus the
 * admin-area `dlx-*` primitives in styles/dl-admin.css and the page-scoped
 * `dlx3-*` primitives in styles/dl-customer360.css). Renders INSIDE the
 * AdminPage shell, which owns the paper canvas (`dl-scope`) — this page
 * contributes only the back link, panels, and tables. Presentation only:
 * every query, mutation payload, confirm() and toast is unchanged.
 *
 * React #310: every hook in every component below is called unconditionally
 * at the top of its function, before any early return.
 */
import { useState, useId } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Activity, ChevronLeft, Receipt, Settings } from 'lucide-react';
import { getCustomer, deleteCustomer } from '../../api/customers';
import { getCustomerTier } from '../../api/tiers';
import { getCustomerBilling } from '../../api/account';
import { apiRequest } from '../../api/client';
import { getCustomerRecentCdrs, getCustomerCdrDailySummary } from '../../api/cdrs';
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/ToastContext';
import { fmtMoney } from '../../utils/format';
import { CustomerEditForm } from './CustomerEditForm';
import { CustomerRcfSection } from './CustomerRcfSection';
import { CustomerApiSection } from './CustomerApiSection';
import { CustomerTrunkSection } from './CustomerTrunkSection';
import { CustomerUcaasSection } from './CustomerUcaasSection';
import type { Customer, CustomerStatus } from '../../types/customer';
import type { Cdr } from '../../types/cdr';
import type { CdrSummaryRow } from '../../types/rate';
import '../../styles/dl-admin.css';
import '../../styles/dl-customer360.css';

// ─── Constants ───────────────────────────────────────────────────────────────

const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';
const ARCHIVO = '"Archivo", "IBM Plex Sans", sans-serif';

/** Daylight chart series — azure primary (matches the console accent). */
const CHART_AZURE = '#2f7df6';

// ─── Small daylight chips ─────────────────────────────────────────────────────

function StatusPill({ status }: { status: CustomerStatus }) {
  if (status === 'active') return <span className="dl-pill dl-pill-on">Active</span>;
  if (status === 'suspended') return <span className="dl-pill dl-pill-off">Suspended</span>;
  return <span className="dl-tag dl-tag-slate">Closed</span>;
}

/** Initials for the dl-avatar identity mark. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('');
}

// ─── Stat tile ────────────────────────────────────────────────────────────────

interface StatTileProps {
  label: string;
  value: React.ReactNode;
  hint?: string;
}

function StatTile({ label, value, hint }: StatTileProps) {
  return (
    <div className="dl-tile">
      <span className="dl-tile-label">{label}</span>
      <span className="dl-tile-value" style={{ fontSize: '1.05rem' }}>{value}</span>
      {hint && <span className="dl-tile-hint">{hint}</span>}
    </div>
  );
}

// ─── Usage & Analytics ────────────────────────────────────────────────────────

interface UsageSummary {
  totalCalls: number;
  answeredCalls: number;
  asr: number;
  totalMinutes: number;
  avgDurationSec: number;
  totalCost: number;
}

function computeSummary(rows: CdrSummaryRow[]): UsageSummary {
  let totalCalls = 0;
  let answeredCalls = 0;
  let totalDurationSec = 0;
  let totalCost = 0;

  for (const row of rows) {
    totalCalls += row.total_calls;
    answeredCalls += row.answered_calls;
    totalDurationSec += row.total_duration_sec;
    totalCost += row.total_cost ?? 0;
  }

  const asr = totalCalls > 0 ? Math.round((answeredCalls / totalCalls) * 100) : 0;
  const avgDurationSec = answeredCalls > 0 ? totalDurationSec / answeredCalls : 0;

  return {
    totalCalls,
    answeredCalls,
    asr,
    totalMinutes: Math.round(totalDurationSec / 60),
    avgDurationSec,
    totalCost,
  };
}

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ─── Daily volume chart (pure SVG, no library) ───────────────────────────────
// Recolored for the daylight canvas following the fresh CallQualityPage
// treatment: ink-scale axes/labels, hairline ink grid, azure series,
// white-filled dots with colored strokes, low-opacity area gradient.
// No glow filters, no dark boxes.

interface DailyVolumeChartProps {
  rows: CdrSummaryRow[];
}

function DailyVolumeChart({ rows }: DailyVolumeChartProps) {
  const gradientId = useId();

  // Aggregate rows by date
  const byDate = new Map<string, number>();
  for (const row of rows) {
    const dateKey = row.date ?? '';
    if (!dateKey) continue;
    byDate.set(dateKey, (byDate.get(dateKey) ?? 0) + row.total_calls);
  }

  // Build last-30-days slots
  const slots: Array<{ date: string; label: string; calls: number }> = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    slots.push({ date: key, label, calls: byDate.get(key) ?? 0 });
  }

  const maxCalls = Math.max(...slots.map((s) => s.calls), 1);

  // Chart dimensions
  const W = 900;
  const H = 200;
  const PAD_L = 40;
  const PAD_R = 16;
  const PAD_T = 16;
  const PAD_B = 32;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  // Build SVG path points
  const points = slots.map((s, i) => ({
    x: PAD_L + (i / (slots.length - 1)) * chartW,
    y: PAD_T + chartH - (s.calls / maxCalls) * chartH,
  }));

  // Smooth line path using cubic bezier
  function smoothPath(pts: { x: number; y: number }[]): string {
    if (pts.length < 2) return '';
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(i - 1, 0)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(i + 2, pts.length - 1)];
      const tension = 0.3;
      const cp1x = p1.x + (p2.x - p0.x) * tension;
      const cp1y = p1.y + (p2.y - p0.y) * tension;
      const cp2x = p2.x - (p3.x - p1.x) * tension;
      const cp2y = p2.y - (p3.y - p1.y) * tension;
      d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
    }
    return d;
  }

  const linePath = smoothPath(points);
  // Area path: line path + close to bottom
  const areaPath = linePath +
    ` L ${points[points.length - 1].x} ${PAD_T + chartH}` +
    ` L ${points[0].x} ${PAD_T + chartH} Z`;

  // Grid lines
  const gridCount = 4;
  const gridLines = Array.from({ length: gridCount + 1 }, (_, i) => {
    const frac = i / gridCount;
    return {
      y: PAD_T + chartH - frac * chartH,
      value: Math.round(maxCalls * frac),
    };
  });

  // X-axis labels (every 5 days)
  const LABEL_EVERY = 5;

  return (
    <div style={{ width: '100%', overflowX: 'auto' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', minHeight: 180, display: 'block' }}
        aria-label="Daily call volume chart"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CHART_AZURE} stopOpacity={0.14} />
            <stop offset="100%" stopColor={CHART_AZURE} stopOpacity={0} />
          </linearGradient>
        </defs>

        {/* Horizontal grid lines */}
        {gridLines.map(({ y, value }) => (
          <g key={value}>
            <line
              x1={PAD_L} y1={y} x2={W - PAD_R} y2={y}
              stroke="rgba(14,23,38,0.05)" strokeWidth={1}
            />
            <text
              x={PAD_L - 8} y={y + 4}
              textAnchor="end" fontSize={10} fill="#7c8ba3"
              fontFamily="system-ui, -apple-system, sans-serif"
            >
              {value}
            </text>
          </g>
        ))}

        {/* Area fill */}
        <path d={areaPath} fill={`url(#${gradientId})`} />

        {/* Line */}
        <path
          d={linePath}
          fill="none"
          stroke={CHART_AZURE}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Data points */}
        {points.map((p, i) => (
          <g key={slots[i].date}>
            <circle cx={p.x} cy={p.y} r={2.5} fill="#ffffff" stroke={CHART_AZURE} strokeWidth={1.5} />
            <title>{slots[i].label}: {slots[i].calls} calls</title>
          </g>
        ))}

        {/* X-axis labels */}
        {slots.map((slot, i) => {
          if (i % LABEL_EVERY !== 0) return null;
          const x = PAD_L + (i / (slots.length - 1)) * chartW;
          return (
            <text
              key={slot.date}
              x={x} y={H - 8}
              textAnchor="middle" fontSize={10} fill="#8b99b0"
              fontFamily="system-ui, -apple-system, sans-serif"
            >
              {slot.label}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

// ─── Recent calls table ───────────────────────────────────────────────────────

interface RecentCallsTableProps {
  cdrs: Cdr[];
}

function RecentCallsTable({ cdrs }: RecentCallsTableProps) {
  if (cdrs.length === 0) {
    return (
      <div className="dl-empty" style={{ border: 'none', borderRadius: 0 }}>
        No call records yet. CDRs will appear here after calls are processed.
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
        <thead>
          <tr>
            {['Date / Time', 'Dir', 'From', 'To', 'Duration', 'Status', 'Hangup Cause'].map((h) => (
              <th key={h} className="dl-th">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cdrs.map((cdr) => {
            const answered = cdr.answer_time != null;
            const startDt = new Date(cdr.start_time);
            const dateStr = startDt.toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
            });
            const timeStr = startDt.toLocaleTimeString(undefined, {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false,
            });

            return (
              <tr key={cdr.uuid} className="dl-row">
                {/* Date/Time */}
                <td className="dlx-td">
                  <div style={{ color: 'var(--rcf-ink)', fontVariantNumeric: 'tabular-nums', fontSize: '0.78rem' }}>
                    {dateStr}
                  </div>
                  <div style={{ color: 'var(--rcf-ink-dim)', fontSize: '0.7rem', fontVariantNumeric: 'tabular-nums' }}>
                    {timeStr}
                  </div>
                </td>

                {/* Direction */}
                <td className="dlx-td">
                  <span className={cdr.direction === 'inbound' ? 'dl-tag' : 'dl-tag dl-tag-slate'}>
                    {cdr.direction === 'inbound' ? 'In' : 'Out'}
                  </span>
                </td>

                {/* From */}
                <td className="dlx-td" style={{ fontFamily: MONO, fontSize: '0.78rem', color: 'var(--rcf-ink-soft)' }}>
                  {cdr.caller_id || '—'}
                </td>

                {/* To */}
                <td className="dlx-td" style={{ fontFamily: MONO, fontSize: '0.78rem', color: 'var(--rcf-ink-soft)' }}>
                  {cdr.destination}
                </td>

                {/* Duration */}
                <td className="dlx-td" style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--rcf-ink-dim)' }}>
                  {cdr.duration_seconds > 0 ? fmtDuration(cdr.duration_seconds) : '—'}
                </td>

                {/* Status — green answered; slate for no-answer (not an error) */}
                <td className="dlx-td">
                  {answered ? (
                    <span className="dl-pill dl-pill-on">Answered</span>
                  ) : (
                    <span className="dl-tag dl-tag-slate">No Answer</span>
                  )}
                </td>

                {/* Hangup Cause */}
                <td className="dlx-td" style={{ fontFamily: MONO, fontSize: '0.72rem', color: 'var(--rcf-ink-dim)' }}>
                  {cdr.hangup_cause ?? '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Usage summary stat tiles ─────────────────────────────────────────────────

function UsageSummaryTiles({ summary }: { summary: UsageSummary }) {
  return (
    <div className="dlx3-tiles">
      <StatTile label="Total Calls (30d)" value={summary.totalCalls.toLocaleString()} />
      <StatTile
        label="Answered / ASR"
        value={
          <span>
            {summary.answeredCalls.toLocaleString()}{' '}
            <span style={{ fontSize: '0.78rem', color: 'var(--rcf-ink-dim)', fontWeight: 600 }}>
              ({summary.asr}%)
            </span>
          </span>
        }
      />
      <StatTile label="Total Minutes" value={summary.totalMinutes.toLocaleString()} />
      <StatTile
        label="Avg Duration"
        value={summary.avgDurationSec > 0 ? fmtDuration(summary.avgDurationSec) : '—'}
      />
      <StatTile label="Total Cost" value={`$${summary.totalCost.toFixed(2)}`} />
    </div>
  );
}

// ─── Main usage section ───────────────────────────────────────────────────────

interface CustomerUsageSectionProps {
  customerId: number;
}

function CustomerUsageSection({ customerId }: CustomerUsageSectionProps) {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const {
    data: recentData,
    isLoading: recentLoading,
    isError: recentError,
  } = useQuery({
    queryKey: ['customerCdrs', customerId, 'recent'],
    queryFn: () => getCustomerRecentCdrs(customerId, 20, thirtyDaysAgo),
    staleTime: 60_000,
  });

  const {
    data: summaryData,
    isLoading: summaryLoading,
    isError: summaryError,
  } = useQuery({
    queryKey: ['customerCdrs', customerId, 'daily'],
    queryFn: () => getCustomerCdrDailySummary(customerId),
    staleTime: 60_000,
  });

  const isLoading = recentLoading || summaryLoading;
  const isError = recentError || summaryError;

  const summaryRows = summaryData?.summary ?? [];
  const recentCdrs = recentData?.items ?? [];
  const computedSummary = computeSummary(summaryRows);

  return (
    <section className="dl-panel">
      <div className="dl-panel-head">
        <span aria-hidden="true" style={{ display: 'inline-flex', color: 'var(--rcf-azure-deep)', flexShrink: 0 }}>
          <Activity size={15} strokeWidth={2} />
        </span>
        <h3 className="dl-panel-title" style={{ margin: 0 }}>Usage &amp; Analytics</h3>
      </div>

      <div className="dl-panel-body">
        {isLoading && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              color: 'var(--rcf-ink-dim)',
              fontSize: '0.82rem',
              padding: '24px 0',
            }}
          >
            <Spinner size="xs" /> Loading analytics…
          </div>
        )}

        {!isLoading && isError && (
          <div className="dl-banner dl-banner-err">
            Unable to load usage data. The CDR service may be unavailable.
          </div>
        )}

        {!isLoading && !isError && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

            {/* Summary stat tiles */}
            <UsageSummaryTiles summary={computedSummary} />

            {/* Daily volume chart */}
            <div className="dlx3-chart-box">
              <div className="dlx3-chart-title">
                <span className="dlx3-chart-dot" style={{ background: CHART_AZURE }} aria-hidden="true" />
                Daily Call Volume — Last 30 Days
              </div>
              {summaryRows.length === 0 ? (
                <div className="dl-empty" style={{ border: 'none', background: 'transparent', marginBottom: 8 }}>
                  No call records yet. CDRs will appear here after calls are processed.
                </div>
              ) : (
                <DailyVolumeChart rows={summaryRows} />
              )}
            </div>

            {/* Recent calls table */}
            <div>
              <h4 className="dl-section-title">Recent Calls</h4>
              <div style={{ border: '1px solid var(--rcf-line-soft)', borderRadius: 10, overflow: 'hidden' }}>
                <RecentCallsTable cdrs={recentCdrs} />
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Estimated monthly bill (read-only reference) ─────────────────────────────

/**
 * Compact, READ-ONLY estimated monthly bill for the admin 360.
 *
 * Mirrors the customer-facing estimate (`getCustomerBilling`). The platform
 * does not invoice — CDRs are rated externally (Equinox) — so this is purely
 * a reference. Degrades gracefully on load/empty/error.
 */
function CustomerBillingEstimate({ customerId }: { customerId: number }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['customerBilling', customerId],
    queryFn: () => getCustomerBilling(customerId),
    retry: false,
    staleTime: 60_000,
  });

  return (
    <section className="dl-panel">
      <div className="dl-panel-head">
        <span aria-hidden="true" style={{ display: 'inline-flex', color: 'var(--rcf-azure-deep)', flexShrink: 0 }}>
          <Receipt size={15} strokeWidth={2} />
        </span>
        <h3 className="dl-panel-title" style={{ margin: 0 }}>Estimated Monthly Bill</h3>
      </div>

      <div className="dl-panel-body">
        {isLoading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--rcf-ink-dim)', fontSize: '0.82rem', padding: '8px 0' }}>
            <Spinner size="xs" /> Loading estimate…
          </div>
        ) : isError ? (
          <div style={{ color: 'var(--rcf-ink-dim)', fontSize: '0.82rem', padding: '4px 0' }}>
            Unable to load the estimated bill.
          </div>
        ) : !data || data.line_items.length === 0 ? (
          <div className="dl-empty">No billable products provisioned.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div className="dl-kvbox">
              {data.line_items.map((item, i) => (
                <div key={`${item.product}-${item.label}-${i}`} className="dl-kv">
                  <span className="dl-kv-label" style={{ color: 'var(--rcf-ink-soft)' }}>
                    {item.label}
                    {(item.product === 'rcf' || item.product === 'voicemail') && (
                      <span style={{ color: 'var(--rcf-ink-dim)', marginLeft: 8, fontSize: '0.72rem' }}>
                        {item.qty.toLocaleString()} {item.unit}
                        {item.qty === 1 ? '' : 's'} × {fmtMoney(item.unit_price)}
                      </span>
                    )}
                  </span>
                  <span className="dl-kv-value" style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    {fmtMoney(item.subtotal)}
                  </span>
                </div>
              ))}
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 16,
                paddingTop: 14,
              }}
            >
              <span className="dl-fact-label" style={{ marginBottom: 0, color: 'var(--rcf-azure-deep)' }}>
                Estimated Monthly Total
              </span>
              <span
                style={{
                  fontFamily: ARCHIVO,
                  fontSize: '1.2rem',
                  fontWeight: 700,
                  color: 'var(--rcf-ink)',
                  fontVariantNumeric: 'tabular-nums',
                  whiteSpace: 'nowrap',
                }}
              >
                {fmtMoney(data.total_monthly_estimate)}
              </span>
            </div>

            {data.disclaimer && (
              <p className="dl-help" style={{ margin: '6px 0 0' }}>
                {data.disclaimer}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Account detail view ──────────────────────────────────────────────────────

interface AccountDetailViewProps {
  customer: Customer;
  onEdit: () => void;
  onDelete: () => void;
}

function AccountDetailView({ customer, onEdit, onDelete }: AccountDetailViewProps) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const { data: tierData, isLoading: tierLoading } = useQuery({
    queryKey: ['customerTier', customer.id],
    queryFn: () => getCustomerTier(customer.id),
  });

  const ucaasMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      apiRequest<Customer>('PUT', `/customers/${customer.id}`, { ucaas_enabled: enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customer', customer.id] });
      qc.invalidateQueries({ queryKey: ['customers'] });
      toastOk(`UCaaS add-on ${!customer.ucaas_enabled ? 'enabled' : 'disabled'}`);
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const showRcf = customer.account_type === 'rcf' || customer.account_type === 'hybrid';
  const showApi = customer.account_type === 'api' || customer.account_type === 'hybrid';
  const showTrunk = customer.account_type === 'trunk' || customer.account_type === 'hybrid';
  const showUcaas = customer.account_type === 'ucaas' || customer.ucaas_enabled === true;

  const tier = tierData?.tier;

  return (
    <div className="dl-stack">

      {/* Account overview tiles */}
      <div className="dlx3-tiles">
        {/* Rate-limiting fields are meaningless for RCF accounts */}
        {customer.account_type !== 'rcf' && (
          <>
            <StatTile
              label="Daily Limit"
              value={customer.daily_limit != null ? `$${customer.daily_limit.toFixed(2)}` : '--'}
            />
            <StatTile
              label="CPM Limit"
              value={customer.cpm_limit != null ? String(customer.cpm_limit) : '--'}
            />
          </>
        )}
        <StatTile
          label="Fraud Score"
          value={
            <span style={{ color: customer.fraud_score > 70 ? 'var(--rcf-red)' : undefined }}>
              {customer.fraud_score ?? 0}
            </span>
          }
        />
        <StatTile
          label="Created"
          value={
            customer.created_at
              ? new Date(customer.created_at).toLocaleDateString(undefined, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })
              : '--'
          }
        />
      </div>

      {/* CPS Tier line */}
      {tierLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--rcf-ink-dim)', fontSize: '0.8rem' }}>
          <Spinner size="xs" /> Loading tier…
        </div>
      )}
      {!tierLoading && tier && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: '0.82rem' }}>
          <span className="dl-fact-label" style={{ marginBottom: 0 }}>CPS Tier</span>
          <span style={{ color: 'var(--rcf-ink)', fontWeight: 700 }}>{tier.name}</span>
          <span style={{ color: 'var(--rcf-ink-dim)' }}>— {tier.cps_limit} CPS</span>
        </div>
      )}

      {/* Service sections — strictly account_type-driven */}
      {showRcf && <CustomerRcfSection customerId={customer.id} />}
      {showApi && <CustomerApiSection customerId={customer.id} />}
      {showTrunk && <CustomerTrunkSection customerId={customer.id} />}
      {showUcaas && <CustomerUcaasSection customerId={customer.id} />}

      {/* Estimated monthly bill — read-only reference (real billing is external) */}
      <CustomerBillingEstimate customerId={customer.id} />

      {/* Usage & Analytics */}
      <CustomerUsageSection customerId={customer.id} />

      {/* Account Actions — at the bottom */}
      <section className="dl-panel">
        <div className="dl-panel-head">
          <span aria-hidden="true" style={{ display: 'inline-flex', color: 'var(--rcf-azure-deep)', flexShrink: 0 }}>
            <Settings size={15} strokeWidth={2} />
          </span>
          <h3 className="dl-panel-title" style={{ margin: 0 }}>Account Actions</h3>
        </div>
        <div
          className="dl-panel-body"
          style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}
        >
          <button type="button" className="dl-btn dl-btn-primary" onClick={onEdit}>
            Edit Customer
          </button>

          {/* UCaaS add-on toggle — only for api/trunk/hybrid */}
          {(customer.account_type === 'api' || customer.account_type === 'trunk' || customer.account_type === 'hybrid') && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                type="button"
                role="switch"
                aria-checked={customer.ucaas_enabled === true}
                aria-label="UCaaS add-on"
                className={customer.ucaas_enabled ? 'dlx-switch dlx-switch-on' : 'dlx-switch'}
                disabled={ucaasMutation.isPending}
                onClick={() => ucaasMutation.mutate(!customer.ucaas_enabled)}
              />
              <span
                style={{
                  fontSize: '0.8rem',
                  fontWeight: 700,
                  color: customer.ucaas_enabled ? 'var(--rcf-azure-deep)' : 'var(--rcf-ink-dim)',
                }}
              >
                UCaaS {customer.ucaas_enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>
          )}

          {/* Delete — pushed to the right */}
          <div style={{ marginLeft: 'auto' }}>
            <button type="button" className="dl-btn dl-btn-danger" onClick={onDelete}>
              Delete Customer
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

// ─── CustomerAccountPage ──────────────────────────────────────────────────────

export function CustomerAccountPage() {
  const { customerId: customerIdParam } = useParams<{ customerId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const [isEditing, setIsEditing] = useState(false);

  const customerId = parseInt(customerIdParam ?? '', 10);

  const {
    data: customer,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['customer', customerId],
    queryFn: () => getCustomer(customerId),
    enabled: !isNaN(customerId),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteCustomer(customerId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      toastOk('Customer deleted');
      navigate('/admin/customers', { replace: true });
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleDelete() {
    if (!customer) return;
    if (
      !confirm(
        `Delete customer "${customer.name}" and ALL associated records (RCF, trunks, DIDs)?\n\nThis cannot be undone.`,
      )
    )
      return;
    deleteMutation.mutate();
  }

  function handleSaved() {
    setIsEditing(false);
    qc.invalidateQueries({ queryKey: ['customer', customerId] });
  }

  // ---- Loading state ----
  if (isLoading) {
    return (
      <div className="dl-center">
        <Spinner />
        <span style={{ color: 'var(--rcf-ink-dim)', fontSize: '0.88rem' }}>Loading customer…</span>
      </div>
    );
  }

  // ---- Error state ----
  if (isError || !customer) {
    return (
      <div className="dl-stack">
        <div>
          <button
            type="button"
            className="dlx-linkbtn"
            onClick={() => navigate('/admin/customers')}
          >
            <ChevronLeft size={13} strokeWidth={2.25} aria-hidden="true" />
            Back to Customers
          </button>
        </div>
        <div className="dl-banner dl-banner-err">
          Failed to load customer. The account may not exist.
        </div>
      </div>
    );
  }

  return (
    <div className="dl-stack">

      {/* Back link */}
      <div>
        <button
          type="button"
          className="dlx-linkbtn"
          onClick={() => navigate('/admin/customers')}
        >
          <ChevronLeft size={13} strokeWidth={2.25} aria-hidden="true" />
          Customers
        </button>
      </div>

      {/* ── Identity header — composed panel row ── */}
      <section className="dl-panel">
        <div
          className="dl-panel-body"
          style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}
        >
          {/* Customer avatar */}
          <span className="dl-avatar" style={{ width: 52, height: 52, fontSize: '1.1rem' }} aria-hidden="true">
            {initials(customer.name)}
          </span>

          {/* Name + chips */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 7 }}>
              <h2
                style={{
                  margin: 0,
                  fontFamily: ARCHIVO,
                  fontSize: '1.25rem',
                  fontWeight: 700,
                  color: 'var(--rcf-ink)',
                  letterSpacing: '-0.018em',
                  lineHeight: 1.15,
                }}
              >
                {customer.name}
              </h2>
              <StatusPill status={customer.status} />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="dl-tag">{customer.account_type.toUpperCase()}</span>
              <span className="dl-tag dl-tag-slate">{customer.traffic_grade}</span>
              {/* UCaaS add-on indicator for api/trunk/hybrid customers */}
              {(customer.account_type === 'api' || customer.account_type === 'trunk' || customer.account_type === 'hybrid') && (
                <span className={customer.ucaas_enabled ? 'dl-tag' : 'dl-tag dl-tag-slate'}>
                  UCaaS {customer.ucaas_enabled ? 'Enabled' : 'Disabled'}
                </span>
              )}
              <span style={{ fontFamily: MONO, fontSize: '0.76rem', color: 'var(--rcf-ink-dim)', letterSpacing: '0.04em' }}>
                #{customer.id}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Edit form (shown in place of the overview when editing) */}
      {isEditing && (
        <section className="dl-panel">
          <div className="dl-panel-head">
            <h3 className="dl-panel-title" style={{ margin: 0 }}>Edit Customer</h3>
          </div>
          <CustomerEditForm
            customer={customer}
            onCancel={() => setIsEditing(false)}
            onSaved={handleSaved}
          />
        </section>
      )}

      {/* Overview */}
      {!isEditing && (
        <AccountDetailView
          customer={customer}
          onEdit={() => setIsEditing(true)}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}
