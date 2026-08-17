/**
 * StirSummaryPage — admin STIR/SHAKEN attestation summary.
 *
 * Lives at `/admin/platform/stir` (a Platform Management tab). Shows the total
 * attested calls plus four breakdowns for a date window (default: last 7 days):
 *   - by_signed_attestation  (what WE signed the outbound leg with)
 *   - by_inbound_attest      (what the CALLER arrived with)
 *   - by_inbound_verstat     (the caller's verification verdict)
 *   - by_verstat_source      (carrier-supplied vs self-verified)
 *
 * Admin-only: rendered inside <RequireAdmin> via the route, and additionally
 * guarded here so a stray render never fires the admin query.
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` in index.css, plus the
 * admin `dlx-*` layer in styles/dl-admin.css, the platform `dlx2-*` layer in
 * styles/dl-platform.css, and the page-scoped `dlx4-*` layer in
 * styles/dl-platform-b.css). Renders INSIDE the PlatformManagementPage shell
 * (`dl-scope` canvas) — this page contributes only the intro, the filter
 * slab, and the breakdown panels. Attestation colors keep their shared
 * semantic mapping (A=green, B=amber, C=slate, div=azure; verstat pass=green
 * / fail=red) in light-tuned tones.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getAttestationSummary } from '../../api/stir';
import { ApiError } from '../../api/client';
import { listCustomers } from '../../api/customers';
import { Spinner } from '../../components/ui/Spinner';
import { useAuth } from '../../contexts/AuthContext';
import type { AttestationBreakdownItem } from '../../types/stir';
import {
  attestColor,
  attestLabel,
  attestDescription,
  verstatColor,
  verstatSourceColor,
  type ColorToken,
} from '../../components/stir/attestationColors';
import '../../styles/dl-admin.css';
import '../../styles/dl-platform.css';
import '../../styles/dl-platform-b.css';

// ── Light-tuned tones for the shared attestation palette ─────────────────────
// The shared `attestationColors` tokens are tuned for the dark call-detail
// surfaces; on paper we deepen each hue for contrast while keeping the exact
// semantic mapping (green/amber/red/azure/slate).
const LIGHT_TONE: Record<string, string> = {
  '#22c55e': '#16a34a', // green  (A / verstat passed)
  '#f59e0b': '#d97706', // amber  (B)
  '#ef4444': '#dc2626', // red    (verstat failed)
  '#3b82f6': '#2f7df6', // azure  (div / carrier source)
  '#94a3b8': '#64748b', // slate  (C / none)
};

function lightTone(token: ColorToken): string {
  return LIGHT_TONE[token.text] ?? token.text;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function defaultRange(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 7);
  return { start: toISODate(start), end: toISODate(end) };
}

// ── Which colour map applies to a given breakdown dimension ───────────────────

type Dimension = 'attest' | 'verstat' | 'source';

function tokenFor(dimension: Dimension, value: string | null): ColorToken {
  switch (dimension) {
    case 'attest':
      return attestColor(value);
    case 'verstat':
      return verstatColor(value);
    case 'source':
      return verstatSourceColor(value);
  }
}

function displayValue(dimension: Dimension, value: string | null): string {
  if (value === null) return '(none)';
  if (dimension === 'attest') return attestLabel(value);
  return value;
}

function subNote(dimension: Dimension, value: string | null): string | null {
  if (value === null) return 'Dimension absent for these calls';
  if (dimension === 'attest') return attestDescription(value);
  return null;
}

// ── One breakdown panel (labelled bars) ───────────────────────────────────────

interface BreakdownCardProps {
  title: string;
  hint: string;
  dimension: Dimension;
  items: AttestationBreakdownItem[];
  total: number;
}

function BreakdownCard({ title, hint, dimension, items, total }: BreakdownCardProps) {
  // Sort by count desc; keep a stable order for equal counts.
  const sorted = useMemo(
    () => [...items].sort((a, b) => b.count - a.count),
    [items],
  );
  const maxCount = sorted.reduce((m, it) => Math.max(m, it.count), 0);

  return (
    <section className="dl-panel">
      <div className="dl-panel-head">
        <h2 className="dl-panel-title">{title}</h2>
        <p className="dl-panel-sub">{hint}</p>
      </div>
      <div className="dl-panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {sorted.length === 0 && (
          <div style={{ fontSize: '0.76rem', color: 'var(--rcf-ink-dim)', padding: '4px 0' }}>
            No data in this window.
          </div>
        )}
        {sorted.map((item) => {
          const tone = lightTone(tokenFor(dimension, item.value));
          const pct = total > 0 ? (item.count / total) * 100 : 0;
          const barPct = maxCount > 0 ? (item.count / maxCount) * 100 : 0;
          const note = subNote(dimension, item.value);
          return (
            <div key={String(item.value)} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                <span
                  title={note ?? undefined}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 7,
                    fontSize: '0.78rem',
                    fontWeight: 700,
                    color: 'var(--rcf-ink)',
                  }}
                >
                  <span className="dlx4-dot" aria-hidden="true" style={{ background: tone }} />
                  {displayValue(dimension, item.value)}
                </span>
                <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, whiteSpace: 'nowrap' }}>
                  <span
                    style={{
                      fontFamily: '"Archivo", "IBM Plex Sans", sans-serif',
                      fontSize: '0.86rem',
                      fontWeight: 700,
                      color: 'var(--rcf-ink)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {item.count.toLocaleString()}
                  </span>
                  <span style={{ fontSize: '0.68rem', color: 'var(--rcf-ink-dim)', fontVariantNumeric: 'tabular-nums' }}>
                    {pct.toFixed(1)}%
                  </span>
                </span>
              </div>
              {/* Bar */}
              <div className="dl-meter">
                <div
                  className="dl-meter-fill"
                  style={{
                    width: `${barPct}%`,
                    minWidth: item.count > 0 ? 4 : 0,
                    background: tone,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function StirSummaryPage() {
  // ALL hooks unconditionally at top (rules-of-hooks — this codebase has been
  // bitten by React #310; never place hooks below early returns).
  const { isAdmin } = useAuth();
  const [range] = useState(defaultRange);
  const [startDate, setStartDate] = useState(range.start);
  const [endDate, setEndDate] = useState(range.end);
  const [customerId, setCustomerId] = useState<number | undefined>(undefined);

  const params = useMemo(
    () => ({ customer_id: customerId, start_date: startDate, end_date: endDate }),
    [customerId, startDate, endDate],
  );

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ['stir-attestation-summary', params],
    queryFn: () => getAttestationSummary(params),
    enabled: isAdmin,
    staleTime: 60_000,
    // Endpoint may not be deployed yet — degrade gracefully instead of a noisy error.
    retry: (failureCount, err) => {
      if (err instanceof ApiError && (err.status === 404 || err.status === 403 || err.status === 503)) {
        return false;
      }
      return failureCount < 2;
    },
  });

  // Customer scope — light select mirroring AdminCustomerSelector (same query
  // key + account-type filter, daylight styling).
  const { data: customersData } = useQuery({
    queryKey: ['customers-dropdown'],
    queryFn: () => listCustomers({ limit: 500 }),
    enabled: isAdmin,
    staleTime: 60_000,
  });

  const scopeCustomers = useMemo(() => {
    const accountTypes = ['rcf', 'api', 'trunk', 'hybrid'];
    return (customersData?.items ?? []).filter((c) => accountTypes.includes(c.account_type));
  }, [customersData]);

  const total = data?.total ?? 0;

  return (
    <div className="dl-stack">
      {/* ── Section identity ── */}
      <div>
        <span className="dl-tag">STIR / SHAKEN</span>
        <h2
          style={{
            fontFamily: '"Archivo", "IBM Plex Sans", sans-serif',
            fontSize: '1.02rem',
            fontWeight: 700,
            letterSpacing: '-0.015em',
            color: 'var(--rcf-ink)',
            margin: '8px 0 4px',
          }}
        >
          Attestation Coverage
        </h2>
        <p style={{ fontSize: '0.8rem', color: 'var(--rcf-ink-dim)', lineHeight: 1.55, margin: 0, maxWidth: '72ch' }}>
          Attestation coverage across signed calls — what the platform signed outbound, what
          callers arrived with, and how inbound identity was verified.
        </p>
      </div>

      {/* ── Filter slab: customer scope + date range + window total ── */}
      <section className="dl-panel">
        <div
          className="dl-panel-body"
          style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 220 }}>
            <label className="dl-flabel">Viewing</label>
            <select
              className="dl-input"
              value={customerId ?? ''}
              onChange={(e) => setCustomerId(e.target.value ? Number(e.target.value) : undefined)}
            >
              <option value="">All Customers</option>
              {scopeCustomers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.account_type.toUpperCase()})
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <label className="dl-flabel">Start Date</label>
            <input
              type="date"
              className="dl-input"
              value={startDate}
              max={endDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <label className="dl-flabel">End Date</label>
            <input
              type="date"
              className="dl-input"
              value={endDate}
              min={startDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="dl-btn dl-btn-ghost"
            onClick={() => {
              const d = defaultRange();
              setStartDate(d.start);
              setEndDate(d.end);
            }}
          >
            Last 7 days
          </button>

          {/* Total + live refresh hint */}
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div
              style={{
                fontFamily: '"Archivo", "IBM Plex Sans", sans-serif',
                fontSize: '1.7rem',
                fontWeight: 700,
                letterSpacing: '-0.01em',
                color: 'var(--rcf-ink)',
                fontVariantNumeric: 'tabular-nums',
                lineHeight: 1,
              }}
            >
              {isLoading ? '—' : total.toLocaleString()}
            </div>
            <div className="dlx4-stat-label" style={{ marginTop: 4 }}>
              {isFetching && !isLoading ? 'refreshing…' : 'attested calls'}
            </div>
          </div>
        </div>
      </section>

      {/* Loading */}
      {isLoading && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            color: 'var(--rcf-ink-dim)',
            fontSize: '0.85rem',
            padding: '32px 0',
          }}
        >
          <Spinner /> Loading attestation summary…
        </div>
      )}

      {/* Error / unavailable */}
      {isError && !isLoading && (
        <div className="dl-banner dl-banner-err">
          <span style={{ fontWeight: 700 }}>Attestation summary unavailable</span>
          {error instanceof Error && <span style={{ marginLeft: 8 }}>— {error.message}</span>}
          <div style={{ color: 'var(--rcf-ink-dim)', marginTop: 4, fontSize: '0.74rem' }}>
            This becomes available once the STIR/SHAKEN endpoint is deployed.
          </div>
        </div>
      )}

      {/* Empty (deployed, but zero rows in window) */}
      {data && !isLoading && total === 0 && (
        <div className="dl-empty">
          <p style={{ fontWeight: 600, margin: 0, color: 'var(--rcf-ink)' }}>
            No attested calls in this window
          </p>
          <p style={{ fontSize: '0.74rem', margin: '4px 0 0' }}>
            Widen the date range or clear the customer filter.
          </p>
        </div>
      )}

      {/* Breakdown grid */}
      {data && !isLoading && total > 0 && (
        <div className="dlx4-stir-grid">
          <BreakdownCard
            title="Signed Attestation"
            hint="What we signed the outbound leg with"
            dimension="attest"
            items={data.by_signed_attestation}
            total={total}
          />
          <BreakdownCard
            title="Inbound Attestation"
            hint="What the caller arrived with"
            dimension="attest"
            items={data.by_inbound_attest}
            total={total}
          />
          <BreakdownCard
            title="Inbound Verstat"
            hint="Caller verification verdict"
            dimension="verstat"
            items={data.by_inbound_verstat}
            total={total}
          />
          <BreakdownCard
            title="Verstat Source"
            hint="Carrier-supplied vs self-verified"
            dimension="source"
            items={data.by_verstat_source}
            total={total}
          />
        </div>
      )}
    </div>
  );
}
