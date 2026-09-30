/**
 * RecentCallsTable — the Call Activity tab's call log for the selected
 * range + DID, server-paginated through GET /cdrs (newest first).
 *
 * The Time column is an ABSOLUTE local date-time with seconds
 * ("Sep 30, 2026, 2:14:07 PM") — customers reconcile these against their
 * own records, so a relative "5m ago" is not good enough. The zone
 * abbreviation is shown once in the header; if the visible page straddles
 * a DST change (two abbreviations), each cell carries its own instead.
 *
 * Status / quality helpers moved here verbatim from RcfPage (they were
 * only ever used by this table).
 */
import type { Cdr } from '../../types/cdr';
import { Spinner } from '../../components/ui/Spinner';
import { fmt } from '../../utils/format';
import { hasTalkTime } from '../../utils/callDuration';
import { gradeColor, gradeLabel, qualityStatusReason, qualityStatusShort } from '../calls/quality';
import { AZURE_DEEP, GREEN, INK_DIM, INK_FAINT, INK_SOFT, MONO, RED } from './theme';
import { fmtCallDateTime, tzAbbrev } from './activityFormat';
import { PaginationControls } from './PaginationControls';

// ─── Call quality label (the ONE grade definition — pages/calls/quality.ts) ───

interface CallQualityLabel {
  /** Great / Good / Fair / Poor / One-way, or null when the call wasn't graded. */
  text: string | null;
  color: string;
  /** Plain-language explanation (why not graded / what one-way means). */
  reason: string | null;
  /** Short reason for the table cell when not graded ("under 5 sec"). */
  short: string | null;
}

/**
 * The call's grade = the WORSE of the two audio directions
 * (`call_quality_grade`). One-way audio reads "One-way" in red — never a
 * perfect score for a call nobody could hear.
 */
function callQualityLabel(cdr: Cdr): CallQualityLabel {
  const grade = cdr.call_quality_grade ?? null;
  const status = cdr.call_quality_status ?? null;
  if (grade == null) {
    return {
      text: null,
      color: INK_FAINT,
      reason: qualityStatusReason(status, 'customer'),
      short: qualityStatusShort(status),
    };
  }
  return {
    text: gradeLabel(grade, status),
    color: gradeColor(grade),
    reason: status === 'no_rtp' ? qualityStatusReason(status, 'customer') : null,
    short: null,
  };
}

function carrierDisplayName(carrier: string | null | undefined): string {
  if (!carrier) return '—';
  switch (carrier) {
    case 'carrier_primary': return 'Bandwidth Dallas';
    case 'carrier_secondary': return 'Bandwidth LA';
    default: return carrier.replace(/^carrier_/, '').replace(/_/g, ' ');
  }
}

function callStatusInfo(cdr: Cdr): { label: string; bg: string; color: string; border: string } {
  const GOOD    = { bg: 'rgba(22,163,74,0.1)',   color: GREEN,    border: '1px solid rgba(22,163,74,0.24)' };
  const NEUTRAL = { bg: 'rgba(93,111,140,0.1)',  color: INK_SOFT, border: '1px solid rgba(93,111,140,0.24)' };
  const BAD     = { bg: 'rgba(220,38,38,0.07)',  color: RED,      border: '1px solid rgba(220,38,38,0.22)' };
  const INFO    = { bg: 'rgba(47,125,246,0.09)', color: AZURE_DEEP, border: '1px solid rgba(47,125,246,0.24)' };

  const cause = (cdr.hangup_cause ?? '').toUpperCase();

  // Answered calls (has answer_time and non-zero duration — exact seconds on
  // staff rows, whole minutes on tenant rows; see utils/callDuration.ts)
  if (cdr.answer_time != null && hasTalkTime(cdr)) {
    return { label: 'Answered', ...GOOD };
  }

  // Map specific hangup causes to friendly labels
  switch (cause) {
    case 'ORIGINATOR_CANCEL':
      return { label: 'Caller Hung Up', ...NEUTRAL };
    case 'NO_ANSWER':
      return { label: 'No Answer', ...NEUTRAL };
    case 'USER_BUSY':
      return { label: 'Busy', ...BAD };
    case 'CALL_REJECTED':
      return { label: 'Rejected', ...BAD };
    case 'NORMAL_TEMPORARY_FAILURE':
      return { label: 'Unavailable', ...BAD };
    case 'UNALLOCATED_NUMBER':
      return { label: 'Invalid Number', ...BAD };
    case 'NO_ROUTE_DESTINATION':
      return { label: 'No Route', ...BAD };
    case 'RECOVERY_ON_TIMER_EXPIRE':
      return { label: 'Timed Out', ...BAD };
    case 'NORMAL_CLEARING':
      if (cdr.answer_time == null) return { label: 'Not Connected', ...NEUTRAL };
      return { label: 'Answered', ...GOOD };
    default:
      break;
  }

  // SIP error codes
  if (cdr.sip_code != null && cdr.sip_code >= 400) {
    if (cdr.sip_code === 486) return { label: 'Busy', ...BAD };
    if (cdr.sip_code === 487) return { label: 'Cancelled', ...NEUTRAL };
    if (cdr.sip_code === 603) return { label: 'Declined', ...BAD };
    return { label: 'Failed', ...BAD };
  }

  // Fallback: no answer_time and zero duration = never connected
  if (cdr.answer_time == null) {
    return { label: 'No Answer', ...NEUTRAL };
  }

  return { label: 'Answered', ...INFO };
}

