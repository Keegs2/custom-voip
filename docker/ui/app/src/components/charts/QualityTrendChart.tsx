/**
 * QualityTrendChart — shared daily-average trend chart for voice-quality
 * metrics (MOS / packet loss / jitter) on the daylight canvas.
 *
 * Why this exists (CallQualityPage chart history):
 *
 *   1. TRUE-PIXEL TEXT. The SVG is drawn at the container's real pixel width
 *      (ResizeObserver) — never scaled through a fixed viewBox. The old chart
 *      rendered a 500px-wide viewBox into ~340px columns, shrinking its 9px
 *      mono tick labels to ~6px. Here 11px axis text is really 11px.
 *
 *   2. HONEST GAPS. The x-axis is the FULL selected date range, one slot per
 *      day. Days with no measured calls break the line — no interpolation,
 *      and area fill is built PER contiguous segment. (The old single area
 *      path closed the first line segment against the last point of the
 *      whole series, painting a giant wedge across multi-day gaps that read
 *      as a quality collapse.) Isolated single-day segments render as a
 *      marker only — no degenerate line or fill. Straight segments replace
 *      the old cubic smoothing, which overshot into false V-shapes.
 *
 *   3. OPERATOR CONTEXT. Good / fair / poor reference bands render as very
 *      muted washes with dashed boundary hairlines, in-plot region labels,
 *      and a legend carrying the exact thresholds — so "what is good" is on
 *      the chart, without traffic-light noise.
 *
 * Purely presentational: callers aggregate CDRs into one TrendPoint per day.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import '../../styles/dl-trend-chart.css';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TrendTone = 'good' | 'fair' | 'poor';

export interface TrendBand {
  /** Inclusive lower edge in metric units (-Infinity for an open bottom). */
  from: number;
  /** Exclusive upper edge in metric units (Infinity for an open top). */
  to: number;
  tone: TrendTone;
  /** Legend text with the exact threshold, e.g. "good ≥ 4.0". */
  label: string;
  /**
   * Optional threshold to mark with a dashed hairline — the edge of this
   * band that faces the better band (e.g. 4.0 for the MOS "fair" band).
   */
  edge?: number;
}

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
  /** Fixed top, or 'auto' — grow from data but never below `autoFloor`. */
  max: number | 'auto';
  /** Minimum top of an auto domain — keeps threshold bands visible when the data is tiny. */
  autoFloor?: number;
}

export interface QualityTrendChartProps {
  points: TrendPoint[];
  /** Series stroke / marker color. */
  accent: string;
  /** Header, e.g. "MOS — perceived voice quality". */
  title: string;
  /** One-line plain-language explainer under the title. */
  subtitle: string;
  /** Y-axis caption with units, e.g. "MOS (1–5)". */
  axisTitle: string;
  bands: TrendBand[];
  domain: TrendDomain;
  /** Exact value for the tooltip, e.g. 4.312 → "4.31". */
  formatValue: (v: number) => string;
  /** Axis tick label, e.g. 2.5 → "2.5%". */
  formatTick: (v: number) => string;
  /** Verb for the tooltip sample line, e.g. "scored" → "12 of 14 calls scored". */
  sampleNoun?: string;
  /** Shown when no day in the range carries the metric. */
  emptyMessage?: string;
}

// ---------------------------------------------------------------------------
// Daylight palette (mirrors --rcf-* vars; SVG attrs can't read CSS vars in
// every renderer, so the ink scale is restated here once)
// ---------------------------------------------------------------------------

const INK_TICK = '#46566f'; // axis tick labels — 6.5:1 on the tint canvas
const INK_AXIS = '#5d6f8c'; // axis captions — 4.7:1
const GRID_LINE = 'rgba(14, 23, 38, 0.055)';
const BASELINE = 'rgba(14, 23, 38, 0.16)';
const GUIDE_LINE = 'rgba(14, 23, 38, 0.18)';
const CANVAS_TINT = '#f7f9fc'; // --rcf-tint — halo color for in-plot labels

