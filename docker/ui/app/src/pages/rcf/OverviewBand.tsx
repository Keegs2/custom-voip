/**
 * OverviewBand — the dashboard's one bold element: a granite panel carrying
 * the account identity and a segmented readout of the account's key figures.
 *
 *   Granite Crag      ● Active account   Customer since March 2026   [Request numbers]
 *   ─────────────────────────────────────────────────────────────────────────────
 *   32 numbers │ 31 forwarding · 1 paused │ 1,284 calls │ 96.4% answered │ 98% sounded good │ 4 team members
 *
 * Every segment renders on its own: a feed that is still loading shows a
 * quiet placeholder, one that failed shows "—" with the reason on hover, so
 * one slow endpoint never blanks the whole band. Quality tone comes only
 * from quality.ts (goodShareColor) and always travels with a word.
 */
import type { CSSProperties, ReactNode } from 'react';
import type { CustomerStatus } from '../../types/customer';
import type { CdrActivityKpis } from '../../types/cdrActivity';
import { BAD, GOOD, WARN, goodShareColor } from '../calls/quality';
import { fmtPct1, fmtShareFloor } from './activityFormat';

/** A feed's state as the band needs it. */
export type Feed<T> =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; value: T };

export interface NumberCounts {
  total: number;
  forwarding: number;
  paused: number;
  /** True when /rcf hit its row cap, so forwarding/paused cover a subset. */
  partial: boolean;
}

export interface OverviewBandProps {
  name: string;
  status: CustomerStatus | null;
  since: string | null;
  numbers: Feed<NumberCounts>;
  activity: Feed<CdrActivityKpis>;
  teamSize: Feed<number>;
  /** Primary action label, or null to hide it. */
  actionLabel: string | null;
  onAction: () => void;
  onRetryActivity: () => void;
}

const STATUS_WORD: Record<CustomerStatus, string> = {
  active: 'Active account',
  suspended: 'Account suspended',
  closed: 'Account closed',
};

/** The words for a good-share tone — mapped from the colour quality.ts picks,
 *  so the thresholds live in exactly one place. */
function shareWord(color: string): string {
  if (color === GOOD) return 'Healthy';
  if (color === WARN) return 'Worth a look';
  if (color === BAD) return 'Needs attention';
  return '';
}

interface SegmentProps {
  label: string;
  title?: string;
  children: ReactNode;
  wide?: boolean;
}

function Segment({ label, title, children, wide }: SegmentProps) {
  return (
    <div className={`rcfd-seg${wide ? ' rcfd-seg-wide' : ''}`} title={title}>
      <div className="rcfd-seg-value">{children}</div>
      <div className="rcfd-seg-label">{label}</div>
    </div>
  );
}

function Placeholder({ state }: { state: 'loading' | 'error' }) {
  return state === 'loading' ? (
    <span className="rcfd-skel" aria-label="Loading" />
  ) : (
    <span className="rcfd-seg-na">—</span>
  );
}

export function OverviewBand({
  name,
  status,
  since,
  numbers,
  activity,
  teamSize,
  actionLabel,
  onAction,
  onRetryActivity,
}: OverviewBandProps) {
  const kpis = activity.state === 'ready' ? activity.value : null;
  const share = kpis?.good_share_pct ?? null;
  const shareColor = share != null ? goodShareColor(share) : null;
  const statusTone = status === 'active' ? 'on' : status ? 'off' : 'unknown';

  return (
    <section className="rcfd-band" aria-label="Account overview">
      <div className="rcfd-band-glow" aria-hidden="true" />

      <div className="rcfd-band-top">
        <div className="rcfd-band-id">
          <p className="rcfd-band-kicker">Remote call forwarding</p>
          <h1 className="rcfd-band-name">{name}</h1>
          <div className="rcfd-band-meta">
            {status && (
              <span className={`rcfd-band-status rcfd-band-status-${statusTone}`}>
                <span className="rcfd-dot" aria-hidden="true" />
                {STATUS_WORD[status]}
              </span>
            )}
            {since && <span className="rcfd-band-since">Customer since {since}</span>}
          </div>
        </div>
        {actionLabel && (
          <button type="button" className="rcfd-btn rcfd-btn-glow" onClick={onAction}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path d="M8 3v10M3 8h10" strokeLinecap="round" />
            </svg>
            {actionLabel}
          </button>
        )}
      </div>

      <div className="rcfd-band-readout">
        <Segment label="Numbers on your account">
          {numbers.state === 'ready' ? numbers.value.total.toLocaleString() : <Placeholder state={numbers.state} />}
        </Segment>

        <Segment
          label={numbers.state === 'ready' && numbers.value.partial ? 'Of the first 100 listed' : 'Routing right now'}
          wide
        >
          {numbers.state === 'ready' ? (
            <span className="rcfd-split">
              <span className="rcfd-split-item">
                <span className="rcfd-dot rcfd-dot-on" aria-hidden="true" />
                {numbers.value.forwarding.toLocaleString()}
                <span className="rcfd-split-word">forwarding</span>
              </span>
              <span className="rcfd-split-item">
                <span className="rcfd-dot rcfd-dot-off" aria-hidden="true" />
                {numbers.value.paused.toLocaleString()}
                <span className="rcfd-split-word">paused</span>
              </span>
            </span>
          ) : (
            <Placeholder state={numbers.state} />
          )}
        </Segment>

        <Segment label="Calls in the last 7 days" title="Every call to your numbers in the last 7 days.">
          {kpis ? kpis.calls.toLocaleString() : <Placeholder state={activity.state === 'loading' ? 'loading' : 'error'} />}
        </Segment>

        <Segment
          label="Answered"
          title="Share of calls in the last 7 days that were answered."
        >
          {kpis ? fmtPct1(kpis.asr_pct) : <Placeholder state={activity.state === 'loading' ? 'loading' : 'error'} />}
        </Segment>

        <Segment
          label="Sounded good or better"
          title={
            kpis && kpis.graded > 0
              ? `${kpis.good_or_better.toLocaleString()} of ${kpis.graded.toLocaleString()} graded calls in the last 7 days sounded good or better.`
              : 'Calls that weren’t answered, lasted under 5 seconds or carried too little sound aren’t graded.'
          }
        >
          {kpis ? (
            <span className="rcfd-toned">
              {shareColor && (
                <span
                  className="rcfd-dot rcfd-dot-tone"
                  style={{ '--rcfd-tone': shareColor } as CSSProperties}
                  aria-hidden="true"
                />
              )}
              {fmtShareFloor(share)}
              {shareColor && shareWord(shareColor) && (
                <span className="rcfd-tone-word">{shareWord(shareColor)}</span>
              )}
            </span>
          ) : (
            <Placeholder state={activity.state === 'loading' ? 'loading' : 'error'} />
          )}
        </Segment>

        <Segment label="Team members">
          {teamSize.state === 'ready' ? teamSize.value.toLocaleString() : <Placeholder state={teamSize.state} />}
        </Segment>
      </div>

      {activity.state === 'error' && (
        <div className="rcfd-band-note" role="status">
          Call figures couldn’t load right now.
          <button type="button" className="rcfd-linkbtn rcfd-linkbtn-dark" onClick={onRetryActivity}>
            Try again
          </button>
        </div>
      )}
    </section>
  );
}
