/**
 * "Your numbers" — one row per customer number, every product (server-sorted
 * by calls, max 500, including numbers with no calls). Shows the first 8
 * (docker/ui/CLAUDE.md §20.3) and "Show all N numbers" opens the rest INSIDE
 * a scroll capped at about the 8-row height (sticky column heads), so a
 * 300-number customer never gets a wall of rows pushing the call list away.
 * A new report (period / numbers) remounts the card and collapses it. The
 * "Currently forwards to" column only appears when at least one number is a
 * call-forwarding (rcf) number; a number of any other product names it
 * under the number ("Front desk · Voicemail").
 */
import { Hash } from 'lucide-react';
import { ShowMoreButton, useShowMore } from '../../components/layout/kit';
import type { ReportNumbers } from '../../types/reports';
import { CardError, GradeBadge, ReportCard, Skeleton } from './ReportBits';
import { nameWithProduct } from '../../config/products';
import { fmtCount, fmtMinutes, fmtPct, fmtPhone } from './reportFormat';
import { T } from '../../styles/theme';

const INITIAL_ROWS = 8;

interface NumbersTableProps {
  numbers: {
    data: ReportNumbers | undefined;
    isLoading: boolean;
    error: unknown;
    refetch: () => void;
  };
}

const NO_ROWS: ReportNumbers['numbers'] = [];

export function NumbersTable({ numbers }: NumbersTableProps) {
  // ALL hooks unconditionally at the top (React #310 prevention).
  const rows = numbers.data?.numbers ?? NO_ROWS;
  const more = useShowMore(rows, INITIAL_ROWS);
  const showForward = rows.some((r) => r.product === 'rcf');

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
          <div className={more.expanded ? 'dlx4-tablewrap rpt-tablewrap-cap' : 'dlx4-tablewrap'}>
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
              <tbody id={more.listId}>
                {more.visible.map((r) => {
                  const subline = nameWithProduct(r.name, r.product);
                  return (
                  <tr key={r.number} className="dl-row">
                    <td>
                      <span className="rpt-mono" style={{ color: T.accentText, fontWeight: 600 }}>{fmtPhone(r.number)}</span>
                      {subline && <span className="rpt-subline">{subline}</span>}
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
                  );
                })}
              </tbody>
            </table>
          </div>
          {more.needed && <ShowMoreButton {...more.buttonProps} noun="numbers" variant="bar" />}
        </div>
      )}
    </ReportCard>
  );
}
