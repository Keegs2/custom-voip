/**
 * QualityTrendChart — minimal daily-average trend chart for voice-quality
 * metrics (MOS / packet loss / jitter) on the daylight canvas.
 *
 * Deliberately quiet: a short label, one accent-colored line with a soft
 * gradient under-shade, small markers, hairline horizontal grid, and a hover
 * tooltip. No other chrome.
 *
 *   1. TRUE-PIXEL TEXT. The SVG is drawn at the container's real pixel width
 *      (ResizeObserver) — never scaled through a fixed viewBox, so the 11px
 *      tick labels really are 11px.
 *
 *   2. HONEST GAPS. The x-axis is the FULL selected date range, one slot per
 *      day. Days with no measured calls break the line — no interpolation,
 *      and the under-shade is built PER contiguous segment so it never
 *      bridges a gap. Isolated single-day segments render as a marker only.
 *
 *   3. NON-OVERSHOOTING SMOOTHING. Segments are curved with a monotone cubic
 *      (Fritsch–Carlson tangents — the d3 curveMonotoneX rule): tangents are
 *      slope-limited and flattened at local extrema, so the curve never
 *      overshoots a data point or invents peaks between sparse points.
 *
 * Purely presentational: callers aggregate CDRs into one TrendPoint per day.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import '../../styles/dl-trend-chart.css';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TrendPoint {
  /** UTC calendar day key, YYYY-MM-DD. */
  date: string;
  /** Daily average for the metric, or null when no call carried the metric. */
  value: number | null;
  /** Calls that day that carried this metric (the average's sample size). */
  sampleCount: number;
  /** Total calls bucketed to this day (with or without the metric). */
  totalCalls: number;
}

export interface TrendDomain {
  min: number;
  /** Fixed top (e.g. 5 for MOS), or 'auto' — padded ~15% above the data max. */
  max: number | 'auto';
}

export interface QualityTrendChartProps {
  points: TrendPoint[];
  /** Series stroke / marker / under-shade color. */
  accent: string;
  /** Short metric label, e.g. "MOS". */
  title: string;
  domain: TrendDomain;
  /** Exact value for the tooltip, e.g. 4.312 → "4.31". */
  formatValue: (v: number) => string;
  /** Y-axis tick label, e.g. 2.5 → "2.5%". */
  formatTick: (v: number) => string;
}

// ---------------------------------------------------------------------------
// Daylight ink scale (mirrors --rcf-* vars; SVG attrs can't read CSS vars in
// every renderer, so the chart inks are restated here once)
// ---------------------------------------------------------------------------

const INK_TICK = '#46566f'; // tick labels — 6.5:1 on the tint canvas
const GRID_LINE = 'rgba(14, 23, 38, 0.055)';
const GUIDE_LINE = 'rgba(14, 23, 38, 0.18)';

// ---------------------------------------------------------------------------
// Fixed layout metrics (real pixels — the SVG is never viewBox-scaled)
// ---------------------------------------------------------------------------

const PAD_L = 40; // y tick label gutter
const PAD_R = 12;
const PAD_T = 14; // marker / hover headroom
const PAD_B = 28; // x tick labels
const PLOT_H = 224;
const SVG_H = PAD_T + PLOT_H + PAD_B; // 266
const MIN_RENDER_WIDTH = 120; // below this the ResizeObserver hasn't fired yet

// ---------------------------------------------------------------------------
// Scale helpers
// ---------------------------------------------------------------------------

/** Round a rough step up to a "nice" 1 / 2 / 2.5 / 5 × 10^k value. */
function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const frac = rough / pow;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10;
  return nice * pow;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Snap to a half-pixel so 1px hairlines render crisp. */
function crisp(y: number): number {
  return Math.round(y) + 0.5;
}

/** Parse a YYYY-MM-DD day key as a UTC instant (label source of truth). */
function utcDay(key: string): Date {
  return new Date(`${key}T00:00:00Z`);
}

function plural(n: number): string {
  return n === 1 ? 'call' : 'calls';
}

// ---------------------------------------------------------------------------
// Geometry — everything derived from points + measured width
// ---------------------------------------------------------------------------

interface SegmentPoint {
  x: number;
  y: number;
  index: number;
}

