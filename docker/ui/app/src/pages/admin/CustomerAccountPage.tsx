import { useState, useId } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getCustomer, deleteCustomer } from '../../api/customers';
import { getCustomerTier } from '../../api/tiers';
import { apiRequest } from '../../api/client';
import { getCustomerRecentCdrs, getCustomerCdrDailySummary } from '../../api/cdrs';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/ToastContext';
import { CustomerEditForm } from './CustomerEditForm';
import { CustomerRcfSection } from './CustomerRcfSection';
import { CustomerApiSection } from './CustomerApiSection';
import { CustomerTrunkSection } from './CustomerTrunkSection';
import { CustomerStatisticsTab } from './CustomerStatisticsTab';
import type { Customer } from '../../types/customer';
import type { Cdr } from '../../types/cdr';
import type { CdrSummaryRow } from '../../types/rate';

type AccountTab = 'overview' | 'statistics';

interface AddCreditResponse {
  balance: number;
}

// ---- Stat card ----

interface StatCardProps {
  label: string;
  value: React.ReactNode;
  accent?: string;
}

function StatCard({ label, value, accent = '#3b82f6' }: StatCardProps) {
  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 14,
        padding: '20px 24px',
        position: 'relative',
        overflow: 'hidden',
        flex: '1 1 140px',
        minWidth: 0,
      }}
    >
      {/* Top accent line */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${accent}99, transparent)`,
        }}
      />
      <div
        style={{
          fontSize: '0.6rem',
          fontWeight: 700,
          color: '#4a5568',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          marginBottom: 10,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: '1.05rem',
          fontWeight: 700,
          color: '#e2e8f0',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </div>
    </div>
  );
}

// ---- Section card wrapper ----

interface SectionCardProps {
  children: React.ReactNode;
  accent?: string;
}

function SectionCard({ children, accent = '#3b82f6' }: SectionCardProps) {
  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(26,29,39,0.95) 0%, rgba(15,17,23,1) 100%)',
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 16,
        padding: '28px 32px',
        position: 'relative',
        overflow: 'hidden',
        boxShadow: '0 4px 24px rgba(0,0,0,0.25)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 40,
          right: 40,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${accent}, transparent)`,
          opacity: 0.55,
        }}
      />
      {children}
    </div>
  );
}

// ---- Usage & Analytics ----

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

// ---- Bar chart (pure SVG, no library) ----

interface DailyBarChartProps {
  rows: CdrSummaryRow[];
  accent: string;
}