/** Status tones — very muted washes for bands, ink-dark text for labels. */
const TONE: Record<TrendTone, { line: string; text: string; wash: string; swatchBg: string; swatchBorder: string }> = {
  good: {
    line: '#16a34a',
    text: '#15803d',
    wash: 'rgba(22, 163, 74, 0.05)',
    swatchBg: 'rgba(22, 163, 74, 0.3)',
    swatchBorder: 'rgba(22, 163, 74, 0.55)',
  },
  fair: {
    line: '#d97706',
    text: '#b45309',
    wash: 'rgba(217, 119, 6, 0.055)',
    swatchBg: 'rgba(217, 119, 6, 0.3)',
    swatchBorder: 'rgba(217, 119, 6, 0.55)',
  },
  poor: {
    line: '#dc2626',
    text: '#b91c1c',
    wash: 'rgba(220, 38, 38, 0.045)',
    swatchBg: 'rgba(220, 38, 38, 0.26)',
    swatchBorder: 'rgba(220, 38, 38, 0.5)',
  },
};

// ---------------------------------------------------------------------------
// Fixed layout metrics (real pixels — the SVG is never viewBox-scaled)
// ---------------------------------------------------------------------------

const PAD_L = 46; // y tick label gutter
const PAD_R = 14;
const PAD_T = 30; // axis caption row
const PAD_B = 32; // x tick labels
const PLOT_H = 224;
const SVG_H = PAD_T + PLOT_H + PAD_B; // 286
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

interface BandRect {
  y: number;
  h: number;
  tone: TrendTone;
}

interface BandEdge {
  y: number;
  tone: TrendTone;
}

interface Geometry {
  width: number;
  plotW: number;
  dMin: number;
  dMax: number;
  yTicks: number[];
  xLabelIdx: number[];
  /** Contiguous non-null runs; length-1 runs are marker-only. */
  segments: SegmentPoint[][];
  bandRects: BandRect[];
  bandEdges: BandEdge[];
  xFor: (i: number) => number;
  yFor: (v: number) => number;
}

function computeGeometry(
  points: TrendPoint[],
  width: number,
  domain: TrendDomain,
  bands: TrendBand[],
): Geometry {
  const n = points.length;
  const plotW = Math.max(width - PAD_L - PAD_R, 10);

  // --- Y domain: fixed, or auto with a floor so threshold bands stay visible
  const values = points.map((p) => p.value).filter((v): v is number => v != null);
  const dataMax = values.length > 0 ? Math.max(...values) : 0;
  const dMin = domain.min;
  let dMax: number;
  let step: number;
  if (domain.max === 'auto') {
    const raw = Math.max(domain.autoFloor ?? dMin + 1, dataMax * 1.15, dMin + 1e-6);
    step = niceStep((raw - dMin) / 4);
    dMax = dMin + Math.ceil((raw - dMin) / step - 1e-9) * step;
  } else {
    dMax = domain.max;
    step = niceStep((dMax - dMin) / 4);
  }
  const range = dMax - dMin || 1;

  const yTicks: number[] = [];
  for (let t = dMin; t <= dMax + 1e-9; t += step) {
    yTicks.push(Number(t.toFixed(6)));
  }

  const yFor = (v: number): number =>
    PAD_T + PLOT_H - ((clamp(v, dMin, dMax) - dMin) / range) * PLOT_H;
  const xFor = (i: number): number =>
    n <= 1 ? PAD_L + plotW / 2 : PAD_L + (i / (n - 1)) * plotW;

  // --- X tick indices, width-adaptive (~64px per "Aug 12" label)
  const maxLabels = Math.max(2, Math.floor(plotW / 64));
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

  // --- Reference bands clamped to the domain
  const bandRects: BandRect[] = [];
  const bandEdges: BandEdge[] = [];
  for (const band of bands) {
    const lo = clamp(band.from, dMin, dMax);
    const hi = clamp(band.to, dMin, dMax);
    if (hi > lo) {
      const yTop = yFor(hi);
      bandRects.push({ y: yTop, h: yFor(lo) - yTop, tone: band.tone });
    }
    if (band.edge != null && band.edge > dMin && band.edge < dMax) {
      bandEdges.push({ y: yFor(band.edge), tone: band.tone });
    }
  }

  return { width, plotW, dMin, dMax, yTicks, xLabelIdx, segments, bandRects, bandEdges, xFor, yFor };
}