interface Geometry {
  width: number;
  plotW: number;
  /** 3–4 light horizontal gridline values. */
  yTicks: number[];
  /** 4–5 labeled day indices. */
  xLabelIdx: number[];
  /** Contiguous non-null runs; length-1 runs are marker-only. */
  segments: SegmentPoint[][];
  xFor: (i: number) => number;
  yFor: (v: number) => number;
}

function computeGeometry(points: TrendPoint[], width: number, domain: TrendDomain): Geometry {
  const n = points.length;
  const plotW = Math.max(width - PAD_L - PAD_R, 10);

  // --- Y domain: fixed top, or auto — pad ~15% above the data max, then
  // round up to a whole tick step so the top gridline lands on a nice number.
  const values = points.map((p) => p.value).filter((v): v is number => v != null);
  const dataMax = values.length > 0 ? Math.max(...values) : 0;
  const dMin = domain.min;
  let dMax: number;
  let step: number;
  if (domain.max === 'auto') {
    const span = Math.max(dataMax - dMin, 0);
    const raw = span > 0 ? dMin + span * 1.15 : dMin + 1;
    step = niceStep((raw - dMin) / 3);
    dMax = dMin + Math.ceil((raw - dMin) / step - 1e-9) * step;
  } else {
    dMax = domain.max;
    step = niceStep((dMax - dMin) / 3);
  }
  const range = dMax - dMin || 1;

  // step is always ≥ range/3, so this yields 3–4 ticks.
  const yTicks: number[] = [];
  for (let t = dMin; t <= dMax + 1e-9; t += step) {
    yTicks.push(Number(t.toFixed(6)));
  }

  const yFor = (v: number): number =>
    PAD_T + PLOT_H - ((clamp(v, dMin, dMax) - dMin) / range) * PLOT_H;
  const xFor = (i: number): number =>
    n <= 1 ? PAD_L + plotW / 2 : PAD_L + (i / (n - 1)) * plotW;

  // --- X date ticks: first day, evenly spaced, plus the last day when it
  // isn't crowding the previous label — 4–5 at full width.
  const maxLabels = Math.min(4, Math.max(2, Math.floor(plotW / 90)));
  const labelStep = Math.max(1, Math.ceil(n / maxLabels));
  const xLabelIdx: number[] = [];
  for (let i = 0; i < n; i += labelStep) xLabelIdx.push(i);
  const lastLabeled = xLabelIdx[xLabelIdx.length - 1];
  if (n > 1 && lastLabeled !== n - 1 && n - 1 - lastLabeled >= labelStep * 0.55) {
    xLabelIdx.push(n - 1);
  }

  // --- Line segments: contiguous non-null runs only (gaps stay gaps)
  const segments: SegmentPoint[][] = [];
  let run: SegmentPoint[] = [];
  points.forEach((p, i) => {
    if (p.value == null) {
      if (run.length > 0) segments.push(run);
      run = [];
      return;
    }
    run.push({ x: xFor(i), y: yFor(p.value), index: i });
  });
  if (run.length > 0) segments.push(run);

  return { width, plotW, yTicks, xLabelIdx, segments, xFor, yFor };
}

// ---------------------------------------------------------------------------
// Path builders — monotone cubic line + closed under-shade
// ---------------------------------------------------------------------------

/**
 * Monotone cubic path through a segment (Fritsch–Carlson tangents — the rule
 * behind d3's curveMonotoneX). Interior tangents are slope-limited to
 * min(|s₋|, |s₊|, ½|weighted mean|) and forced to 0 at local extrema, which
 * guarantees the curve stays inside the data's vertical envelope — smooth,
 * but it can never overshoot a point or invent a peak between points.
 */
