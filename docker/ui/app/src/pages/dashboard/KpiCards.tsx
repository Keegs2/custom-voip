/**
 * KpiCards — the row of six headline cards under the header:
 *
 *   Numbers · Forwarding · Calls, 7 days · Answered · Sounded good · Team
 *
 * Each card: a 3px top edge in the metric's tone, an icon in a soft tinted
 * chip, a label, a big tabular value and one small context line; the three
 * call metrics add a 7-day sparkline from GET /cdrs/activity's daily points.
 * Cards that lead somewhere (numbers → /rcf, call metrics → Call activity,
 * team → My account) are real links/buttons and lift on hover/focus.
 *
 * Quality tone + words come only from quality.ts (goodShareColor) and the
 * colour always travels with a word. No money, no raw media values.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CircleCheck, Hash, PhoneForwarded, PhoneIncoming, Users, Volume2 } from 'lucide-react';
import type { CdrActivityPoint, CdrActivityResponse } from '../../types/cdrActivity';
import { goodShareColor } from '../calls/quality';
import { fmtPct1, fmtShareFloor } from '../rcf/activityFormat';
import { GREEN } from '../rcf/theme';
import { shareWord, type Feed } from './accountData';

const AZURE = '#2f7df6';
const AZURE_DEEP = '#1d63dd';
const COBALT = '#113398';

export interface NumberCounts {
  /** Numbers on the account (or listed, when `partial`). */
  total: number;
  forwarding: number;
  paused: number;
  /** GET /rcf hit its 100-row cap and no account total was available. */
  partial: boolean;
}

export interface TeamCounts {
  total: number;
  active: number;
}

// ─── Sparkline ───────────────────────────────────────────────────────────────

const SPARK_W = 120;
const SPARK_H = 34;

/**
 * Tiny 7-point trend line with a soft area fill. Null points (no calls that
 * day) break the line rather than dropping to zero. `floorZero` anchors the
 * scale at 0 (counts); percentages use a data-driven window of at least 10
 * points so a 0.3% wobble doesn't look like a cliff.
 */
function Sparkline({ values, color, floorZero }: { values: readonly (number | null)[]; color: string; floorZero: boolean }) {
  const present = values.filter((v): v is number => v != null);
  if (present.length < 2) return null;
  const hi = Math.max(...present);
  const lo = floorZero ? 0 : Math.min(Math.min(...present), hi - 10);
  const span = Math.max(hi - lo, 1);
  const step = SPARK_W / Math.max(values.length - 1, 1);
  const y = (v: number) => SPARK_H - 3 - ((v - lo) / span) * (SPARK_H - 6);

  // Split into runs of consecutive non-null points.
  const runs: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (run.length) runs.push(run);
      run = [];
    } else {
      run.push({ x: i * step, y: y(v) });
    }
  });
  if (run.length) runs.push(run);

  const line = runs
    .map((r) => r.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' '))
    .join(' ');
  const area = runs
    .filter((r) => r.length > 1)
    .map((r) => `M${r[0].x.toFixed(1)} ${SPARK_H} ${r.map((p) => `L${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')} L${r[r.length - 1].x.toFixed(1)} ${SPARK_H} Z`)
    .join(' ');
  const last = runs[runs.length - 1]?.[runs[runs.length - 1].length - 1];

  return (
    <svg className="ad-spark" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} aria-hidden="true">
      <path d={area} fill={color} opacity={0.1} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
      {last && <circle cx={last.x} cy={last.y} r={2.6} fill={color} />}
    </svg>
  );
}

// ─── One card ────────────────────────────────────────────────────────────────

type KpiTarget = { kind: 'link'; to: string; hint: string } | { kind: 'button'; onClick: () => void; hint: string } | null;

interface KpiCardProps {
  order: number;
  label: string;
  icon: ReactNode;
  tone: string;
  value: ReactNode;
  context: ReactNode;
  spark?: ReactNode;
  target: KpiTarget;
  /** Full sentence for assistive tech / hover. */
  title?: string;
}

function KpiCard({ order, label, icon, tone, value, context, spark, target, title }: KpiCardProps) {
  const style = { '--i': order, '--ad-tone': tone } as CSSProperties;
  const inner = (
    <>
      <span className="ad-kpi-top">
        <span className="ad-kpi-icon" aria-hidden="true">{icon}</span>
        <span className="ad-kpi-label">{label}</span>
      </span>
      <span className="ad-kpi-main">
        <span className="ad-kpi-value">{value}</span>
        {spark}
      </span>
      <span className="ad-kpi-context">{context}</span>
    </>
  );
  if (target?.kind === 'link') {
    return (
      <Link to={target.to} className="ad-kpi ad-kpi-live ad-rise" style={style} title={title ?? target.hint}>
        {inner}
      </Link>
    );
  }
  if (target?.kind === 'button') {
    return (
      <button type="button" className="ad-kpi ad-kpi-live ad-rise" style={style} onClick={target.onClick} title={title ?? target.hint}>
        {inner}
      </button>
    );
  }
  return (
    <div className="ad-kpi ad-rise" style={style} title={title}>
      {inner}
    </div>
  );
}

function Placeholder({ state }: { state: 'loading' | 'error' }) {
  return state === 'loading' ? (
    <span className="ad-skel" aria-label="Loading" />
  ) : (
    <span className="ad-kpi-na" title="Couldn’t load right now">—</span>
  );
}

// ─── Row ─────────────────────────────────────────────────────────────────────