function DailyBarChart({ rows, accent }: DailyBarChartProps) {
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
            <stop offset="0%" stopColor={accent} stopOpacity={0.4} />
            <stop offset="100%" stopColor={accent} stopOpacity={0.03} />
          </linearGradient>
        </defs>

        {/* Horizontal grid lines */}
        {gridLines.map(({ y, value }) => (
          <g key={value}>
            <line
              x1={PAD_L} y1={y} x2={W - PAD_R} y2={y}
              stroke="rgba(255,255,255,0.06)" strokeWidth={1}
            />
            <text
              x={PAD_L - 8} y={y + 4}
              textAnchor="end" fontSize={10} fill="#4a5568"
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
          stroke={accent}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Data points */}
        {points.map((p, i) => (
          <g key={slots[i].date}>
            <circle cx={p.x} cy={p.y} r={3} fill="#0f1117" stroke={accent} strokeWidth={1.5} />
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
              textAnchor="middle" fontSize={10} fill="#4a5568"
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

// ---- Recent calls table ----

interface RecentCallsTableProps {
  cdrs: Cdr[];
}

function RecentCallsTable({ cdrs }: RecentCallsTableProps) {
  if (cdrs.length === 0) {
    return (
      <div
        style={{
          padding: '32px 0',
          textAlign: 'center',
          color: '#4a5568',
          fontSize: '0.82rem',
        }}
      >
        No call records yet. CDRs will appear here after calls are processed.
      </div>
    );
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: '0.78rem',
          color: '#cbd5e0',
        }}
      >
        <thead>
          <tr>
            {['Date / Time', 'Dir', 'From', 'To', 'Duration', 'Status', 'Hangup Cause'].map((h) => (
              <th
                key={h}
                style={{
                  padding: '8px 12px',
                  textAlign: 'left',
                  fontSize: '0.6rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: '#4a5568',
                  borderBottom: '1px solid rgba(42,47,69,0.5)',
                  whiteSpace: 'nowrap',
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cdrs.map((cdr, idx) => {
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
              <tr
                key={cdr.uuid}
                style={{
                  borderBottom: '1px solid rgba(42,47,69,0.25)',
                  background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.012)',
                }}
              >
                {/* Date/Time */}
                <td style={{ padding: '7px 12px', whiteSpace: 'nowrap' }}>
                  <div style={{ color: '#a0aec0', fontVariantNumeric: 'tabular-nums' }}>
                    {dateStr}
                  </div>
                  <div
                    style={{
                      color: '#4a5568',
                      fontSize: '0.7rem',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {timeStr}
                  </div>
                </td>

                {/* Direction */}
                <td style={{ padding: '7px 12px' }}>
                  <span
                    style={{
                      display: 'inline-block',
                      fontSize: '0.6rem',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      padding: '2px 7px',
                      borderRadius: 4,
                      background:
                        cdr.direction === 'inbound'
                          ? 'rgba(59,130,246,0.15)'
                          : 'rgba(168,85,247,0.15)',
                      color:
                        cdr.direction === 'inbound' ? '#60a5fa' : '#c084fc',
                      border:
                        cdr.direction === 'inbound'
                          ? '1px solid rgba(59,130,246,0.25)'
                          : '1px solid rgba(168,85,247,0.25)',
                    }}
                  >
                    {cdr.direction === 'inbound' ? 'In' : 'Out'}
                  </span>
                </td>

                {/* From */}
                <td
                  style={{
                    padding: '7px 12px',
                    fontFamily: 'monospace',
                    color: '#94a3b8',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {cdr.caller_id || '—'}
                </td>

                {/* To */}
                <td
                  style={{
                    padding: '7px 12px',
                    fontFamily: 'monospace',
                    color: '#94a3b8',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {cdr.destination}
                </td>

                {/* Duration */}
                <td
                  style={{
                    padding: '7px 12px',
                    fontVariantNumeric: 'tabular-nums',
                    color: '#718096',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {cdr.duration_seconds > 0 ? fmtDuration(cdr.duration_seconds) : '—'}
                </td>

                {/* Status */}
                <td style={{ padding: '7px 12px' }}>
                  <span
                    style={{
                      display: 'inline-block',
                      fontSize: '0.6rem',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      padding: '2px 7px',
                      borderRadius: 4,
                      background: answered
                        ? 'rgba(34,197,94,0.12)'
                        : 'rgba(239,68,68,0.12)',
                      color: answered ? '#4ade80' : '#f87171',
                      border: answered
                        ? '1px solid rgba(34,197,94,0.2)'
                        : '1px solid rgba(239,68,68,0.2)',
                    }}
                  >
                    {answered ? 'Answered' : 'No Answer'}
                  </span>
                </td>

                {/* Hangup Cause */}
                <td
                  style={{
                    padding: '7px 12px',
                    color: '#4a5568',
                    fontFamily: 'monospace',
                    fontSize: '0.72rem',
                    whiteSpace: 'nowrap',
                  }}
                >
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

// ---- Usage summary stat cards ----

interface UsageSummaryCardsProps {
  summary: UsageSummary;
  accent: string;
}

function UsageSummaryCards({ summary, accent }: UsageSummaryCardsProps) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
      <StatCard
        label="Total Calls (30d)"
        accent={accent}
        value={summary.totalCalls.toLocaleString()}
      />
      <StatCard
        label="Answered / ASR"
        accent={accent}
        value={
          <span>
            {summary.answeredCalls.toLocaleString()}{' '}
            <span style={{ fontSize: '0.78rem', color: '#718096' }}>
              ({summary.asr}%)
            </span>
          </span>
        }
      />
      <StatCard
        label="Total Minutes"
        accent={accent}
        value={summary.totalMinutes.toLocaleString()}
      />
      <StatCard
        label="Avg Duration"
        accent={accent}
        value={summary.avgDurationSec > 0 ? fmtDuration(summary.avgDurationSec) : '—'}
      />
      <StatCard
        label="Total Cost"
        accent={accent}
        value={`$${summary.totalCost.toFixed(2)}`}
      />
    </div>
  );
}

// ---- Main usage section ----

interface CustomerUsageSectionProps {
  customerId: number;
  accent: string;
}

function CustomerUsageSection({ customerId, accent }: CustomerUsageSectionProps) {
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

  const sectionLabelStyle: React.CSSProperties = {
    fontSize: '0.6rem',
    fontWeight: 700,
    color: accent,
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
    marginBottom: 20,
  };

  const subLabelStyle: React.CSSProperties = {
    fontSize: '0.6rem',
    fontWeight: 700,
    color: '#4a5568',
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
    marginBottom: 14,
  };

  return (
    <SectionCard accent={accent}>
      <div style={sectionLabelStyle}>Usage &amp; Analytics</div>

      {isLoading && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            color: '#718096',
            fontSize: '0.82rem',
            padding: '32px 0',
          }}
        >
          <Spinner size="xs" /> Loading analytics…
        </div>
      )}

      {!isLoading && isError && (
        <div
          style={{
            padding: '12px 16px',
            borderRadius: 10,
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.18)',
            color: '#f87171',
            fontSize: '0.8rem',
          }}
        >
          Unable to load usage data. The CDR service may be unavailable.
        </div>
      )}

      {!isLoading && !isError && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>

          {/* Summary stat cards */}
          <UsageSummaryCards summary={computedSummary} accent={accent} />

          {/* Daily volume chart */}
          <div>
            <div style={subLabelStyle}>Daily Call Volume — Last 30 Days</div>
            <div
              style={{
                background: 'rgba(10,12,18,0.7)',
                border: '1px solid rgba(42,47,69,0.35)',
                borderRadius: 10,
                padding: '16px 16px 6px',
              }}
            >
              {summaryRows.length === 0 ? (
                <div
                  style={{
                    padding: '32px 0',
                    textAlign: 'center',
                    color: '#4a5568',
                    fontSize: '0.82rem',
                  }}
                >
                  No call records yet. CDRs will appear here after calls are processed.
                </div>
              ) : (
                <DailyBarChart rows={summaryRows} accent={accent} />
              )}
            </div>
          </div>

          {/* Recent calls table */}
          <div>
            <div style={subLabelStyle}>Recent Calls</div>
            <div
              style={{
                background: 'rgba(10,12,18,0.5)',
                border: '1px solid rgba(42,47,69,0.35)',
                borderRadius: 10,
                overflow: 'hidden',
              }}
            >
              <RecentCallsTable cdrs={recentCdrs} />
            </div>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

// ---- Account detail view ----

interface AccountDetailViewProps {
  customer: Customer;
  onEdit: () => void;
  onDelete: () => void;
}

function AccountDetailView({ customer, onEdit, onDelete }: AccountDetailViewProps) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [creditAmount, setCreditAmount] = useState('');

  const { data: tierData, isLoading: tierLoading } = useQuery({
    queryKey: ['customerTier', customer.id],
    queryFn: () => getCustomerTier(customer.id),
  });

  const addCreditMutation = useMutation({
    mutationFn: (amount: number) =>
      apiRequest<AddCreditResponse>(
        'POST',
        `/customers/${customer.id}/credit?amount=${amount}`,
      ),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['customer', customer.id] });
      qc.invalidateQueries({ queryKey: ['customers'] });
      toastOk(
        `Added $${parseFloat(creditAmount).toFixed(2)} credit. New balance: $${data.balance.toFixed(2)}`,
      );
      setCreditAmount('');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleAddCredit(e: React.FormEvent) {
    e.preventDefault();
    const amount = parseFloat(creditAmount);
    if (!amount || amount <= 0) {
      toastErr('Enter a valid amount');
      return;
    }
    addCreditMutation.mutate(amount);
  }

  const showRcf = customer.account_type === 'rcf' || customer.account_type === 'hybrid';
  const showApi = customer.account_type === 'api' || customer.account_type === 'hybrid';
  const showTrunk = customer.account_type === 'trunk' || customer.account_type === 'hybrid';

  const accountTypeAccentMap: Record<string, string> = {
    rcf: '#22c55e',
    api: '#a855f7',
    trunk: '#f59e0b',
    hybrid: '#3b82f6',
  };
  const headerAccent = accountTypeAccentMap[customer.account_type] ?? '#3b82f6';

  const tier = tierData?.tier;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* Account overview stat cards */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
        <StatCard
          label="Balance"
          accent={customer.balance < 0 ? '#ef4444' : '#22c55e'}
          value={
            <span style={{ color: customer.balance < 0 ? '#f87171' : '#4ade80' }}>
              ${customer.balance.toFixed(2)}
            </span>
          }
        />
        <StatCard
          label="Credit Limit"
          value={`$${customer.credit_limit.toFixed(2)}`}
        />
        <StatCard
          label="Daily Limit"
          value={customer.daily_limit != null ? `$${customer.daily_limit.toFixed(2)}` : '--'}
        />
        <StatCard
          label="CPM Limit"
          value={customer.cpm_limit != null ? String(customer.cpm_limit) : '--'}
        />
        <StatCard
          label="Fraud Score"
          accent={customer.fraud_score > 70 ? '#ef4444' : '#3b82f6'}
          value={
            <span style={{ color: customer.fraud_score > 70 ? '#f87171' : '#e2e8f0' }}>
              {customer.fraud_score ?? 0}
            </span>
          }
        />
        <StatCard
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#718096', fontSize: '0.8rem' }}>
          <Spinner size="xs" /> Loading tier…
        </div>
      )}
      {!tierLoading && tier && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: '0.82rem',
            color: '#718096',
          }}
        >
          <span
            style={{
              fontSize: '0.6rem',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.09em',
              color: '#4a5568',
            }}
          >
            CPS Tier:
          </span>
          <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{tier.name}</span>
          <span style={{ color: '#4a5568' }}>—</span>
          <span>{tier.cps_limit} CPS</span>
        </div>
      )}

      {/* Actions bar */}
      <SectionCard accent="#3b82f6">
        <div
          style={{
            fontSize: '0.6rem',
            fontWeight: 700,
            color: '#3b82f6',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            marginBottom: 20,
          }}
        >
          Account Actions
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <Button variant="primary" size="sm" onClick={onEdit}>
            Edit Customer
          </Button>

          {/* Add Credit form */}
          <form
            onSubmit={handleAddCredit}
            style={{ display: 'flex', alignItems: 'center', gap: 8 }}
          >
            <input
              type="number"
              value={creditAmount}
              onChange={(e) => setCreditAmount(e.target.value)}
              placeholder="Amount ($)"
              step="0.01"
              min="0.01"
              style={{
                fontSize: '0.82rem',
                padding: '7px 12px',
                borderRadius: 8,
                width: 130,
                border: '1px solid rgba(42,47,69,0.8)',
                background: 'rgba(13,15,21,0.9)',
                color: '#e2e8f0',
                outline: 'none',
                transition: 'border-color 0.15s, box-shadow 0.15s',
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = '#22c55e';
                e.currentTarget.style.boxShadow = '0 0 0 3px rgba(34,197,94,0.12)';
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = 'rgba(42,47,69,0.8)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            />
            <Button
              type="submit"
              variant="success"
              size="sm"
              loading={addCreditMutation.isPending}
            >
              Add Credit
            </Button>
          </form>

          {/* Delete — pushed to the right */}
          <div style={{ marginLeft: 'auto' }}>
            <Button variant="danger" size="sm" onClick={onDelete}>
              Delete Customer
            </Button>
          </div>
        </div>
      </SectionCard>

      {/* Usage & Analytics */}
      <CustomerUsageSection customerId={customer.id} accent={headerAccent} />

      {/* Service sections */}
      {showRcf && (
        <SectionCard accent="#22c55e">
          <CustomerRcfSection customerId={customer.id} />
        </SectionCard>
      )}

      {showApi && (
        <SectionCard accent="#a855f7">
          <CustomerApiSection customerId={customer.id} />
        </SectionCard>
      )}

      {showTrunk && (
        <SectionCard accent="#f59e0b">
          <CustomerTrunkSection customerId={customer.id} />
        </SectionCard>
      )}
    </div>
  );
}

// ---- CustomerAccountPage ----

export function CustomerAccountPage() {
  const { customerId: customerIdParam } = useParams<{ customerId: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const [isEditing, setIsEditing] = useState(false);
  const [activeTab, setActiveTab] = useState<AccountTab>('overview');

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
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: '80px 0',
          color: '#718096',
          fontSize: '0.9rem',
        }}
      >
        <Spinner /> Loading customer…
      </div>
    );
  }

  // ---- Error state ----
  if (isError || !customer) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, paddingTop: 8 }}>
        <button
          onClick={() => navigate('/admin/customers')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            background: 'none',
            border: 'none',
            color: '#718096',
            fontSize: '0.85rem',
            cursor: 'pointer',
            padding: '4px 0',
            width: 'fit-content',
          }}
        >
          <LeftArrow /> Back to Customers
        </button>
        <div
          style={{
            padding: '16px 20px',
            borderRadius: 12,
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.2)',
            color: '#f87171',
            fontSize: '0.875rem',
          }}
        >
          Failed to load customer. The account may not exist.
        </div>
      </div>
    );
  }

  // ---- Derived display values ----
  const accountTypeAccent: Record<string, string> = {
    rcf: '#22c55e',
    api: '#a855f7',
    trunk: '#f59e0b',
    hybrid: '#3b82f6',
  };
  const headerAccent = accountTypeAccent[customer.account_type] ?? '#3b82f6';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, paddingTop: 8 }}>

      {/* Back button */}
      <div>
        <button
          onClick={() => navigate('/admin/customers')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            background: 'none',
            border: '1px solid rgba(42,47,69,0.5)',
            borderRadius: 8,
            color: '#718096',
            fontSize: '0.82rem',
            cursor: 'pointer',
            padding: '6px 14px',
            transition: 'color 0.15s, border-color 0.15s, background 0.15s',
          }}
          onMouseEnter={(e) => {
            const el = e.currentTarget;
            el.style.color = '#e2e8f0';
            el.style.borderColor = 'rgba(59,130,246,0.4)';
            el.style.background = 'rgba(59,130,246,0.06)';
          }}
          onMouseLeave={(e) => {
            const el = e.currentTarget;
            el.style.color = '#718096';
            el.style.borderColor = 'rgba(42,47,69,0.5)';
            el.style.background = 'none';
          }}
        >
          <LeftArrow />
          Customers
        </button>
      </div>

      {/* Header card */}
      <div
        style={{
          background: 'linear-gradient(135deg, rgba(30,33,48,0.95) 0%, rgba(19,21,29,0.98) 100%)',
          border: '1px solid rgba(42,47,69,0.6)',
          borderRadius: 18,
          padding: '32px 40px',
          position: 'relative',
          overflow: 'hidden',
          boxShadow: '0 8px 40px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.04)',
        }}
      >
        {/* Gradient accent top border */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 3,
            background: `linear-gradient(90deg, transparent 0%, ${headerAccent}99 40%, ${headerAccent} 50%, ${headerAccent}99 60%, transparent 100%)`,
          }}
        />

        {/* Radial glow in corner */}
        <div
          style={{
            position: 'absolute',
            top: -60,
            right: -60,
            width: 240,
            height: 240,
            borderRadius: '50%',
            background: `radial-gradient(circle, ${headerAccent}12 0%, transparent 70%)`,
            pointerEvents: 'none',
          }}
        />

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 24, flexWrap: 'wrap' }}>
          {/* Customer icon */}
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 16,
              background: `linear-gradient(135deg, ${headerAccent}25 0%, ${headerAccent}10 100%)`,
              border: `1px solid ${headerAccent}35`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: headerAccent,
              flexShrink: 0,
              boxShadow: `0 0 20px ${headerAccent}20`,
            }}
          >
            <UserIcon />
          </div>

          {/* Name + badges */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
              <h1
                style={{
                  fontSize: '1.75rem',
                  fontWeight: 800,
                  color: '#e2e8f0',
                  letterSpacing: '-0.025em',
                  margin: 0,
                  lineHeight: 1.15,
                }}
              >
                {customer.name}
              </h1>
              <Badge variant={customer.status}>
                {customer.status.charAt(0).toUpperCase() + customer.status.slice(1)}
              </Badge>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Badge variant={customer.account_type}>
                {customer.account_type.toUpperCase()}
              </Badge>
              <Badge variant={customer.traffic_grade}>
                {customer.traffic_grade}
              </Badge>
              <span
                style={{
                  fontFamily: 'monospace',
                  fontSize: '0.78rem',
                  color: '#4a5568',
                  letterSpacing: '0.04em',
                }}
              >
                #{customer.id}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Edit form (shown above tabs when editing) */}
      {isEditing && (
        <SectionCard accent="#3b82f6">
          <div
            style={{
              fontSize: '0.6rem',
              fontWeight: 700,
              color: '#3b82f6',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
              marginBottom: 4,
            }}
          >
            Edit Customer
          </div>
          <CustomerEditForm
            customer={customer}
            onCancel={() => setIsEditing(false)}
            onSaved={handleSaved}
          />
        </SectionCard>
      )}

      {/* Tab bar */}
      {!isEditing && (
        <div
          style={{
            display: 'flex',
            gap: 2,
            borderBottom: '1px solid rgba(42,47,69,0.5)',
            paddingBottom: 0,
          }}
        >
          {(
            [
              { id: 'overview', label: 'Overview' },
              { id: 'statistics', label: 'Statistics' },
            ] as { id: AccountTab; label: string }[]
          ).map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  background: 'none',
                  border: 'none',
                  borderBottom: isActive
                    ? `2px solid ${headerAccent}`
                    : '2px solid transparent',
                  padding: '8px 18px',
                  fontSize: '0.8rem',
                  fontWeight: isActive ? 700 : 500,
                  color: isActive ? '#e2e8f0' : '#718096',
                  cursor: 'pointer',
                  marginBottom: -1,
                  transition: 'color 0.15s, border-color 0.15s',
                  letterSpacing: '0.01em',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) e.currentTarget.style.color = '#a0aec0';
                }}
                onMouseLeave={(e) => {
                  if (!isActive) e.currentTarget.style.color = '#718096';
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Tab content */}
      {!isEditing && activeTab === 'overview' && (
        <AccountDetailView
          customer={customer}
          onEdit={() => setIsEditing(true)}
          onDelete={handleDelete}
        />
      )}

      {!isEditing && activeTab === 'statistics' && (
        <CustomerStatisticsTab customerId={customer.id} accent={headerAccent} />
      )}
    </div>
  );
}

// ---- Inline SVG icons ----

function LeftArrow() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ width: 14, height: 14, flexShrink: 0 }}
    >
      <path d="M10 3L5 8l5 5" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ width: 26, height: 26 }}
    >
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}