function monotonePath(seg: SegmentPoint[]): string {
  const n = seg.length;
  const start = `M ${seg[0].x.toFixed(2)} ${seg[0].y.toFixed(2)}`;
  if (n < 2) return start;

  // Secant slopes between consecutive points.
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const h = seg[i + 1].x - seg[i].x;
    dx.push(h);
    slope.push((seg[i + 1].y - seg[i].y) / h);
  }

  // Tangents: one-sided at the ends, Fritsch–Carlson-limited in the interior.
  const tangent: number[] = new Array<number>(n);
  tangent[0] = slope[0];
  tangent[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    const s0 = slope[i - 1];
    const s1 = slope[i];
    const weighted = (s0 * dx[i] + s1 * dx[i - 1]) / (dx[i - 1] + dx[i]);
    // Sign sum is 0 across a local extremum → flat tangent → no overshoot.
    tangent[i] =
      (Math.sign(s0) + Math.sign(s1)) *
        Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(weighted)) || 0;
  }

  // Hermite → cubic Bézier: control points sit ⅓ of the interval along each
  // endpoint's tangent.
  let d = start;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    const c1x = seg[i].x + h;
    const c1y = seg[i].y + tangent[i] * h;
    const c2x = seg[i + 1].x - h;
    const c2y = seg[i + 1].y - tangent[i + 1] * h;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${seg[i + 1].x.toFixed(2)} ${seg[i + 1].y.toFixed(2)}`;
  }
  return d;
}

/** Under-shade: the same curve closed straight down to the baseline. */
function areaPath(seg: SegmentPoint[]): string {
  const baseline = (PAD_T + PLOT_H).toFixed(2);
  const first = seg[0];
  const last = seg[seg.length - 1];
  return `${monotonePath(seg)} L ${last.x.toFixed(2)} ${baseline} L ${first.x.toFixed(2)} ${baseline} Z`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function QualityTrendChart({
  points,
  accent,
  title,
  domain,
  formatValue,
  formatTick,
}: QualityTrendChartProps) {
  // ALL hooks unconditionally at the top — rules of hooks (#310 prevention).
  const gradId = useId();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Measure the always-rendered card (content box = available chart width).
  // ResizeObserver delivers an initial entry on observe(), so no synchronous
  // setState is needed here.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth((prev) => {
          const next = Math.round(entry.contentRect.width);
          return next === prev ? prev : next;
        });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const geom = useMemo(
    () => computeGeometry(points, width, domain),
    [points, width, domain],
  );

  const n = points.length;
  const hasData = useMemo(() => points.some((p) => p.value != null), [points]);
  const multiYear = n > 1 && points[0].date.slice(0, 4) !== points[n - 1].date.slice(0, 4);

  const fmtTickDate = (key: string): string =>
    utcDay(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const fmtTipDate = (key: string): string =>
    utcDay(key).toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
      ...(multiYear ? { year: 'numeric' as const } : {}),
    });

  function handleMouseMove(e: React.MouseEvent<SVGSVGElement>): void {
    if (n === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    if (mx < PAD_L - 10 || mx > geom.width - PAD_R + 10) {
      setHoverIdx(null);
      return;
    }
    const idx =
      n <= 1 ? 0 : clamp(Math.round(((mx - PAD_L) / geom.plotW) * (n - 1)), 0, n - 1);
    setHoverIdx((prev) => (prev === idx ? prev : idx));
  }

  function handleMouseLeave(): void {
    setHoverIdx(null);
  }

  // Header renders in every state so the panel keeps its rhythm.
  const header = (
    <div className="dl-qtc-titlerow">
      <span className="dl-qtc-swatch" style={{ background: accent }} aria-hidden="true" />
      <span className="dl-qtc-title">{title}</span>
    </div>
  );

  // Early returns AFTER all hooks.
  if (n === 0 || !hasData) {
    return (
      <div ref={boxRef} className="dl-qtc">
        {header}
        <div className="dl-qtc-empty" style={{ height: SVG_H }}>
          No data in range
        </div>
      </div>
    );
  }

  const measured = width >= MIN_RENDER_WIDTH;
  const hovered = hoverIdx != null && hoverIdx < n ? points[hoverIdx] : null;
  const hoveredX = hoverIdx != null && hoverIdx < n ? geom.xFor(hoverIdx) : 0;

  // Tooltip anchor: above the data point (or mid-plot for empty days), flipped
  // below when too close to the top; center clamped inside the frame.
  const anchorY = hovered?.value != null ? geom.yFor(hovered.value) : PAD_T + PLOT_H * 0.4;
  const tipBelow = anchorY < PAD_T + 100;
  const tipLeft = measured ? clamp(hoveredX, 108, Math.max(geom.width - 108, 108)) : 0;

  const sampleLine = (p: TrendPoint): string => {
    if (p.totalCalls === 0) return 'No calls this day';
    if (p.sampleCount === p.totalCalls) return `${p.totalCalls} ${plural(p.totalCalls)}`;
    return `${p.sampleCount} of ${p.totalCalls} ${plural(p.totalCalls)}`;
  };

  return (
    <div ref={boxRef} className="dl-qtc">
      {header}
      <div className="dl-qtc-frame" style={{ height: SVG_H }}>
        {measured && (
          <svg
            className="dl-qtc-svg"
            width={geom.width}
            height={SVG_H}
            role="img"
            aria-label={`${title} — daily average trend`}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
          >
            <defs>
              {/* Under-shade: accent at 12% alpha at the line → 0 at the
                  baseline. Default objectBoundingBox units scale the ramp to
                  each area path's own bbox, so every segment fades fully. */}
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={accent} stopOpacity={0.12} />
                <stop offset="100%" stopColor={accent} stopOpacity={0} />
              </linearGradient>
            </defs>

            {/* Hairline horizontal grid + y tick numbers */}
            {geom.yTicks.map((tick) => {
              const y = crisp(geom.yFor(tick));
              return (
                <g key={tick}>
                  <line x1={PAD_L} y1={y} x2={geom.width - PAD_R} y2={y} stroke={GRID_LINE} strokeWidth={1} />
                  <text
                    x={PAD_L - 8}
                    y={y + 3.5}
                    textAnchor="end"
                    fontSize={11}
                    fill={INK_TICK}
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {formatTick(tick)}
                  </text>
                </g>
              );
            })}

            {/* X date ticks */}
            {geom.xLabelIdx.map((i) => {
              const x = geom.xFor(i);
              const nearRightEdge = x > geom.width - 24;
              return (
                <text
                  key={points[i].date}
                  x={nearRightEdge ? geom.width - 2 : x}
                  y={SVG_H - 8}
                  textAnchor={nearRightEdge ? 'end' : 'middle'}
                  fontSize={11}
                  fill={INK_TICK}
                >
                  {fmtTickDate(points[i].date)}
                </text>
              );
            })}

            {/* Under-shade per contiguous segment (never bridges a gap) */}
            {geom.segments.map(
              (seg) => seg.length >= 2 && <path key={`a-${seg[0].index}`} d={areaPath(seg)} fill={`url(#${gradId})`} />,
            )}

            {/* Line per contiguous segment — monotone cubic */}
            {geom.segments.map(
              (seg) =>
                seg.length >= 2 && (
                  <path
                    key={`l-${seg[0].index}`}
                    d={monotonePath(seg)}
                    fill="none"
                    stroke={accent}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ),
            )}

            {/* Hover guide */}
            {hovered && (
              <line
                x1={crisp(hoveredX)}
                y1={PAD_T}
                x2={crisp(hoveredX)}
                y2={PAD_T + PLOT_H}
                stroke={GUIDE_LINE}
                strokeWidth={1}
              />
            )}

            {/* Markers on every real data day (isolated days stay visible) */}
            {geom.segments.map((seg) =>
              seg.map((p) => (
                <circle
                  key={`m-${p.index}`}
                  cx={p.x}
                  cy={p.y}
                  r={hoverIdx === p.index ? 4.5 : 3}
                  fill={accent}
                  stroke="#ffffff"
                  strokeWidth={1.5}
                />
              )),
            )}
          </svg>
        )}

        {/* Tooltip — date, exact value, sample size */}
        {measured && hovered && (
          <div
            className="dl-qtc-tip"
            style={{
              left: tipLeft,
              top: tipBelow ? anchorY + 14 : anchorY - 12,
              transform: tipBelow ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
            }}
          >
            <div className="dl-qtc-tip-date">{fmtTipDate(hovered.date)}</div>
            {hovered.value != null && (
              <div className="dl-qtc-tip-value">{formatValue(hovered.value)}</div>
            )}
            <div className="dl-qtc-tip-sub">{sampleLine(hovered)}</div>
          </div>
        )}
      </div>
    </div>
  );
}
