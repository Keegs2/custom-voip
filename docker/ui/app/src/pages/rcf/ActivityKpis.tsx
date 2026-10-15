/**
 * ActivityKpis — the Call Activity tab's KPI tile row, from the
 * /cdrs/activity `kpis` block (whole selected range, every call — not a
 * sample).
 *
 * Tiles: Calls · Answer rate · Sounded good or better · Avg duration ·
 * One-way audio. Each tile is label → big tabular value → one supporting
 * line ("186 of 191 answered"), so the row reads at a glance and the
 * numbers stay auditable. Values stay in ink; only the two quality tiles
 * carry a tone (good-share band from quality.ts, one-way red when > 0) and
 * the tone always travels with words, never color alone.
 *
 * Styling lives in index.css under `.rcf-kpis` / `.rcf-kpi-*`.
 */
import type { CSSProperties } from 'react';
import type { CdrActivityKpis } from '../../types/cdrActivity';
import { goodShareColor } from '../calls/quality';
import { fmtAvgMinutes } from '../../utils/callDuration';
import { fmtAcdExact, fmtPct1, fmtShareFloor } from './activityFormat';
import { RED } from './theme';

const GRADING_NOTE = 'Calls that weren’t answered, lasted under 5 seconds or carried too little sound aren’t graded.';

/**
 * Staff responses carry exact seconds, tenant responses whole-minute means —
 * decided by FIELD PRESENCE (same rule as utils/callDuration.ts), so an admin
 * previewing customer view and a real tenant both render correctly.
 */
function avgDurationLabel(k: CdrActivityKpis): string {
  if (k.avg_duration_sec !== undefined) {
    return k.avg_duration_sec == null || k.avg_duration_sec <= 0 ? '—' : fmtAcdExact(k.avg_duration_sec);
  }
  return fmtAvgMinutes(k.avg_duration_minutes);
}

interface TileProps {
  label: string;
  value: string;
  sub: string;
  title?: string;
  /** Accent color for the keyline + value; omit for neutral ink. */
  tone?: string;
  /** Faded value (no data yet for this measure). */
  muted?: boolean;
}

function Tile({ label, value, sub, title, tone, muted }: TileProps) {
  const style = tone ? ({ '--rcf-kpi-tone': tone } as CSSProperties) : undefined;
  const cls = `rcf-kpi${tone ? ' rcf-kpi-toned' : ''}${muted ? ' rcf-kpi-muted' : ''}`;
  return (
    <div className={cls} style={style} title={title}>
      <div className="rcf-kpi-label">{label}</div>
      <div className="rcf-kpi-value">{value}</div>
      <div className="rcf-kpi-sub">{sub}</div>
    </div>
  );
}

export interface ActivityKpisProps {
  kpis: CdrActivityKpis | undefined;
  /** First load (nothing to show yet) → placeholder tiles, same height. */
  loading: boolean;
  /** Newer range/DID loading over an old result → dim, keep the layout. */
  refreshing: boolean;
  /** "the last 7 days" */
  rangePhrase: string;
}

export function ActivityKpis({ kpis, loading, refreshing, rangePhrase }: ActivityKpisProps) {
  if (loading || !kpis) {
    return (
      <div className="rcf-kpis rcf-kpis-loading" aria-busy="true" aria-label="Loading call activity totals">
        {['Calls', 'Answer rate', 'Sounded good or better', 'Avg duration', 'One-way audio'].map((label) => (
          <div key={label} className="rcf-kpi rcf-kpi-muted">
            <div className="rcf-kpi-label">{label}</div>
            <div className="rcf-kpi-value">—</div>
            <div className="rcf-kpi-sub">Loading…</div>
          </div>
        ))}
      </div>
    );
  }

  const missed = Math.max(kpis.calls - kpis.answered, 0);
  const goodShare = kpis.good_share_pct;

  return (
    <div className={`rcf-kpis${refreshing ? ' rcf-kpis-busy' : ''}`}>
      <Tile
        label="Calls"
        value={kpis.calls.toLocaleString()}
        sub={kpis.calls > 0 ? `${kpis.answered.toLocaleString()} answered · ${missed.toLocaleString()} missed` : `None in ${rangePhrase}`}
        title={`Every call to these numbers in ${rangePhrase}.`}
      />
      <Tile
        label="Answer rate"
        value={fmtPct1(kpis.asr_pct)}
        muted={kpis.asr_pct == null}
        sub={kpis.calls > 0 ? `${kpis.answered.toLocaleString()} of ${kpis.calls.toLocaleString()} answered` : 'No calls yet'}
        title="Answer-seizure ratio (ASR): the share of calls that were answered with talk time."
      />
      <Tile
        label="Sounded good or better"
        value={fmtShareFloor(goodShare)}
        tone={goodShare != null ? goodShareColor(goodShare) : undefined}
        muted={goodShare == null}
        sub={
          kpis.graded > 0
            ? `${kpis.good_or_better.toLocaleString()} of ${kpis.graded.toLocaleString()} graded calls`
            : 'No graded calls yet'
        }
        title={
          kpis.graded > 0
            ? `${kpis.good_or_better} of ${kpis.graded} graded calls sounded good or better. ${GRADING_NOTE}`
            : `No graded calls yet — ${GRADING_NOTE.charAt(0).toLowerCase()}${GRADING_NOTE.slice(1)}`
        }
      />
      <Tile
        label="Avg duration"
        value={avgDurationLabel(kpis)}
        muted={kpis.answered === 0}
        sub="Per answered call"
        title="Average talk time of answered calls."
      />
      <Tile
        label="One-way audio"
        value={kpis.one_way.toLocaleString()}
        tone={kpis.one_way > 0 ? RED : undefined}
        sub={kpis.one_way > 0 ? `${kpis.one_way === 1 ? 'Call' : 'Calls'} with sound from one side only` : 'None detected'}
        title="Calls where no sound came through from one side"
      />
    </div>
  );
}
