/**
 * "Your numbers" — one row per customer number (server-sorted by calls, max
 * 500, including numbers with no calls). Shows the first 10 and expands on
 * request so a 300-number customer doesn't get a wall of rows by default.
 * The "Currently forwards to" column only appears when at least one number
 * is a call-forwarding (rcf) number.
 */
import { useState } from 'react';
import { Hash } from 'lucide-react';
import type { ReportNumbers } from '../../types/reports';
import { CardError, GradeBadge, ReportCard, Skeleton } from './ReportBits';
import { fmtCount, fmtMinutes, fmtPct, fmtPhone } from './reportFormat';

const INITIAL_ROWS = 10;

interface NumbersTableProps {
  numbers: {
    data: ReportNumbers | undefined;
    isLoading: boolean;
    error: unknown;
    refetch: () => void;
  };
}

export function NumbersTable({ numbers }: NumbersTableProps) {
  const [showAll, setShowAll] = useState(false);

  const rows = numbers.data?.numbers ?? [];
  const showForward = rows.some((r) => r.product === 'rcf');
  const visible = showAll ? rows : rows.slice(0, INITIAL_ROWS);

  return (
    <ReportCard
      title="Your numbers"
      icon={<Hash size={16} />}
      headExtra={numbers.data ? <span className="dl-count">{fmtCount(rows.length)}</span> : undefined}
      explainer={
        <>
          <p>
            Each of your phone numbers, with how many calls it had in this period, how many of those were answered,
            the total time on the phone and how clear the calls sounded.
          </p>
          {showForward && (
            <p>
              <strong>Currently forwards to</strong> is where calls to that number ring today. If you changed it
              during the period, some earlier calls may have gone elsewhere.
            </p>
          )}
        </>
      }
    >
      {numbers.isLoading && (
        <div role="status" aria-label="Loading your numbers" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} height={18} />)}
        </div>
      )}
      {!numbers.isLoading && numbers.error != null && (
        <CardError error={numbers.error} onRetry={numbers.refetch} what="your numbers" />
      )}
      {numbers.data && rows.length === 0 && (
        <div className="dl-empty">No numbers match this report.</div>
      )}
      {numbers.data && rows.length > 0 && (
        <div className="dl-panel" style={{ boxShadow: 'none' }}>
          <div className="dlx4-tablewrap">
            <table className="rpt-table" style={{ minWidth: showForward ? 760 : 620 }}>
              <caption className="rpt-sr">Calls per number</caption>
              <thead>
                <tr>
                  <th className="dl-th" scope="col">Number</th>
                  {showForward && <th className="dl-th" scope="col">Currently forwards to</th>}
                  <th className="dl-th rpt-num" scope="col">Calls</th>
                  <th className="dl-th rpt-num" scope="col">Answered</th>
                  <th className="dl-th rpt-num" scope="col">Minutes</th>
                  <th className="dl-th" scope="col">Quality</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={r.number} className="dl-row">
                    <td>
                      <span className="rpt-mono" style={{ color: 'var(--rcf-azure-deep)', fontWeight: 600 }}>{fmtPhone(r.number)}</span>
                      {r.name && <span className="rpt-subline">{r.name}</span>}
                    </td>
                    {showForward && (
                      <td>
                        {r.forwards_to ? <span className="rpt-mono">{fmtPhone(r.forwards_to)}</span> : <span className="rpt-dim">—</span>}
                      </td>
                    )}
                    <td className="rpt-num">{fmtCount(r.calls)}</td>
                    <td className="rpt-num">
                      {r.calls > 0 ? (
                        <>
                          {fmtPct(r.answer_rate_pct)}
                          <span className="rpt-subline">{fmtCount(r.answered)} of {fmtCount(r.calls)}</span>
                        </>
                      ) : (
                        <span className="rpt-dim">—</span>
                      )}
                    </td>
                    <td className="rpt-num">{r.calls > 0 ? fmtMinutes(r.minutes) : <span className="rpt-dim">—</span>}</td>
                    <td><GradeBadge grade={r.grade} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > INITIAL_ROWS && (
            <div className="rpt-table-foot">
              <button type="button" className="dl-btn dl-btn-ghost" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
                {showAll ? 'Show fewer' : `Show all ${fmtCount(rows.length)} numbers`}
              </button>
            </div>
          )}
        </div>
      )}
    </ReportCard>
  );
}
