/**
 * ActivityChart — the Call Activity tab's range chart, drawn from EVERY
 * bucket of GET /cdrs/activity (fixed + zero-filled server-side).
 *
 * Two aligned small multiples on one shared x-axis, never a dual y-axis:
 *   1. Call volume — stacked columns, answered (azure) under missed (amber),
 *      a 2px surface gap between segments, 4px rounded top, ≤24px wide.
 *   2. Rates — Answer rate and Sounded-good-or-better as 2px lines on ONE
 *      0–100% axis. A bucket with no denominator (no calls / nothing graded)
 *      is a genuine gap: the line breaks, no placeholder dot is drawn.
 *
 * Same hand-rolled idiom as pages/reporting/CallsTrendChart: the SVG is
 * drawn at the container's measured pixel width (ResizeObserver) so 11px
 * text stays 11px; hairline solid grid; one crosshair band + one tooltip
 * listing every series for the bucket. Keyboard: the plot is focusable and
 * Left/Right/Home/End walk the buckets (mirrored to a polite live region);
 * a visually-hidden table carries every value. Identity is never
 * color-alone — legend + tooltip spell each series out, and the good-or-
 * better line is dashed as a secondary channel.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { ActivityBucket, CdrActivityPoint } from '../../types/cdrActivity';
import { TREND_COLORS } from '../reporting/reportFormat';
import { AZURE_DEEP } from './theme';
import { bucketRangeLabel, bucketTick, fmtPct1, fmtShareFloor, plural, tickStep } from './activityFormat';

// Series colors — validated as pairs (dataviz validator, light surface):
// columns azure/amber (same pair as the Reporting page), lines azure-deep/teal.
const C_ANSWERED = TREND_COLORS.answered;
const C_MISSED = TREND_COLORS.missed;
const C_ASR = AZURE_DEEP;
const C_GOOD = '#0d9488';
const GOOD_DASH = '5 3';

const SURFACE = '#ffffff';
const INK_TICK = '#5d6f8c';
const GRID = 'rgba(14, 23, 38, 0.07)';
const BASELINE = 'rgba(14, 23, 38, 0.16)';
const HOVER_BAND = 'rgba(47, 125, 246, 0.07)';

// Geometry (px). The rate plot sits under the volume plot with room for its
// own caption; the shared x labels run once, under the rate plot.
const PAD_L = 44;
const PAD_R = 12;
const PAD_T = 8;
const VOL_H = 172;
const RATE_GAP = 40;
const RATE_H = 92;
const AXIS_H = 28;
const VOL_TOP = PAD_T;
const VOL_BASE = VOL_TOP + VOL_H;
const RATE_TOP = VOL_BASE + RATE_GAP;
const RATE_BASE = RATE_TOP + RATE_H;
const SVG_H = RATE_BASE + AXIS_H;
const MIN_RENDER_WIDTH = 160;
const MAX_BAR_W = 24;
const SEG_GAP = 2;
const TIP_W = 216;

function niceIntStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 1) return 1;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const frac = rough / pow;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10;
  return Math.max(1, Math.round(nice * pow));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Half-pixel snap so 1px hairlines render crisp. */
function crisp(y: number): number {
  return Math.round(y) + 0.5;
}

/** Column segment with only its TOP corners rounded (square at the baseline). */
function topRoundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return [
    `M ${x} ${y + h}`,
    `V ${y + rr}`,
    `Q ${x} ${y} ${x + rr} ${y}`,
    `H ${x + w - rr}`,
    `Q ${x + w} ${y} ${x + w} ${y + rr}`,
    `V ${y + h}`,
    'Z',
  ].join(' ');
}

/** Split a nullable series into connected runs — a null ends the run (a gap). */
function runs(values: readonly (number | null)[]): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (cur.length) out.push(cur);
      cur = [];
    } else {
      cur.push(i);
    }
  });
  if (cur.length) out.push(cur);
  return out;
}

