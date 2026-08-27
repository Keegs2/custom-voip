/**
 * CdrPaginationBar — real page navigation for the CDR Search results.
 *
 * Styling: the shared DAYLIGHT CONSOLE system — reuses the compact
 * `dlx4-pgbtn` button vocabulary and adds the `dlx4-pager-*` layout classes
 * (styles/dl-platform-b.css). Rendered twice by CdrsTab — the same slim bar
 * above and below the table — so the controls are reachable both before and
 * after scanning a page (pages can be up to 500 rows tall).
 *
 * Two modes, keyed on whether the API reported a match total:
 * - `pageCount` known (API `total` deployed): full pager — First / Prev / a
 *   windowed page-number strip with ellipses (e.g. 1 … 4 5 [6] 7 8 … 85) /
 *   Next / Last, plus "Showing 1–50 of 4,231".
 * - `pageCount` unknown (legacy API, `total` not shipped yet): degraded
 *   pager — First / Prev / "Page N" / Next. `hasNext` then rides the
 *   full-page heuristic (rows == limit), so the worst case is one extra
 *   click landing on an empty page. No crash, no fake totals.
 *
 * The range readout ("Showing X–Y") describes the rows actually on screen —
 * during a keep-previous-data page transition that is the OUTGOING page,
 * which is the honest reading while the table sits dimmed.
 *
 * All controls disable while `busy` (a page is fetching) and at their bounds.
 * At narrow widths a hand-written @media swaps the number strip for a
 * compact "6 / 85" indicator (never Tailwind md:* — see CLAUDE.md).
 */
import type { ChangeEvent } from 'react';

/** Selectable page sizes — all comfortably under the API's 1000-row cap. */
const PAGE_SIZES = [50, 100, 250, 500];

/** How many page numbers to show on each side of the current page. */
const SIBLINGS = 2;

type PageToken = number | 'gap-left' | 'gap-right';

/**
 * Windowed page-number strip: first + last page always visible, a
 * constant-width window around the current page, ellipses for the gaps.
 * A gap of exactly one page collapses into that page number (never show
 * "1 … 3"). Examples (SIBLINGS = 2):
 *   pageWindow(6, 85)  → [1, 'gap-left', 4, 5, 6, 7, 8, 'gap-right', 85]
 *   pageWindow(1, 85)  → [1, 2, 3, 4, 5, 6, 'gap-right', 85]
 *   pageWindow(85, 85) → [1, 'gap-left', 80, 81, 82, 83, 84, 85]
 */
function pageWindow(current: number, count: number): PageToken[] {
  // Everything fits without ellipses: first + last + the window + the two
  // slots an ellipsis would occupy anyway.
  if (count <= SIBLINGS * 2 + 5) {
    return Array.from({ length: count }, (_, i) => i + 1);
  }

  // Constant-width window clamped to [2, count - 1], shifted at the edges so
  // the bar keeps its size as the user walks toward either end.
  let start = current - SIBLINGS;
  let end = current + SIBLINGS;
  if (start < 2) {
    end += 2 - start;
    start = 2;
  }
  if (end > count - 1) {
    start = Math.max(2, start - (end - (count - 1)));
    end = count - 1;
  }

  const tokens: PageToken[] = [1];
  if (start === 3) tokens.push(2);
  else if (start > 3) tokens.push('gap-left');
  for (let p = start; p <= end; p++) tokens.push(p);
  if (end === count - 2) tokens.push(count - 1);
  else if (end < count - 2) tokens.push('gap-right');
  tokens.push(count);
  return tokens;
}

interface CdrPaginationBarProps {
  /** 1-based page the user is on (or navigating to while `busy`). */
  page: number;
  pageSize: number;
  /** Total pages — undefined until the API's `total` field is deployed. */
  pageCount?: number;
  /** Full match count for the frozen search window, when the API reports it. */
  total?: number;
  /** 1-based index of the first row on screen (0 when the page is empty). */
  rangeStart: number;
  /** 1-based index of the last row on screen. */
  rangeEnd: number;
  /** Whether a next page exists (authoritative, or full-page heuristic). */
  hasNext: boolean;
  /** True while a page is fetching — disables every control. */
  busy: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

export function CdrPaginationBar({
  page,
  pageSize,
  pageCount,
  total,
  rangeStart,
  rangeEnd,
  hasNext,
  busy,
  onPageChange,
  onPageSizeChange,
}: CdrPaginationBarProps) {
  const atFirst = page <= 1;
  const atLast = pageCount != null ? page >= pageCount : !hasNext;

  const handleSizeChange = (e: ChangeEvent<HTMLSelectElement>) => {
    onPageSizeChange(Number(e.target.value));
  };

  return (
    <nav className="dlx4-pager" aria-label="CDR result pages">
      <span className="dlx4-pager-range" aria-live="polite">
        {rangeEnd > 0 ? (
          <>
            Showing{' '}
            <strong>
              {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()}
            </strong>
            {total != null && (
              <>
                {' '}of <strong>{total.toLocaleString()}</strong>
              </>
            )}
          </>
        ) : (
          <>No rows on this page</>
        )}
      </span>

      <div className="dlx4-pager-nav" role="group" aria-label="Page navigation">
        <button
          type="button"
          className="dlx4-pgbtn"
          disabled={busy || atFirst}
          onClick={() => onPageChange(1)}
        >
          First
        </button>
        <button
          type="button"
          className="dlx4-pgbtn"
          aria-label="Previous page"
          disabled={busy || atFirst}
          onClick={() => onPageChange(page - 1)}
        >
          Prev
        </button>

        {pageCount != null ? (
          <>
            <span className="dlx4-pg-nums">
              {pageWindow(page, pageCount).map((token) =>
                typeof token === 'number' ? (
                  <button
                    key={token}
                    type="button"
                    className={
                      token === page
                        ? 'dlx4-pgbtn dlx4-pgnum dlx4-pgbtn-active'
                        : 'dlx4-pgbtn dlx4-pgnum'
                    }
                    aria-label={`Page ${token}`}
                    aria-current={token === page ? 'page' : undefined}
                    disabled={busy || token === page}
                    onClick={() => onPageChange(token)}
                  >
                    {token.toLocaleString()}
                  </button>
                ) : (
                  <span key={token} className="dlx4-pg-gap" aria-hidden="true">
                    …
                  </span>
                ),
              )}
            </span>
            {/* Narrow-width stand-in for the number strip (shown via @media) */}
            <span className="dlx4-pg-compact" aria-hidden="true">
              {page.toLocaleString()} / {pageCount.toLocaleString()}
            </span>
          </>
        ) : (
          <span className="dlx4-pg-cur">Page {page.toLocaleString()}</span>
        )}

        <button
          type="button"
          className="dlx4-pgbtn"
          aria-label="Next page"
          disabled={busy || atLast}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </button>
        {pageCount != null && (
          <button
            type="button"
            className="dlx4-pgbtn"
            disabled={busy || atLast}
            onClick={() => onPageChange(pageCount)}
          >
            Last
          </button>
        )}
      </div>

      <label className="dlx4-pgsize-label">
        <select
          className="dlx4-pgsize"
          value={pageSize}
          disabled={busy}
          aria-label="Rows per page"
          onChange={handleSizeChange}
        >
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
        per page
      </label>
    </nav>
  );
}