function linePath(seg: SegmentPoint[]): string {
  return seg
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(' ');
}

function areaPath(seg: SegmentPoint[]): string {
  const baseline = (PAD_T + PLOT_H).toFixed(2);
  const first = seg[0];
  const last = seg[seg.length - 1];
  return `${linePath(seg)} L ${last.x.toFixed(2)} ${baseline} L ${first.x.toFixed(2)} ${baseline} Z`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function QualityTrendChart({
  points,
  accent,
  title,
  subtitle,
  axisTitle,
  bands,
  domain,
  formatValue,
  formatTick,
  sampleNoun = 'measured',
  emptyMessage = 'No measured calls in this range.',
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
    () => computeGeometry(points, width, domain, bands),
    [points, width, domain, bands],
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

  // Header + legend render in every state so the panel keeps its rhythm.
  const header = (
    <>
      <div className="dl-qtc-head">
        <div className="dl-qtc-titlerow">
          <span className="dl-qtc-swatch" style={{ background: accent }} aria-hidden="true" />
          <span className="dl-qtc-title">{title}</span>
        </div>
        <div className="dl-qtc-sub">{subtitle}</div>
      </div>
      <div className="dl-qtc-legend" aria-label="Reference thresholds">
        {bands.map((band) => (
          <span key={band.label} className="dl-qtc-legend-item" style={{ color: TONE[band.tone].text }}>
            <span
              className="dl-qtc-legend-swatch"
              style={{
                background: TONE[band.tone].swatchBg,
                border: `1px solid ${TONE[band.tone].swatchBorder}`,
              }}
              aria-hidden="true"
            />
            {band.label}
          </span>
        ))}
      </div>
    </>
  );

  // Early returns AFTER all hooks.
  if (n === 0 || !hasData) {
    return (
      <div ref={boxRef} className="dl-qtc">
        {header}
        <div className="dl-qtc-empty" style={{ height: SVG_H }}>
          {emptyMessage}
        </div>
      </div>
    );
  }

  const measured = width >= MIN_RENDER_WIDTH;
  const hovered = hoverIdx != null && hoverIdx < n ? points[hoverIdx] : null;
  const hoveredX = hoverIdx != null && hoverIdx < n ? geom.xFor(hoverIdx) : 0;
  const hoveredBand =
    hovered?.value != null
      ? bands.find((b) => hovered.value! >= b.from && hovered.value! < b.to)
      : undefined;

  // Tooltip anchor: above the data point (or mid-plot for empty days), flipped
  // below when too close to the top; center clamped inside the frame.
  const anchorY = hovered?.value != null ? geom.yFor(hovered.value) : PAD_T + PLOT_H * 0.4;
  const tipBelow = anchorY < PAD_T + 100;
  const tipLeft = measured ? clamp(hoveredX, 108, Math.max(geom.width - 108, 108)) : 0;

  const sampleLine = (p: TrendPoint): string => {
    if (p.totalCalls === 0) return 'No calls this day';
    if (p.sampleCount === 0) return `${p.totalCalls} ${plural(p.totalCalls)} · none ${sampleNoun}`;
    if (p.sampleCount === p.totalCalls) return `${p.totalCalls} ${plural(p.totalCalls)} ${sampleNoun}`;
    return `${p.sampleCount} of ${p.totalCalls} calls ${sampleNoun}`;
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
            aria-label={`${title}. Daily averages from ${fmtTipDate(points[0].date)} to ${fmtTipDate(points[n - 1].date)}.`}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
          >
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={accent} stopOpacity={0.12} />
                <stop offset="100%" stopColor={accent} stopOpacity={0} />
              </linearGradient>
            </defs>

            {/* Reference band washes (very muted) */}
            {geom.bandRects.map((band) => (
              <rect
                key={`${band.tone}-${band.y}`}
                x={PAD_L}
                y={band.y}
                width={geom.plotW}
                height={band.h}
                fill={TONE[band.tone].wash}
              />
            ))}

            {/* Horizontal grid + y tick labels */}
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

            {/* Dashed threshold hairlines on band edges */}
            {geom.bandEdges.map((edge) => (
              <line
                key={`edge-${edge.tone}-${edge.y}`}
                x1={PAD_L}
                y1={crisp(edge.y)}
                x2={geom.width - PAD_R}
                y2={crisp(edge.y)}
                stroke={TONE[edge.tone].line}
                strokeOpacity={0.38}
                strokeWidth={1}
                strokeDasharray="4 4"
              />
            ))}

            {/* In-plot band labels (right edge, only when the region is tall enough) */}
            {geom.bandRects.map((band) =>
              band.h >= 16 ? (
                <text
                  key={`label-${band.tone}-${band.y}`}
                  x={geom.width - PAD_R - 6}
                  y={band.y + band.h / 2 + 3.5}
                  textAnchor="end"
                  fontSize={10}
                  fontWeight={700}
                  letterSpacing="0.08em"
                  fill={TONE[band.tone].text}
                  stroke={CANVAS_TINT}
                  strokeWidth={3}
                  strokeLinejoin="round"
                  paintOrder="stroke"
                >
                  {band.tone.toUpperCase()}
                </text>
              ) : null,
            )}

            {/* Baseline + x tick labels */}
            <line
              x1={PAD_L}
              y1={crisp(PAD_T + PLOT_H)}
              x2={geom.width - PAD_R}
              y2={crisp(PAD_T + PLOT_H)}
              stroke={BASELINE}
              strokeWidth={1}
            />
            {geom.xLabelIdx.map((i) => {
              const x = geom.xFor(i);
              const nearRightEdge = x > geom.width - 24;
              return (
                <text
                  key={points[i].date}
                  x={nearRightEdge ? geom.width - 2 : x}
                  y={SVG_H - 10}
                  textAnchor={nearRightEdge ? 'end' : 'middle'}
                  fontSize={11}
                  fill={INK_TICK}
                >
                  {fmtTickDate(points[i].date)}
                </text>
              );
            })}

            {/* Y-axis caption with units */}
            <text x={2} y={14} fontSize={10.5} fontWeight={700} letterSpacing="0.04em" fill={INK_AXIS}>
              {axisTitle}
            </text>

            {/* Area fill per contiguous segment (never bridges a gap) */}
            {geom.segments.map(
              (seg) => seg.length >= 2 && <path key={`a-${seg[0].index}`} d={areaPath(seg)} fill={`url(#${gradId})`} />,
            )}

            {/* Line per contiguous segment */}
            {geom.segments.map(
              (seg) =>
                seg.length >= 2 && (
                  <path
                    key={`l-${seg[0].index}`}
                    d={linePath(seg)}
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
                  r={hoverIdx === p.index ? 4 : 3}
                  fill="#ffffff"
                  stroke={accent}
                  strokeWidth={hoverIdx === p.index ? 2 : 1.6}
                />
              )),
            )}
            {hovered?.value != null && (
              <circle
                cx={hoveredX}
                cy={geom.yFor(hovered.value)}
                r={7}
                fill="none"
                stroke={accent}
                strokeOpacity={0.3}
                strokeWidth={2}
              />
            )}
          </svg>
        )}

        {/* Tooltip — date, exact value + band tone, sample size */}
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
              <div className="dl-qtc-tip-value">
                {formatValue(hovered.value)}
                {hoveredBand && (
                  <span className="dl-qtc-tip-tone" style={{ color: TONE[hoveredBand.tone].text }}>
                    {hoveredBand.tone}
                  </span>
                )}
              </div>
            )}
            <div className="dl-qtc-tip-sub">{sampleLine(hovered)}</div>
          </div>
        )}
      </div>
    </div>
  );
}
