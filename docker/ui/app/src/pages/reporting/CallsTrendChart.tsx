/**
 * CallsTrendChart — "calls over time" as stacked bars: answered (brand azure)
 * at the bottom, missed (neutral slate) on top, one bar per day / week / month bucket.
 *
 * Built in the same hand-rolled idiom as components/charts/QualityTrendChart:
 *   - TRUE-PIXEL TEXT: the SVG is drawn at the container's measured width
 *     (ResizeObserver), never scaled through a viewBox, so 11px ticks are 11px.
 *   - Quiet chrome: hairline grid, 3–4 nice integer y ticks, 4–6 date labels,
 *     a raised tooltip card (reuses the shared `dl-qtc-*` styles).
 *   - THEMED (docker/ui/CLAUDE.md §18): series, ticks, grid and hover band are
 *     theme tokens (CHART roles + the `--rpt-chart-*` page tokens in
 *     dl-trend-chart.css), painted through `style` — never the fill=/stroke=
 *     attributes, which don't reliably resolve `var()`.
 *
 * Height: fixed (250px) by default. With `fill` the chart takes the height
 * its flex-column parent gives it (min 230px) — the Reporting page sets the
 * summary card beside it as the row's leader and the chart follows, so the
 * two cards end level (docker/ui/CLAUDE.md §20.3). The frame is absolutely
 * positioned in that box, so the drawn SVG never feeds back into the row's
 * height (no ratchet on resize).
 *
 * Accessibility: the plot is one focusable element — Left/Right (and
 * Home/End) walk the buckets and the tooltip text is mirrored into a polite
 * live region; a visually-hidden table carries every value for screen
 * readers. Color is never the only signal: the legend and tooltip spell out
 * "answered" and "missed".
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { ReportTrendPoint, TrendBucket } from '../../types/reports';
import { dayKeyToUtc, fmtMinutes, plural, TREND_SERIES } from './reportFormat';
import { CHART } from '../../styles/theme';
import '../../styles/dl-trend-chart.css';

const ANSWERED = TREND_SERIES.answered;
const MISSED = TREND_SERIES.missed;
/** Tick labels: ink-soft on paper (as before), the chart label tone on granite. */
const INK_TICK = 'var(--rpt-chart-tick)';
/** Gridlines: ink 5.5 % on paper (as before), the chart grid on granite. */
const GRID_LINE = 'var(--rpt-chart-grid)';
const HOVER_BAND = CHART.hoverBand;

const PAD_L = 40;
const PAD_R = 10;
const PAD_T = 12;
const PAD_B = 28;
/** Default plot height (SVG 250px). */
const PLOT_H = 210;
/** `fill` mode never draws a plot shorter than this. */
const MIN_PLOT_H = 150;
const MIN_RENDER_WIDTH = 120;

function niceIntStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 1) return 1;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const frac = rough / pow;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10;
  return Math.max(1, Math.round(nice * pow));
}

function crisp(y: number): number {
  return Math.round(y) + 0.5;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

interface Labels {
  tick: (key: string) => string;
  tip: (key: string) => string;
}

function bucketLabels(bucket: TrendBucket, multiYear: boolean): Labels {
  const utc = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, { ...opts, timeZone: 'UTC' });
  const shortDay = utc({ month: 'short', day: 'numeric', ...(multiYear ? { year: '2-digit' as const } : {}) });
  const tipDay = utc({ weekday: 'short', month: 'short', day: 'numeric', ...(multiYear ? { year: 'numeric' as const } : {}) });
  const shortMonth = utc(multiYear ? { month: 'short', year: '2-digit' } : { month: 'short' });
  const longMonth = utc({ month: 'long', year: 'numeric' });
  switch (bucket) {
    case 'day':
      return { tick: (k) => shortDay.format(dayKeyToUtc(k)), tip: (k) => tipDay.format(dayKeyToUtc(k)) };
    case 'week':
      return { tick: (k) => shortDay.format(dayKeyToUtc(k)), tip: (k) => `Week of ${shortDay.format(dayKeyToUtc(k))}` };
    case 'month':
      return { tick: (k) => shortMonth.format(dayKeyToUtc(k)), tip: (k) => longMonth.format(dayKeyToUtc(k)) };
  }
}

