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
 *   2. CONTINUOUS TREND, HONEST MARKERS. The x-axis is the FULL selected date
 *      range, one slot per day, but the line is ONE continuous path through
 *      every real data point — consecutive points connect directly across
 *      no-data days (no synthetic/interpolated points), and a single
 *      under-shade spans first → last data day. Markers and hover targets
 *      exist ONLY on real data days, so which dates actually measured calls
 *      stays legible. A lone data point renders as a marker only.
 *
 *   3. NON-OVERSHOOTING SMOOTHING. The series is curved with a monotone cubic
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

interface PlottedPoint {
  x: number;
  y: number;
  /** Index of this point's day slot in the full `points` array. */
  index: number;
}

interface Geometry {
  width: number;
  /** 3–4 light horizontal gridline values. */
  yTicks: number[];
  /** 4–5 labeled day indices. */
  xLabelIdx: number[];
  /** Every real data day as a plotted point — one continuous series. */
  linePts: PlottedPoint[];
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

  // --- Plotted points: every real data day, in order. Consecutive points
  // connect directly, so the line and shade bridge no-data days by
  // construction — no null-breaking, no synthetic points.
  const linePts: PlottedPoint[] = [];
  points.forEach((p, i) => {
    if (p.value != null) linePts.push({ x: xFor(i), y: yFor(p.value), index: i });
  });

  return { width, yTicks, xLabelIdx, linePts, xFor, yFor };
}

// ---------------------------------------------------------------------------
// Path builders — monotone cubic line + closed under-shade
// ---------------------------------------------------------------------------

/**
 * Monotone cubic path through the whole series (Fritsch–Carlson tangents —
 * the rule behind d3's curveMonotoneX). Interior tangents are slope-limited
 * to min(|s₋|, |s₊|, ½|weighted mean|) and forced to 0 at local extrema,
 * which guarantees the curve stays inside the data's vertical envelope —
 * smooth, but it can never overshoot a point or invent a peak between
 * points. The dx-weighted tangents already handle the uneven x spacing that
 * bridged no-data gaps produce.
 */
function monotonePath(pts: PlottedPoint[]): string {
  const n = pts.length;
  const start = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  if (n < 2) return start;

  // Secant slopes between consecutive points.
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const h = pts[i + 1].x - pts[i].x;
    dx.push(h);
    slope.push((pts[i + 1].y - pts[i].y) / h);
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
    const c1x = pts[i].x + h;
    const c1y = pts[i].y + tangent[i] * h;
    const c2x = pts[i + 1].x - h;
    const c2y = pts[i + 1].y - tangent[i + 1] * h;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${pts[i + 1].x.toFixed(2)} ${pts[i + 1].y.toFixed(2)}`;
  }
  return d;
}

/** Under-shade: the line path closed straight down to the baseline. */
function areaPath(linePath: string, pts: PlottedPoint[]): string {
  const baseline = (PAD_T + PLOT_H).toFixed(2);
  const first = pts[0];
  const last = pts[pts.length - 1];
  return `${linePath} L ${last.x.toFixed(2)} ${baseline} L ${first.x.toFixed(2)} ${baseline} Z`;
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

  // One continuous line + under-shade through every real data point. A lone
  // point has no path — it renders as a marker only.
  const paths = useMemo(() => {
    if (geom.linePts.length < 2) return null;
    const line = monotonePath(geom.linePts);
    return { line, area: areaPath(line, geom.linePts) };
  }, [geom]);

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

  // Hover snaps to the nearest REAL data point — bridged days have no
  // tooltip targets of their own.
  function handleMouseMove(e: React.MouseEvent<SVGSVGElement>): void {
    const pts = geom.linePts;
    if (pts.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    if (mx < PAD_L - 10 || mx > geom.width - PAD_R + 10) {
      setHoverIdx(null);
      return;
    }
    let nearest = pts[0];
    for (const p of pts) {
      if (Math.abs(p.x - mx) < Math.abs(nearest.x - mx)) nearest = p;
    }
    setHoverIdx((prev) => (prev === nearest.index ? prev : nearest.index));
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
  // Hover only ever lands on a real data day; resolve it back to its plotted
  // point (x/y precomputed) — a stale index simply fails the lookup.
  const hoveredPt =
    hoverIdx != null ? (geom.linePts.find((p) => p.index === hoverIdx) ?? null) : null;
  const hovered = hoveredPt ? points[hoveredPt.index] : null;

  // Tooltip anchor: above the data point, flipped below when too close to the
  // top; center clamped inside the frame.
  const anchorY = hoveredPt?.y ?? 0;
  const tipBelow = anchorY < PAD_T + 100;
  const tipLeft = measured ? clamp(hoveredPt?.x ?? 0, 108, Math.max(geom.width - 108, 108)) : 0;

  const sampleLine = (p: TrendPoint): string =>
    p.sampleCount === p.totalCalls
      ? `${p.totalCalls} ${plural(p.totalCalls)}`
      : `${p.sampleCount} of ${p.totalCalls} ${plural(p.totalCalls)}`;

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
              {/* Under-shade: accent at 25% alpha at the line → 0 at the
                  baseline. Default objectBoundingBox units scale the ramp to
                  the area path's bbox, so the fade fully spans peak → base. */}
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={accent} stopOpacity={0.25} />
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

            {/* Under-shade — one continuous fill, first → last data day */}
            {paths && <path d={paths.area} fill={`url(#${gradId})`} />}

            {/* Line — one continuous monotone cubic through every data day */}
            {paths && (
              <path
                d={paths.line}
                fill="none"
                stroke={accent}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}

            {/* Hover guide */}
            {hoveredPt && (
              <line
                x1={crisp(hoveredPt.x)}
                y1={PAD_T}
                x2={crisp(hoveredPt.x)}
                y2={PAD_T + PLOT_H}
                stroke={GUIDE_LINE}
                strokeWidth={1}
              />
            )}

            {/* Markers on real data days ONLY — they show which dates have data */}
            {geom.linePts.map((p) => (
              <circle
                key={p.index}
                cx={p.x}
                cy={p.y}
                r={hoverIdx === p.index ? 4.5 : 3}
                fill={accent}
                stroke="#ffffff"
                strokeWidth={1.5}
              />
            ))}
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