export interface KpiRowProps {
  numbers: Feed<NumberCounts>;
  activity: Feed<CdrActivityResponse>;
  team: Feed<TeamCounts>;
  onOpenActivity: () => void;
  /** Base stagger slot for the first card. */
  order: number;
}

function series(points: readonly CdrActivityPoint[], pick: (p: CdrActivityPoint) => number | null): (number | null)[] {
  return points.map(pick);
}

export function KpiRow({ numbers, activity, team, onOpenActivity, order }: KpiRowProps) {
  const data = activity.state === 'ready' ? activity.value : null;
  const k = data?.kpis ?? null;
  const points = data?.points ?? [];
  const activityPlaceholder = <Placeholder state={activity.state === 'error' ? 'error' : 'loading'} />;
  const openActivity: KpiTarget = { kind: 'button', onClick: onOpenActivity, hint: 'Open call activity' };

  const share = k?.good_share_pct ?? null;
  const shareTone = goodShareColor(share);
  const word = share != null ? shareWord(shareTone) : null;

  return (
    <div className="ad-kpis" role="list" aria-label="Account at a glance">
      <div role="listitem" className="ad-kpi-cell">
        <KpiCard
          order={order}
          label="Numbers"
          icon={<Hash size={16} strokeWidth={2} />}
          tone={AZURE}
          value={numbers.state === 'ready' ? `${numbers.value.total.toLocaleString()}${numbers.value.partial ? '+' : ''}` : <Placeholder state={numbers.state} />}
          context={numbers.state === 'ready' && numbers.value.partial ? 'First 100 listed' : 'On your account'}
          target={{ kind: 'link', to: '/rcf', hint: 'See all your numbers' }}
        />
      </div>

      <div role="listitem" className="ad-kpi-cell">
        <KpiCard
          order={order + 1}
          label="Forwarding"
          icon={<PhoneForwarded size={16} strokeWidth={2} />}
          tone={GREEN}
          value={numbers.state === 'ready' ? numbers.value.forwarding.toLocaleString() : <Placeholder state={numbers.state} />}
          context={
            numbers.state !== 'ready' ? 'Routing right now' : numbers.value.paused === 0 ? (
              <span className="ad-kpi-ok">
                <span className="ad-dot ad-dot-on" aria-hidden="true" />
                All forwarding
              </span>
            ) : (
              <span>
                <span className="ad-dot ad-dot-off" aria-hidden="true" /> {numbers.value.paused.toLocaleString()} paused
              </span>
            )
          }
          target={{ kind: 'link', to: '/rcf', hint: 'Manage forwarding' }}
        />
      </div>

      <div role="listitem" className="ad-kpi-cell">
        <KpiCard
          order={order + 2}
          label="Calls, 7 days"
          icon={<PhoneIncoming size={16} strokeWidth={2} />}
          tone={AZURE}
          value={k ? k.calls.toLocaleString() : activityPlaceholder}
          context={k ? `${k.answered.toLocaleString()} answered` : 'Every call to your numbers'}
          spark={k && k.calls > 0 ? <Sparkline values={series(points, (p) => p.calls)} color={AZURE} floorZero /> : null}
          target={openActivity}
        />
      </div>

      <div role="listitem" className="ad-kpi-cell">
        <KpiCard
          order={order + 3}
          label="Answered"
          icon={<CircleCheck size={16} strokeWidth={2} />}
          tone={AZURE_DEEP}
          value={k ? fmtPct1(k.asr_pct) : activityPlaceholder}
          context={k ? (k.calls === 0 ? 'No calls yet' : `${(k.calls - k.answered).toLocaleString()} missed`) : 'Share of calls answered'}
          spark={k && k.calls > 0 ? <Sparkline values={series(points, (p) => p.asr_pct)} color={AZURE_DEEP} floorZero={false} /> : null}
          target={openActivity}
        />
      </div>

      <div role="listitem" className="ad-kpi-cell">
        <KpiCard
          order={order + 4}
          label="Sounded good"
          icon={<Volume2 size={16} strokeWidth={2} />}
          tone={shareTone}
          value={
            k ? (
              <span className="ad-kpi-toned">
                {fmtShareFloor(share)}
                {word && <span className="ad-tone-word" style={{ '--ad-tone': shareTone } as CSSProperties}>{word}</span>}
              </span>
            ) : (
              activityPlaceholder
            )
          }
          context={
            k
              ? k.graded > 0
                ? `${k.good_or_better.toLocaleString()} of ${k.graded.toLocaleString()} graded calls`
                : 'No graded calls yet'
              : 'Good or better quality'
          }
          title={
            k && k.graded > 0
              ? `${k.good_or_better.toLocaleString()} of ${k.graded.toLocaleString()} graded calls in the last 7 days sounded good or better.`
              : 'Calls that weren’t answered, lasted under 5 seconds or carried too little sound aren’t graded.'
          }
          spark={k && k.graded > 0 ? <Sparkline values={series(points, (p) => p.good_share_pct)} color={shareTone} floorZero={false} /> : null}
          target={openActivity}
        />
      </div>

      <div role="listitem" className="ad-kpi-cell">
        <KpiCard
          order={order + 5}
          label="Team"
          icon={<Users size={16} strokeWidth={2} />}
          tone={COBALT}
          value={team.state === 'ready' ? team.value.total.toLocaleString() : <Placeholder state={team.state} />}
          context={team.state === 'ready' ? `${team.value.active.toLocaleString()} can sign in` : 'People on your account'}
          target={{ kind: 'link', to: '/my-account', hint: 'Open My account' }}
        />
      </div>
    </div>
  );
}
