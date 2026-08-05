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
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getAttestationSummary } from '../../api/stir';
import { ApiError } from '../../api/client';
import { AdminCustomerSelector } from '../../components/AdminCustomerSelector';
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

const ACCENT = '#3b82f6';

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

// ── One breakdown card (labelled bars) ────────────────────────────────────────

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
    <div
      className="glass-surface glass-hover"
      style={{ padding: '20px 22px', position: 'relative', overflow: 'hidden' }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 24,
          right: 24,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${ACCENT}99, transparent)`,
        }}
      />
      <div style={{ marginBottom: 4 }}>
        <div
          style={{
            fontSize: '0.7rem',
            fontWeight: 700,
            color: '#e2e8f0',
            letterSpacing: '0.02em',
          }}
        >
          {title}
        </div>
        <div style={{ fontSize: '0.64rem', color: '#4a5568', marginTop: 2 }}>{hint}</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
        {sorted.length === 0 && (
          <div style={{ fontSize: '0.72rem', color: '#4a5568', padding: '6px 0' }}>
            No data in this window.
          </div>
        )}
        {sorted.map((item) => {
          const token = tokenFor(dimension, item.value);
          const pct = total > 0 ? (item.count / total) * 100 : 0;
          const barPct = maxCount > 0 ? (item.count / maxCount) * 100 : 0;
          const note = subNote(dimension, item.value);
          return (
            <div key={String(item.value)} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                <span
                  title={note ?? undefined}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: '0.72rem',
                    fontWeight: 700,
                    color: token.text,
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 3,
                      background: token.text,
                      boxShadow: `0 0 6px ${token.text}66`,
                      flexShrink: 0,
                    }}
                  />
                  {displayValue(dimension, item.value)}
                </span>
                <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, whiteSpace: 'nowrap' }}>
                  <span
                    style={{
                      fontSize: '0.82rem',
                      fontWeight: 800,
                      color: '#e2e8f0',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {item.count.toLocaleString()}
                  </span>
                  <span style={{ fontSize: '0.66rem', color: '#4a5568', fontVariantNumeric: 'tabular-nums' }}>
                    {pct.toFixed(1)}%
                  </span>
                </span>
              </div>
              {/* Bar */}
              <div
                style={{
                  height: 6,
                  borderRadius: 4,
                  background: 'rgba(42,47,69,0.5)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${barPct}%`,
                    minWidth: item.count > 0 ? 4 : 0,
                    background: `linear-gradient(90deg, ${token.text}cc, ${token.text})`,
                    borderRadius: 4,
                    transition: 'width 0.4s ease',
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
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

  const total = data?.total ?? 0;

  const dateInputStyle: React.CSSProperties = {
    fontSize: '0.8rem',
    padding: '7px 10px',
    borderRadius: 8,
    border: '1px solid rgba(59,130,246,0.18)',
    background: 'rgba(15,17,23,0.6)',
    color: '#e2e8f0',
    outline: 'none',
    colorScheme: 'dark',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '0.6rem',
    fontWeight: 700,
    color: '#4a5568',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: 6,
    display: 'block',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, paddingBottom: 32 }}>

      {/* Intro / description */}
      <div
        className="glass-surface"
        style={{ padding: '18px 22px', position: 'relative', overflow: 'hidden' }}
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 24,
            right: 24,
            height: 2,
            background: `linear-gradient(90deg, transparent, ${ACCENT}, transparent)`,
            opacity: 0.55,
          }}
        />
        <div
          style={{
            fontSize: '0.58rem',
            fontWeight: 700,
            color: ACCENT,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginBottom: 6,
          }}
        >
          STIR / SHAKEN
        </div>
        <div style={{ fontSize: '0.82rem', color: '#94a3b8', lineHeight: 1.5, maxWidth: 640 }}>
          Attestation coverage across signed calls — what the platform signed outbound, what
          callers arrived with, and how inbound identity was verified.
        </div>
      </div>

      {/* Filter bar: customer + date range */}
      <AdminCustomerSelector
        selectedCustomerId={customerId}
        onSelect={setCustomerId}
        accountTypes={['rcf', 'api', 'trunk', 'hybrid']}
      />

      <div
        className="glass-surface"
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 16,
          flexWrap: 'wrap',
          padding: '16px 20px',
          borderRadius: 12,
        }}
      >
        <div>
          <label style={labelStyle}>Start Date</label>
          <input
            type="date"
            value={startDate}
            max={endDate}
            onChange={(e) => setStartDate(e.target.value)}
            style={dateInputStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>End Date</label>
          <input
            type="date"
            value={endDate}
            min={startDate}
            onChange={(e) => setEndDate(e.target.value)}
            style={dateInputStyle}
          />
        </div>
        <button
          type="button"
          onClick={() => {
            const d = defaultRange();
            setStartDate(d.start);
            setEndDate(d.end);
          }}
          style={{
            fontSize: '0.72rem',
            fontWeight: 600,
            padding: '7px 14px',
            borderRadius: 8,
            border: '1px solid rgba(59,130,246,0.25)',
            background: 'rgba(59,130,246,0.08)',
            color: '#60a5fa',
            cursor: 'pointer',
          }}
        >
          Last 7 days
        </button>

        {/* Total + live refresh hint */}
        <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
          <div
            style={{
              fontSize: '1.9rem',
              fontWeight: 800,
              color: '#e2e8f0',
              fontVariantNumeric: 'tabular-nums',
              lineHeight: 1,
            }}
          >
            {isLoading ? '—' : total.toLocaleString()}
          </div>
          <div style={{ fontSize: '0.62rem', color: '#4a5568', marginTop: 3 }}>
            {isFetching && !isLoading ? 'refreshing…' : 'attested calls'}
          </div>
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#718096', padding: '32px 0' }}>
          <Spinner /> Loading attestation summary…
        </div>
      )}

      {/* Error / unavailable */}
      {isError && !isLoading && (
        <div
          style={{
            padding: '16px 20px',
            borderRadius: 12,
            background: 'rgba(127,29,29,0.22)',
            border: '1px solid rgba(239,68,68,0.28)',
            color: '#fca5a5',
            fontSize: '0.82rem',
          }}
        >
          <span style={{ fontWeight: 700 }}>Attestation summary unavailable</span>
          {error instanceof Error && (
            <span style={{ color: '#f87171', marginLeft: 8 }}>— {error.message}</span>
          )}
          <div style={{ color: '#94a3b8', marginTop: 4, fontSize: '0.74rem' }}>
            This becomes available once the STIR/SHAKEN endpoint is deployed.
          </div>
        </div>
      )}

      {/* Empty (deployed, but zero rows in window) */}
      {data && !isLoading && total === 0 && (
        <div
          className="glass-surface"
          style={{ textAlign: 'center', padding: '40px 24px', borderRadius: 16, color: '#718096' }}
        >
          <p style={{ fontWeight: 600, color: '#e2e8f0', marginBottom: 6 }}>
            No attested calls in this window
          </p>
          <p style={{ fontSize: '0.82rem' }}>
            Widen the date range or clear the customer filter.
          </p>
        </div>
      )}

      {/* Breakdown grid */}
      {data && !isLoading && total > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: 18,
          }}
        >
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