interface CallsTrendChartProps {
  bucket: TrendBucket;
  points: ReportTrendPoint[];
  /** Take the parent's height (a flex column) instead of the fixed 250px. */
  fill?: boolean;
}

export function CallsTrendChart({ bucket, points, fill = false }: CallsTrendChartProps) {
  // ALL hooks unconditionally at the top (React #310 prevention).
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [boxHeight, setBoxHeight] = useState(0);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const nextW = Math.round(entry.contentRect.width);
        const nextH = Math.round(entry.contentRect.height);
        setWidth((prev) => (prev === nextW ? prev : nextW));
        setBoxHeight((prev) => (prev === nextH ? prev : nextH));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Plot height: fixed, or whatever the box was given (fill mode).
  const plotH = fill && boxHeight > 0 ? Math.max(MIN_PLOT_H, boxHeight - PAD_T - PAD_B) : PLOT_H;
  const svgH = PAD_T + plotH + PAD_B;
  const boxClass = fill ? 'rpt-chart-box rpt-chart-box-fill' : 'rpt-chart-box';

  const n = points.length;
  const multiYear = n > 1 && points[0].date.slice(0, 4) !== points[n - 1].date.slice(0, 4);
  const labels = useMemo(() => bucketLabels(bucket, multiYear), [bucket, multiYear]);

  const geom = useMemo(() => {
    const plotW = Math.max(width - PAD_L - PAD_R, 10);
    const dataMax = points.reduce((m, p) => Math.max(m, p.calls), 0);
    const step = niceIntStep(Math.max(dataMax, 1) / 3);
    const top = Math.max(step, Math.ceil(dataMax / step) * step);
    const ticks: number[] = [];
    for (let t = 0; t <= top; t += step) ticks.push(t);
    const slot = n > 0 ? plotW / n : plotW;
    const barW = clamp(slot * 0.68, 2, 40);
    const yFor = (v: number) => PAD_T + plotH - (v / top) * plotH;
    const xCenter = (i: number) => PAD_L + slot * (i + 0.5);
    const maxLabels = clamp(Math.floor(plotW / 78), 2, 7);
    const every = Math.max(1, Math.ceil(n / maxLabels));
    const labelIdx: number[] = [];
    for (let i = 0; i < n; i += every) labelIdx.push(i);
    return { plotW, top, ticks, slot, barW, yFor, xCenter, labelIdx };
  }, [points, width, n, plotH]);

  const hasCalls = points.some((p) => p.calls > 0);
  const measured = width >= MIN_RENDER_WIDTH;
  const bucketNoun = bucket === 'day' ? 'day' : bucket === 'week' ? 'week' : 'month';

  function describe(p: ReportTrendPoint): string {
    return `${labels.tip(p.date)}: ${plural(p.calls, 'call', 'calls')}, ${p.answered.toLocaleString()} answered, ${p.missed.toLocaleString()} missed, ${fmtMinutes(p.minutes)} talking.`;
  }

  function handleMouseMove(e: MouseEvent<SVGSVGElement>): void {
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

  if (n === 0 || !hasCalls) {
    return (
      <div ref={boxRef} className={boxClass}>
        <div className="dl-qtc-empty" style={{ height: fill ? '100%' : 180 }}>
          No calls in this period yet — this chart fills in as calls come in.
        </div>
      </div>
    );
  }

  const activePoint = active != null ? (points[active] ?? null) : null;
  const tipX = activePoint && active != null ? clamp(geom.xCenter(active), 100, Math.max(width - 100, 100)) : 0;
  const tipTop = activePoint ? geom.yFor(activePoint.calls) : 0;
  const tipBelow = tipTop < PAD_T + 96;

  return (
    <div ref={boxRef} className={boxClass}>
      <div className="dl-qtc-frame" style={{ height: svgH }}>
        {measured && (
          <svg
            className="dl-qtc-svg rpt-chart-svg"
            width={width}
            height={svgH}
            role="group"
            tabIndex={0}
            aria-label={`Calls per ${bucketNoun}, answered and missed. Use the left and right arrow keys to read each ${bucketNoun}.`}
            onMouseMove={handleMouseMove}
            onMouseLeave={() => setActive(null)}
            onKeyDown={handleKeyDown}
            onBlur={() => setActive(null)}
          >
            {geom.ticks.map((t) => {
              const y = crisp(geom.yFor(t));
              return (
                <g key={t}>
                  <line x1={PAD_L} y1={y} x2={width - PAD_R} y2={y} strokeWidth={1} style={{ stroke: GRID_LINE }} />
                  <text x={PAD_L - 8} y={y + 3.5} textAnchor="end" fontSize={11} style={{ fill: INK_TICK, fontVariantNumeric: 'tabular-nums' }}>
                    {t.toLocaleString()}
                  </text>
                </g>
              );
            })}

            {active != null && (
              <rect
                x={PAD_L + geom.slot * active}
                y={PAD_T}
                width={geom.slot}
                height={plotH}
                style={{ fill: HOVER_BAND }}
                rx={4}
              />
            )}

            {points.map((p, i) => {
              if (p.calls === 0) return null;
              const x = geom.xCenter(i) - geom.barW / 2;
              const answeredTop = geom.yFor(p.answered);
              const totalTop = geom.yFor(p.answered + p.missed);
              const base = PAD_T + plotH;
              const radius = Math.min(3, geom.barW / 3);
              return (
                <g key={p.date} aria-hidden="true">
                  {p.answered > 0 && (
                    <rect x={x} y={answeredTop} width={geom.barW} height={Math.max(base - answeredTop, 1)} style={{ fill: ANSWERED }} rx={p.missed > 0 ? 0 : radius} />
                  )}
                  {p.missed > 0 && (
                    <rect x={x} y={totalTop} width={geom.barW} height={Math.max(answeredTop - totalTop, 1.5)} style={{ fill: MISSED }} rx={radius} />
                  )}
                </g>
              );
            })}

            {geom.labelIdx.map((i) => {
              const x = geom.xCenter(i);
              const nearRight = x > width - 30;
              const nearLeft = x < PAD_L + 14;
              return (
                <text
                  key={points[i].date}
                  x={nearRight ? width - 2 : x}
                  y={svgH - 8}
                  textAnchor={nearRight ? 'end' : nearLeft ? 'start' : 'middle'}
                  fontSize={11}
                  style={{ fill: INK_TICK }}
                >
                  {labels.tick(points[i].date)}
                </text>
              );
            })}
          </svg>
        )}

        {measured && activePoint && (
          <div
            className="dl-qtc-tip"
            aria-hidden="true"
            style={{
              left: tipX,
              top: tipBelow ? tipTop + 14 : tipTop - 12,
              transform: tipBelow ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
            }}
          >
            <div className="dl-qtc-tip-date">{labels.tip(activePoint.date)}</div>
            <div className="dl-qtc-tip-value">{plural(activePoint.calls, 'call', 'calls')}</div>
            <div className="dl-qtc-tip-sub">
              {activePoint.answered.toLocaleString()} answered · {activePoint.missed.toLocaleString()} missed
            </div>
            <div className="dl-qtc-tip-sub">{fmtMinutes(activePoint.minutes)} talking</div>
          </div>
        )}
      </div>

      {/* Keyboard readout for assistive tech */}
      <div className="rpt-sr" aria-live="polite">
        {activePoint ? describe(activePoint) : ''}
      </div>

      {/* Full data for screen readers */}
      <table className="rpt-sr">
        <caption>Calls per {bucketNoun}</caption>
        <thead>
          <tr>
            <th scope="col">{bucket === 'week' ? 'Week of' : bucket === 'month' ? 'Month' : 'Day'}</th>
            <th scope="col">Calls</th>
            <th scope="col">Answered</th>
            <th scope="col">Missed</th>
            <th scope="col">Minutes</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.date}>
              <th scope="row">{labels.tip(p.date)}</th>
              <td>{p.calls}</td>
              <td>{p.answered}</td>
              <td>{p.missed}</td>
              <td>{p.minutes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
