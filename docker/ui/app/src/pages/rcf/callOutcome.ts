/**
 * callOutcome.ts — how one call reads to a customer: its outcome word
 * (Answered / Voicemail / No Answer / Busy …) and its quality word, both
 * with tones.
 * Shared by the Call Activity table and the dashboard's Recent calls card so
 * the two never disagree. Moved verbatim from RecentCallsTable.
 *
 * Quality words and colours come only from pages/calls/quality.ts.
 */
import type { Cdr } from '../../types/cdr';
import { hasTalkTime } from '../../utils/callDuration';
import { gradeColor, gradeLabel, qualityStatusReason, qualityStatusShort } from '../calls/quality';
import { AZURE_DEEP, GREEN, INK_FAINT, INK_SOFT, RED } from './theme';

// ─── Call quality label (the ONE grade definition — pages/calls/quality.ts) ───

export interface CallQualityLabel {
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
export function callQualityLabel(cdr: Cdr): CallQualityLabel {
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

export function callStatusInfo(cdr: Cdr): { label: string; bg: string; color: string; border: string } {
  const GOOD    = { bg: 'rgba(22,163,74,0.1)',   color: GREEN,    border: '1px solid rgba(22,163,74,0.24)' };
  const NEUTRAL = { bg: 'rgba(93,111,140,0.1)',  color: INK_SOFT, border: '1px solid rgba(93,111,140,0.24)' };
  const BAD     = { bg: 'rgba(220,38,38,0.07)',  color: RED,      border: '1px solid rgba(220,38,38,0.22)' };
  const INFO    = { bg: 'rgba(47,125,246,0.09)', color: AZURE_DEEP, border: '1px solid rgba(47,125,246,0.24)' };

  const cause = (cdr.hangup_cause ?? '').toUpperCase();

  // A call voicemail picked up (the mailbox answers to play the greeting):
  // it counts as answered everywhere (owner decision O2), but the customer
  // should see that a mailbox — not a person — took it. Checked before the
  // talk-time test so a hang-up during the greeting still reads Voicemail.
  if (cdr.product_type === 'voicemail' && cdr.answer_time != null) {
    return { label: 'Voicemail', ...INFO };
  }

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
