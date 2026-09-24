/**
 * The ELI5 header sentence, built client-side from `/reports/overview`.
 *
 * Returned as segments (`strong` marks the emphasized figures) so the page
 * can bold them and the PDF can render the same words as plain text — one
 * source of wording, two renderers.
 *
 * Examples:
 *   "You got 1,204 calls in August. 96 of every 100 were answered. Call
 *    quality was great. That's 12% more calls than July."
 *   "You had 40 calls so far in September (31 coming in, 9 going out).
 *    Every call was answered. …"
 *   "No calls yet in this period."
 */
import type { ReportOverview } from '../../types/reports';
import {
  honestWhole,
  periodPhrase,
  plural,
  previousPeriodLabel,
  type DateRange,
  type PeriodPreset,
} from './reportFormat';

export interface SentenceSegment {
  text: string;
  strong?: boolean;
}

/** Below this many calls, "N of every 100" reads oddly — use "2 of 3". */
const SMALL_SAMPLE = 20;

export function buildSummarySentence(
  overview: ReportOverview,
  preset: PeriodPreset,
  range: DateRange,
  filteredToNumbers: boolean,
): SentenceSegment[] {
  const { totals, quality } = overview;
  const when = periodPhrase(preset, range);
  const out: SentenceSegment[] = [];

  if (totals.calls === 0) {
    out.push({
      text: filteredToNumbers
        ? `No calls yet on the numbers you picked ${when}.`
        : `No calls yet ${when}.`,
    });
    return out;
  }

  // ── How many ──
  if (totals.outbound === 0) {
    out.push({ text: 'You got ' }, { text: plural(totals.calls, 'call', 'calls'), strong: true }, { text: ` ${when}.` });
  } else if (totals.inbound === 0) {
    out.push({ text: 'You made ' }, { text: plural(totals.calls, 'call', 'calls'), strong: true }, { text: ` ${when}.` });
  } else {
    out.push(
      { text: 'You had ' },
      { text: plural(totals.calls, 'call', 'calls'), strong: true },
      { text: ` ${when} (${totals.inbound.toLocaleString()} coming in, ${totals.outbound.toLocaleString()} going out).` },
    );
  }

  // ── How many were answered ──
  if (totals.answered === totals.calls) {
    out.push({ text: ' ' }, { text: totals.calls === 1 ? 'It was answered.' : 'Every call was answered.', strong: true });
  } else if (totals.answered === 0) {
    out.push({ text: ' ' }, { text: totals.calls === 1 ? 'It wasn’t answered.' : 'None were answered.', strong: true });
  } else if (totals.calls < SMALL_SAMPLE || totals.answer_rate_pct == null) {
    out.push(
      { text: ' ' },
      { text: `${totals.answered.toLocaleString()} of ${totals.calls.toLocaleString()}`, strong: true },
      { text: ' were answered.' },
    );
  } else {
    out.push(
      { text: ' ' },
      { text: `${honestWhole(totals.answer_rate_pct)} of every 100`, strong: true },
      { text: ' were answered.' },
    );
  }

  // ── How it sounded ──
  if (quality.grade !== 'none') {
    out.push({ text: ' Call quality was ' }, { text: quality.grade, strong: true }, { text: '.' });
  }

  // ── Compared with before ──
  const comparison = compareWithPrevious(overview);
  if (comparison) out.push({ text: ` ${comparison}` });

  return out;
}

/** "That's 12% more calls than July." — or null when there's nothing fair to compare. */
function compareWithPrevious(overview: ReportOverview): string | null {
  const prev = overview.previous_period;
  if (!prev || prev.calls == null || prev.calls === 0) return null;
  // Don't compare against a period we only partly have history for.
  if (overview.data_available_from && prev.start < overview.data_available_from) return null;

  const label = previousPeriodLabel(prev.start, prev.end, overview.period.start);
  const change = ((overview.totals.calls - prev.calls) / prev.calls) * 100;
  const whole = Math.round(Math.abs(change));
  if (whole < 1) return `That’s about the same number of calls as ${label}.`;
  return `That’s ${whole.toLocaleString()}% ${change > 0 ? 'more' : 'fewer'} calls than ${label}.`;
}

/** Plain-text rendering (PDF, aria). */
export function sentenceText(segments: SentenceSegment[]): string {
  return segments.map((s) => s.text).join('');
}