export interface ActivityChartProps {
  bucket: ActivityBucket;
  points: CdrActivityPoint[];
  /** Exclusive end of the whole window — closes the LAST bucket's range. */
  windowEnd: string;
  tz: string;
  /** Lower-case range phrase for the empty note ("the last 7 days"). */
  rangePhrase: string;
  /** True while a newer range/DID is loading — the old frame dims, no jump. */
  refreshing: boolean;
}

export function ActivityChart({ bucket, points, windowEnd, tz, rangePhrase, refreshing }: ActivityChartProps) {
  // ALL hooks unconditionally at the top (React #310 prevention).
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const next = Math.round(entry.contentRect.width);
        setWidth((prev) => (prev === next ? prev : next));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const n = points.length;

  const geom = useMemo(() => {
    const plotW = Math.max(width - PAD_L - PAD_R, 10);
    const dataMax = points.reduce((m, p) => Math.max(m, p.calls), 0);
    const step = niceIntStep(Math.max(dataMax, 1) / 3);
    const top = Math.max(step, Math.ceil(dataMax / step) * step);
    const volTicks: number[] = [];
    for (let t = 0; t <= top; t += step) volTicks.push(t);
    const slot = n > 0 ? plotW / n : plotW;
    const barW = clamp(slot * 0.62, 2, MAX_BAR_W);
    const yVol = (v: number) => VOL_BASE - (v / top) * VOL_H;
    const yRate = (pct: number) => RATE_BASE - (clamp(pct, 0, 100) / 100) * RATE_H;
    const xCenter = (i: number) => PAD_L + slot * (i + 0.5);
    const every = tickStep(bucket, n, plotW);
    const labelIdx: number[] = [];
    for (let i = 0; i < n; i += every) labelIdx.push(i);
    return { plotW, volTicks, slot, barW, yVol, yRate, xCenter, labelIdx };
  }, [points, width, n, bucket]);

  const linePaths = useMemo(() => {
    const build = (values: (number | null)[]) => {
      const segs = runs(values);
      const d = segs
        .filter((r) => r.length > 1)
        .map((r) => r.map((i, k) => `${k === 0 ? 'M' : 'L'} ${geom.xCenter(i).toFixed(1)} ${geom.yRate(values[i] ?? 0).toFixed(1)}`).join(' '))
        .join(' ');
      // A lone point between two gaps has no neighbour to draw a line to —
      // mark it with a dot so real data never disappears.
      const lone = segs.filter((r) => r.length === 1).map((r) => r[0]);
      return { d, lone };
    };
    return {
      asr: build(points.map((p) => p.asr_pct)),
      good: build(points.map((p) => p.good_share_pct)),
    };
  }, [points, geom]);

  const bucketEnd = (i: number): string => points[i + 1]?.t ?? windowEnd;
  const rangeLabel = (i: number): string => bucketRangeLabel(bucket, points[i].t, bucketEnd(i), tz);
  const hasCalls = points.some((p) => p.calls > 0);
  const measured = width >= MIN_RENDER_WIDTH;

  function describe(i: number): string {
    const p = points[i];
    if (p.calls === 0) return `${rangeLabel(i)}: no calls.`;
    const good = p.good_share_pct == null ? 'no graded calls' : `${fmtShareFloor(p.good_share_pct)} sounded good or better (${p.good_or_better} of ${p.graded} graded)`;
    return `${rangeLabel(i)}: ${plural(p.calls, 'call', 'calls')}, ${p.answered} answered, ${p.missed} missed, answer rate ${fmtPct1(p.asr_pct)}, ${good}${p.one_way > 0 ? `, ${p.one_way} one-way audio` : ''}.`;
  }

  function handleMouseMove(e: MouseEvent<SVGSVGElement>): void {
    if (n === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left - PAD_L;
    if (mx < 0 || mx > geom.plotW) {
      setActive(null);
      return;
    }
    const idx = clamp(Math.floor(mx / geom.slot), 0, n - 1);
    setActive((prev) => (prev === idx ? prev : idx));
  }

  function handleKeyDown(e: KeyboardEvent<SVGSVGElement>): void {
    if (n === 0) return;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = active == null ? 0 : Math.min(n - 1, active + 1);
    else if (e.key === 'ArrowLeft') next = active == null ? n - 1 : Math.max(0, active - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Escape') {
      setActive(null);
      return;
    }
    if (next != null) {
      e.preventDefault();
      setActive(next);
    }
  }

  const activePoint = active != null ? (points[active] ?? null) : null;
  // Tooltip sits BESIDE the hovered column (never over it): right of it on the
  // left half of the plot, left of it on the right half.
  const tipOnRight = active != null && geom.xCenter(active) < width / 2;
  const tipAnchorX = active != null ? geom.xCenter(active) + (tipOnRight ? geom.slot / 2 + 8 : -geom.slot / 2 - 8) : 0;
  // Clamp inside the frame on narrow screens (the card is TIP_W wide).
  const tipLeft = tipOnRight
    ? Math.max(0, Math.min(tipAnchorX, width - TIP_W))
    : Math.max(0, Math.min(tipAnchorX - TIP_W, width - TIP_W));

  return (
    <div ref={boxRef} className="rcf-act-chart">
      <div className={`rcf-act-frame${refreshing ? ' rcf-act-frame-busy' : ''}`} style={{ height: SVG_H }}>
        {measured && (
          <svg
            className="rcf-act-svg"
            width={width}
            height={SVG_H}
            role="group"
            tabIndex={0}
            aria-label={`Calls per ${bucket}, answered and missed, with answer rate and share that sounded good or better. Use the left and right arrow keys to read each ${bucket}.`}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setActive(null)}
            onKeyDown={handleKeyDown}
            onBlur={() => setActive(null)}
          >
            {/* ── Volume plot grid + y ticks ── */}
            {geom.volTicks.map((t) => {
              const y = crisp(geom.yVol(t));
              return (
                <g key={`v${t}`} aria-hidden="true">
                  <line x1={PAD_L} y1={y} x2={width - PAD_R} y2={y} stroke={t === 0 ? BASELINE : GRID} strokeWidth={1} />
                  <text x={PAD_L - 8} y={y + 3.5} textAnchor="end" fontSize={11} fill={INK_TICK} className="rcf-act-num">
                    {t.toLocaleString()}
                  </text>
                </g>
              );
            })}

            {/* ── Rate plot caption, grid + y ticks (0 / 50 / 100%) ── */}
            <text x={PAD_L} y={RATE_TOP - 12} fontSize={11} fontWeight={600} fill={INK_TICK} aria-hidden="true">
              Rates · 0–100%
            </text>
            {[0, 50, 100].map((t) => {
              const y = crisp(geom.yRate(t));
              return (
                <g key={`r${t}`} aria-hidden="true">
                  <line x1={PAD_L} y1={y} x2={width - PAD_R} y2={y} stroke={t === 0 ? BASELINE : GRID} strokeWidth={1} />
                  <text x={PAD_L - 8} y={y + 3.5} textAnchor="end" fontSize={11} fill={INK_TICK} className="rcf-act-num">
                    {t}%
                  </text>
                </g>
              );
            })}

            {/* ── Crosshair band — spans both plots so they read as one x ── */}
            {active != null && (
              <g aria-hidden="true">
                <rect x={PAD_L + geom.slot * active} y={VOL_TOP} width={geom.slot} height={VOL_H} fill={HOVER_BAND} rx={4} />
                <rect x={PAD_L + geom.slot * active} y={RATE_TOP} width={geom.slot} height={RATE_H} fill={HOVER_BAND} rx={4} />
              </g>
            )}

            {/* ── Stacked columns: answered (bottom) + missed (top) ── */}
            {points.map((p, i) => {
              if (p.calls === 0) return null;
              const x = geom.xCenter(i) - geom.barW / 2;
              const answeredTop = geom.yVol(p.answered);
              const totalTop = geom.yVol(p.answered + p.missed);
              const both = p.answered > 0 && p.missed > 0;
              const missedBottom = both ? answeredTop - SEG_GAP : VOL_BASE;
              return (
                <g key={p.t} aria-hidden="true">
                  {p.answered > 0 && (
                    both ? (
                      <rect x={x} y={answeredTop} width={geom.barW} height={Math.max(VOL_BASE - answeredTop, 1)} fill={C_ANSWERED} />
                    ) : (
                      <path d={topRoundedRect(x, answeredTop, geom.barW, Math.max(VOL_BASE - answeredTop, 1), 4)} fill={C_ANSWERED} />
                    )
                  )}
                  {p.missed > 0 && (
                    <path
                      d={topRoundedRect(x, Math.min(totalTop, missedBottom - 1.5), geom.barW, Math.max(missedBottom - totalTop, 1.5), 4)}
                      fill={C_MISSED}
                    />
                  )}
                </g>
              );
            })}

            {/* ── Rate lines (2px) — gaps where a bucket has no denominator ── */}
            <g aria-hidden="true">
              <path d={linePaths.asr.d} fill="none" stroke={C_ASR} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              <path d={linePaths.good.d} fill="none" stroke={C_GOOD} strokeWidth={2} strokeDasharray={GOOD_DASH} strokeLinejoin="round" strokeLinecap="round" />
              {linePaths.asr.lone.map((i) => (
                <circle key={`al${i}`} cx={geom.xCenter(i)} cy={geom.yRate(points[i].asr_pct ?? 0)} r={3.5} fill={C_ASR} stroke={SURFACE} strokeWidth={2} />
              ))}
              {linePaths.good.lone.map((i) => (
                <circle key={`gl${i}`} cx={geom.xCenter(i)} cy={geom.yRate(points[i].good_share_pct ?? 0)} r={3.5} fill={C_GOOD} stroke={SURFACE} strokeWidth={2} />
              ))}
              {activePoint && active != null && activePoint.asr_pct != null && (
                <circle cx={geom.xCenter(active)} cy={geom.yRate(activePoint.asr_pct)} r={4.5} fill={C_ASR} stroke={SURFACE} strokeWidth={2} />
              )}
              {activePoint && active != null && activePoint.good_share_pct != null && (
                <circle cx={geom.xCenter(active)} cy={geom.yRate(activePoint.good_share_pct)} r={4.5} fill={C_GOOD} stroke={SURFACE} strokeWidth={2} />
              )}
            </g>

            {/* ── Shared x labels (thinned to a natural step so they never collide) ── */}
            {geom.labelIdx.map((i) => {
              const x = geom.xCenter(i);
              const nearRight = x > width - 34;
              const nearLeft = x < PAD_L + 16;
              return (
                <text
                  key={`x${points[i].t}`}
                  x={nearRight ? width - 2 : x}
                  y={SVG_H - 9}
                  textAnchor={nearRight ? 'end' : nearLeft ? 'start' : 'middle'}
                  fontSize={11}
                  fill={active === i ? '#0e1726' : INK_TICK}
                  aria-hidden="true"
                >
                  {bucketTick(bucket, points[i].t, tz)}
                </text>
              );
            })}
          </svg>
        )}

        {/* Zero-call range — the frame stays (axes, gridlines) with a quiet note. */}
        {measured && !hasCalls && (
          <div className="rcf-act-empty-note" style={{ top: VOL_TOP + VOL_H / 2 - 16 }}>
            No calls in {rangePhrase}. This chart fills in as calls come in.
          </div>
        )}

        {measured && activePoint && active != null && (
          <div
            className="rcf-act-tip"
            aria-hidden="true"
            style={{
              left: tipLeft,
              top: VOL_TOP + 6,
              width: TIP_W,
            }}
          >
            <div className="rcf-act-tip-date">{rangeLabel(active)}</div>
            {activePoint.calls === 0 ? (
              <div className="rcf-act-tip-muted">No calls</div>
            ) : (
              <>
                <div className="rcf-act-tip-value">{plural(activePoint.calls, 'call', 'calls')}</div>
                <div className="rcf-act-tip-row">
                  <span className="rcf-act-key rcf-act-key-box" style={{ background: C_ANSWERED }} />
                  <strong>{activePoint.answered.toLocaleString()}</strong> answered
                </div>
                <div className="rcf-act-tip-row">
                  <span className="rcf-act-key rcf-act-key-box" style={{ background: C_MISSED }} />
                  <strong>{activePoint.missed.toLocaleString()}</strong> missed
                </div>
                <div className="rcf-act-tip-rule" />
                <div className="rcf-act-tip-row">
                  <span className="rcf-act-key rcf-act-key-line" style={{ borderTopColor: C_ASR }} />
                  <strong>{fmtPct1(activePoint.asr_pct)}</strong> answer rate
                </div>
                <div className="rcf-act-tip-row">
                  <span className="rcf-act-key rcf-act-key-line rcf-act-key-dash" style={{ borderTopColor: C_GOOD }} />
                  {activePoint.good_share_pct == null ? (
                    <span className="rcf-act-tip-muted">No graded calls</span>
                  ) : (
                    <>
                      <strong>{fmtShareFloor(activePoint.good_share_pct)}</strong>&nbsp;good or better
                      <span className="rcf-act-tip-muted">&nbsp;· {activePoint.good_or_better} of {activePoint.graded}</span>
                    </>
                  )}
                </div>
                {activePoint.one_way > 0 && (
                  <div className="rcf-act-tip-row rcf-act-tip-alert">
                    <span className="rcf-act-key rcf-act-key-dot" />
                    <strong>{activePoint.one_way.toLocaleString()}</strong> one-way audio
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Legend — always present (≥2 series); keys mirror the marks. */}
      <div className="rcf-act-legend">
        <span className="rcf-act-legend-item"><span className="rcf-act-key rcf-act-key-box" style={{ background: C_ANSWERED }} />Answered</span>
        <span className="rcf-act-legend-item"><span className="rcf-act-key rcf-act-key-box" style={{ background: C_MISSED }} />Missed</span>
        <span className="rcf-act-legend-item"><span className="rcf-act-key rcf-act-key-line" style={{ borderTopColor: C_ASR }} />Answer rate</span>
        <span className="rcf-act-legend-item"><span className="rcf-act-key rcf-act-key-line rcf-act-key-dash" style={{ borderTopColor: C_GOOD }} />Sounded good or better (of graded calls)</span>
      </div>

      {/* Keyboard readout for assistive tech */}
      <div className="rcf-sr" aria-live="polite">
        {active != null && points[active] ? describe(active) : ''}
      </div>

      {/* Full data for screen readers */}
      <table className="rcf-sr">
        <caption>Calls per {bucket}</caption>
        <thead>
          <tr>
            <th scope="col">{bucket === 'hour' ? 'Hour' : bucket === 'week' ? 'Week' : 'Day'}</th>
            <th scope="col">Calls</th>
            <th scope="col">Answered</th>
            <th scope="col">Missed</th>
            <th scope="col">Answer rate</th>
            <th scope="col">Sounded good or better</th>
            <th scope="col">One-way audio</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p, i) => (
            <tr key={p.t}>
              <th scope="row">{rangeLabel(i)}</th>
              <td>{p.calls}</td>
              <td>{p.answered}</td>
              <td>{p.missed}</td>
              <td>{fmtPct1(p.asr_pct)}</td>
              <td>{p.good_share_pct == null ? '—' : `${fmtShareFloor(p.good_share_pct)} (${p.good_or_better} of ${p.graded})`}</td>
              <td>{p.one_way}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
