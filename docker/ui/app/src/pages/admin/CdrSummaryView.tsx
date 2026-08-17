/**
 * CdrSummaryView — grouped CDR summary (day / hour / destination).
 *
 * Styling: the shared DAYLIGHT CONSOLE system — `dlx-seg` group-by control
 * (dl-admin.css) and a white `dl-panel` table. The summary query, grouping
 * options, and ASR thresholds are unchanged (thresholds keep their
 * green/amber/red semantics in light-tuned tones).
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getCdrSummary } from '../../api/cdrs';
import { Spinner } from '../../components/ui/Spinner';
import type { CdrSummaryRow } from '../../types/rate';

type GroupBy = 'day' | 'hour' | 'destination';

function formatTotalDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function asrColor(asr: number): string {
  if (asr > 50) return 'var(--rcf-green)';
  if (asr >= 30) return '#b45309';
  return 'var(--rcf-red)';
}

function groupLabel(row: CdrSummaryRow, groupBy: GroupBy): string {
  if (groupBy === 'hour') return row.hour ?? '--';
  if (groupBy === 'destination') return row.destination ?? '--';
  return row.date ?? '--';
}

interface CdrSummaryViewProps {
  customerId?: string;
}

export function CdrSummaryView({ customerId }: CdrSummaryViewProps) {
  const [groupBy, setGroupBy] = useState<GroupBy>('day');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['cdr-summary', { customerId, groupBy }],
    queryFn: () =>
      getCdrSummary({
        customer_id: customerId ? Number(customerId) : undefined,
        group_by: groupBy,
      }),
  });

  const dateColLabel =
    groupBy === 'hour' ? 'Hour' : groupBy === 'destination' ? 'Destination' : 'Date';

  return (
    <div className="dl-stack">
      {/* Group by selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="dl-flabel" style={{ marginBottom: 0 }}>Group by</span>
        <div className="dlx-seg" role="tablist" aria-label="Summary grouping">
          {(['day', 'hour', 'destination'] as GroupBy[]).map((g) => (
            <button
              key={g}
              type="button"
              role="tab"
              aria-selected={groupBy === g}
              className={groupBy === g ? 'dlx-seg-btn dlx-seg-btn-active' : 'dlx-seg-btn'}
              onClick={() => setGroupBy(g)}
            >
              {g.charAt(0).toUpperCase() + g.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {isLoading && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            color: 'var(--rcf-ink-dim)',
            fontSize: '0.85rem',
            padding: '24px 0',
          }}
        >
          <Spinner /> Loading summary…
        </div>
      )}

      {isError && (
        <div className="dl-banner dl-banner-err">Failed to load summary data.</div>
      )}

      {data && data.summary.length === 0 && (
        <div className="dl-empty">
          <p style={{ fontWeight: 600, margin: 0, color: 'var(--rcf-ink)' }}>No summary data</p>
          <p style={{ fontSize: '0.74rem', margin: '4px 0 0' }}>
            Run a search first, then switch to this tab.
          </p>
        </div>
      )}

      {data && data.summary.length > 0 && (
        <section className="dl-panel">
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
              <thead>
                <tr>
                  <th className="dl-th">{dateColLabel}</th>
                  <th className="dl-th">Product</th>
                  <th className="dl-th">Direction</th>
                  <th className="dl-th">Total Calls</th>
                  <th className="dl-th">Answered</th>
                  <th className="dl-th">ASR</th>
                  <th className="dl-th">Duration</th>
                  <th className="dl-th">Total Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.summary.map((row, i) => {
                  const asr =
                    row.total_calls > 0
                      ? (row.answered_calls / row.total_calls) * 100
                      : 0;

                  return (
                    <tr key={i} className="dl-row">
                      <td className="dlx-td">
                        <span className="dlx4-mono" style={{ color: 'var(--rcf-ink)' }}>
                          {groupLabel(row, groupBy)}
                        </span>
                      </td>
                      <td className="dlx-td">
                        {row.product_type ? (
                          <span className="dl-tag">{row.product_type.toUpperCase()}</span>
                        ) : (
                          <span style={{ color: 'var(--rcf-ink-dim)' }}>--</span>
                        )}
                      </td>
                      <td className="dlx-td">
                        {row.direction ? (
                          <span className={row.direction === 'inbound' ? 'dl-tag' : 'dl-tag dl-tag-slate'}>
                            {row.direction}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--rcf-ink-dim)' }}>--</span>
                        )}
                      </td>
                      <td className="dlx-td">
                        <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--rcf-ink)' }}>
                          {row.total_calls.toLocaleString()}
                        </span>
                      </td>
                      <td className="dlx-td">
                        <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--rcf-ink)' }}>
                          {row.answered_calls.toLocaleString()}
                        </span>
                      </td>
                      <td className="dlx-td">
                        <span
                          style={{
                            fontVariantNumeric: 'tabular-nums',
                            fontWeight: 600,
                            color: asrColor(asr),
                          }}
                        >
                          {asr.toFixed(1)}%
                        </span>
                      </td>
                      <td className="dlx-td">
                        <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--rcf-ink)' }}>
                          {formatTotalDuration(row.total_duration_sec)}
                        </span>
                      </td>
                      <td className="dlx-td">
                        <span
                          style={{
                            fontVariantNumeric: 'tabular-nums',
                            fontWeight: 600,
                            color: 'var(--rcf-azure-deep)',
                          }}
                        >
                          ${row.total_cost.toFixed(4)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