// ─── RecentCallsTable ─────────────────────────────────────────────────────────

export interface RecentCallsTableProps {
  /** Rows of the current page (already server-filtered by range + DID). */
  rows: Cdr[];
  /** Full match count from GET /cdrs `total` (undefined on pre-total APIs). */
  total: number | undefined;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  /** No page loaded yet (first fetch, or the window is still resolving). */
  loading: boolean;
  /** A newer page / range is loading over the rows on screen. */
  refreshing: boolean;
  isError: boolean;
  onRetry: () => void;
  /** Staff only — carrier routing is a platform internal. */
  showCarrier: boolean;
  /** Selected DID label for the header chip (null = all numbers). */
  selectedLabel: string | null;
  /** "Last 7 days" — header context. */
  rangeTitle: string;
  search: string;
  onSearchChange: (value: string) => void;
}

export function RecentCallsTable({
  rows,
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  loading,
  refreshing,
  isError,
  onRetry,
  showCarrier,
  selectedLabel,
  rangeTitle,
  search,
  onSearchChange,
}: RecentCallsTableProps) {
  // The search box narrows the page on screen (GET /cdrs has no free-text
  // filter); the DID + range filters are server-side and span every page.
  const q = search.trim().toLowerCase();
  const visible = q
    ? rows.filter((c) =>
        [
          c.caller_id,
          c.destination,
          c.hangup_cause,
          c.carrier_used,
          c.sip_code?.toString(),
          fmt(c.caller_id),
          fmt(c.destination),
          fmtCallDateTime(c.start_time),
        ].some((f) => f != null && f.toLowerCase().includes(q)),
      )
    : rows;

  // One zone abbreviation for the page → header; two (DST boundary) → per cell.
  const zones = new Set(visible.map((c) => tzAbbrev(c.start_time)).filter(Boolean));
  const headerZone = zones.size === 1 ? [...zones][0] : zones.size === 0 ? tzAbbrev(new Date().toISOString()) : null;

  // Pre-`total` APIs: infer "there is another page" from a full page.
  const knownTotal = total ?? (page - 1) * pageSize + rows.length + (rows.length === pageSize ? 1 : 0);
  const totalPages = Math.max(1, Math.ceil(knownTotal / pageSize));
  const headers = [
    headerZone ? `Time (${headerZone})` : 'Time',
    'From',
    'To (DID)',
    ...(showCarrier ? ['Carrier Trunk'] : []),
    'Status',
    'Quality',
  ];

  return (
    <div className="rcf-panel">
      <div className="rcf-panel-head">
        <span className="rcf-panel-title">Recent Calls</span>
        <span className="rcf-act-chip">{rangeTitle}</span>
        {selectedLabel && <span className="rcf-act-chip rcf-act-chip-did">{selectedLabel}</span>}
        <div className="rcf-act-search">
          <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
          </svg>
          <input
            type="text"
            className="rcf-input"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Filter this page by number, time, cause…"
            aria-label="Filter the calls on this page"
          />
        </div>
        {total !== undefined && !loading && !isError && (
          <span className="rcf-count">
            {q ? `${visible.length} of ${rows.length} on page · ` : ''}
            {total.toLocaleString()} call{total === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {isError ? (
        <div className="rcf-act-state rcf-act-state-error" role="alert">
          Unable to load calls for this range.
          <button type="button" className="rcf-btn rcf-btn-ghost" onClick={onRetry}>Try again</button>
        </div>
      ) : loading ? (
        <div className="rcf-act-state">
          <Spinner size="sm" />
          <span>Loading calls…</span>
        </div>
      ) : rows.length === 0 ? (
        <div className="rcf-act-state">No calls in this range{selectedLabel ? ' for this number' : ''}.</div>
      ) : (
        <>
          <div className={`rcf-act-tablewrap${refreshing ? ' rcf-act-busy' : ''}`}>
            <table className="rcf-act-table">
              <thead>
                <tr>
                  {headers.map((h) => (
                    <th key={h} className="rcf-th" style={{ padding: '11px 14px' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((cdr) => {
                  const status = callStatusInfo(cdr);
                  const quality = callQualityLabel(cdr);
                  return (
                    <tr key={cdr.uuid} className="rcf-row">
                      {/* Time — absolute, local, seconds included */}
                      <td className="rcf-act-td rcf-act-time">
                        <time dateTime={cdr.start_time}>
                          {fmtCallDateTime(cdr.start_time)}
                          {!headerZone && <span className="rcf-act-tz"> {tzAbbrev(cdr.start_time)}</span>}
                        </time>
                      </td>

                      {/* From */}
                      <td className="rcf-act-td">
                        <span style={{ fontSize: '0.82rem', color: INK_SOFT, fontFamily: MONO, fontWeight: 500 }}>
                          {fmt(cdr.caller_id)}
                        </span>
                      </td>

                      {/* To (DID) */}
                      <td className="rcf-act-td">
                        <span style={{ fontSize: '0.82rem', color: AZURE_DEEP, fontFamily: MONO, fontWeight: 600 }}>
                          {fmt(cdr.destination)}
                        </span>
                      </td>

                      {/* Carrier Trunk — staff only */}
                      {showCarrier && (
                        <td className="rcf-act-td">
                          <span style={{ fontSize: '0.78rem', color: INK_DIM }}>
                            {carrierDisplayName(cdr.carrier_used)}
                          </span>
                        </td>
                      )}

                      {/* Status badge */}
                      <td className="rcf-act-td">
                        <span
                          className="rcf-act-status"
                          style={{ color: status.color, background: status.bg, border: status.border }}
                        >
                          {status.label}
                        </span>
                      </td>

                      {/* Quality — call grade (worse direction), or "Not rated" + why */}
                      <td className="rcf-act-td">
                        {quality.text != null ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} title={quality.reason ?? undefined}>
                            <span className="rcf-act-qdot" style={{ background: quality.color }} />
                            <span style={{ fontSize: '0.72rem', color: quality.color, fontWeight: 600 }}>
                              {quality.text}
                            </span>
                          </div>
                        ) : (
                          <span
                            style={{ fontSize: '0.72rem', color: INK_FAINT, whiteSpace: 'nowrap' }}
                            title={quality.reason ?? undefined}
                          >
                            Not rated{quality.short ? ` · ${quality.short}` : ''}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={headers.length} className="rcf-act-td" style={{ textAlign: 'center', color: INK_DIM, fontSize: '0.8rem' }}>
                      No calls on this page match &ldquo;{search.trim()}&rdquo;.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {knownTotal > pageSize && (
            <PaginationControls
              currentPage={page}
              totalPages={totalPages}
              pageSize={pageSize}
              totalItems={knownTotal}
              onPageChange={onPageChange}
              onPageSizeChange={onPageSizeChange}
            />
          )}
        </>
      )}
    </div>
  );
}
