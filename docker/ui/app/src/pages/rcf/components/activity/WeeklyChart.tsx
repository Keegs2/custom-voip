/**
 * WeeklyChart — the 7-day MOS + ASR performance chart for the Call Activity tab.
 * Monotone-cubic spline lines with gap handling, dual Y axes, and a hover
 * tooltip. Rendered inside a frosted glass panel.
 */

import { useMemo, useState } from 'react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import type { DailyStats } from '../../types';

export function WeeklyChart({ days }: { days: DailyStats[] }) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // Chart geometry
  const W = 600;
  const H = 180;
  const PAD_LEFT = 36;
  const PAD_RIGHT = 36;
  const PAD_TOP = 14;
  const PAD_BOTTOM = 28;
  const innerW = W - PAD_LEFT - PAD_RIGHT;
  const innerH = H - PAD_TOP - PAD_BOTTOM;

  const xPos = (i: number) => PAD_LEFT + (i / 6) * innerW;
  const yMos = (v: number) => PAD_TOP + (1 - (v - 1) / 4) * innerH;
  const yAsr = (v: number) => PAD_TOP + (1 - v / 100) * innerH;

  function monotoneCubicPath(pts: Array<{ x: number; y: number }>): string {
    if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
    const n = pts.length;
    const dx = pts.map((p, i) => (i < n - 1 ? pts[i + 1].x - p.x : 0));
    const dy = pts.map((p, i) => (i < n - 1 ? pts[i + 1].y - p.y : 0));
    const m = pts.map((_, i) => (i < n - 1 ? dy[i] / dx[i] : 0));
    const t: number[] = new Array(n).fill(0);
    t[0] = m[0];
    t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) t[i] = (m[i - 1] + m[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (m[i] === 0) { t[i] = t[i + 1] = 0; continue; }
      const alpha = t[i] / m[i];
      const beta = t[i + 1] / m[i];
      const s = alpha * alpha + beta * beta;
      if (s > 9) { const k = 3 / Math.sqrt(s); t[i] *= k; t[i + 1] *= k; }
    }
    let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
    for (let i = 0; i < n - 1; i++) {
      const cp1x = pts[i].x + dx[i] / 3;
      const cp1y = pts[i].y + (t[i] * dx[i]) / 3;
      const cp2x = pts[i + 1].x - dx[i] / 3;
      const cp2y = pts[i + 1].y - (t[i + 1] * dx[i]) / 3;
      d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${pts[i + 1].x.toFixed(2)} ${pts[i + 1].y.toFixed(2)}`;
    }
    return d;
  }

  function buildSplinePath(points: Array<{ x: number; y: number } | null>): string {
    const segments: string[] = [];
    let run: Array<{ x: number; y: number }> = [];
    const flushRun = () => {
      if (run.length === 0) return;
      if (run.length === 1) segments.push(`M ${run[0].x} ${run[0].y}`);
      else segments.push(monotoneCubicPath(run));
      run = [];
    };
    for (const pt of points) {
      if (pt === null) flushRun();
      else run.push(pt);
    }
    flushRun();
    return segments.join(' ');
  }

  function buildAreaPath(points: Array<{ x: number; y: number } | null>, baseline: number): string {
    const areas: string[] = [];
    let run: Array<{ x: number; y: number }> = [];
    const flushArea = () => {
      if (run.length < 2) { run = []; return; }
      const linePath = monotoneCubicPath(run);
      const closeSegment = ` L ${run[run.length - 1].x.toFixed(2)} ${baseline.toFixed(2)} L ${run[0].x.toFixed(2)} ${baseline.toFixed(2)} Z`;
      areas.push(linePath + closeSegment);
      run = [];
    };
    for (const pt of points) {
      if (pt === null) flushArea();
      else run.push(pt);
    }
    flushArea();
    return areas.join(' ');
  }

  const mosMemo = useMemo(() => {
    const pts = days.map((d, i) => (d.avgMos !== null ? { x: xPos(i), y: yMos(d.avgMos) } : null));
    return { linePath: buildSplinePath(pts), areaPath: buildAreaPath(pts, PAD_TOP + innerH) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const asrMemo = useMemo(() => {
    const pts = days.map((d, i) => (d.asr !== null ? { x: xPos(i), y: yAsr(d.asr) } : null));
    return { linePath: buildSplinePath(pts), areaPath: buildAreaPath(pts, PAD_TOP + innerH) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const hoveredDay = hoveredIdx !== null ? days[hoveredIdx] : null;

  return (
    <GlassPanel padding="16px 20px" radius={14}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <div style={{ width: 22, height: 22, borderRadius: 6, background: 'rgba(96,165,250,0.12)', border: '1px solid rgba(96,165,250,0.22)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <svg viewBox="0 0 16 16" fill="none" stroke="#60a5fa" strokeWidth={1.8} style={{ width: 10, height: 10 }}>
            <polyline points="1,12 5,7 8,9 12,4 15,6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <span style={{ fontSize: '0.68rem', fontWeight: 700, color: GLASS.textFaint, textTransform: 'uppercase', letterSpacing: '0.1em' }}>7-Day Performance</span>
      </div>

      <div style={{ position: 'relative' }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }} aria-label="7-day call quality chart">
          <defs>
            <linearGradient id="mos-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#4ade80" stopOpacity="0.18" />
              <stop offset="100%" stopColor="#4ade80" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="asr-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#60a5fa" stopOpacity="0.14" />
              <stop offset="100%" stopColor="#60a5fa" stopOpacity="0" />
            </linearGradient>
            <filter id="mos-glow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="2" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            <filter id="asr-glow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="2" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>

          {[1, 2, 3, 4, 5].map((mosVal) => (
            <line key={`mos-grid-${mosVal}`} x1={PAD_LEFT} y1={yMos(mosVal)} x2={PAD_LEFT + innerW} y2={yMos(mosVal)} stroke="rgba(255,255,255,0.03)" strokeWidth={1} />
          ))}
          <line x1={PAD_LEFT} y1={yMos(3.0)} x2={PAD_LEFT + innerW} y2={yMos(3.0)} stroke="rgba(245,158,11,0.18)" strokeWidth={1} strokeDasharray="4 4" />
          <line x1={PAD_LEFT} y1={yMos(4.0)} x2={PAD_LEFT + innerW} y2={yMos(4.0)} stroke="rgba(74,222,128,0.14)" strokeWidth={1} strokeDasharray="4 4" />
          <line x1={PAD_LEFT} y1={yAsr(85)} x2={PAD_LEFT + innerW} y2={yAsr(85)} stroke="rgba(245,158,11,0.12)" strokeWidth={1} strokeDasharray="3 5" />
          <line x1={PAD_LEFT} y1={yAsr(95)} x2={PAD_LEFT + innerW} y2={yAsr(95)} stroke="rgba(96,165,250,0.12)" strokeWidth={1} strokeDasharray="3 5" />

          {[1, 2, 3, 4, 5].map((v) => (
            <text key={`mos-label-${v}`} x={PAD_LEFT - 5} y={yMos(v) + 4} textAnchor="end" fill="#334155" fontSize={8} fontFamily="ui-monospace, monospace">{v}</text>
          ))}
          {[0, 50, 85, 95, 100].map((v) => (
            <text key={`asr-label-${v}`} x={PAD_LEFT + innerW + 5} y={yAsr(v) + 4} textAnchor="start" fill="#334155" fontSize={8} fontFamily="ui-monospace, monospace">{v}%</text>
          ))}
          <text x={8} y={PAD_TOP + innerH / 2} textAnchor="middle" fill="#334155" fontSize={7.5} fontFamily="system-ui, sans-serif" letterSpacing="0.05em" transform={`rotate(-90, 8, ${PAD_TOP + innerH / 2})`}>MOS</text>
          <text x={W - 6} y={PAD_TOP + innerH / 2} textAnchor="middle" fill="#334155" fontSize={7.5} fontFamily="system-ui, sans-serif" letterSpacing="0.05em" transform={`rotate(90, ${W - 6}, ${PAD_TOP + innerH / 2})`}>ASR%</text>

          <path d={mosMemo.areaPath} fill="url(#mos-fill)" />
          <path d={asrMemo.areaPath} fill="url(#asr-fill)" />
          <path d={mosMemo.linePath} fill="none" stroke="#4ade80" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" filter="url(#mos-glow)" />
          <path d={asrMemo.linePath} fill="none" stroke="#60a5fa" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" filter="url(#asr-glow)" />

          {days.map((day, i) => {
            const x = xPos(i);
            const hasData = day.total > 0;
            const isHovered = hoveredIdx === i;
            return (
              <g key={day.date}>
                <text x={x} y={H - 4} textAnchor="middle" fill={isHovered ? '#94a3b8' : '#334155'} fontSize={8.5} fontFamily="system-ui, sans-serif" style={{ transition: 'fill 0.15s' }}>{day.shortLabel}</text>
                <rect x={x - innerW / 14} y={PAD_TOP} width={innerW / 7} height={innerH} fill="transparent" style={{ cursor: hasData ? 'crosshair' : 'default' }} onMouseEnter={() => setHoveredIdx(i)} onMouseLeave={() => setHoveredIdx(null)} />
                {hasData ? (
                  <>
                    {day.avgMos !== null && (
                      <circle cx={x} cy={yMos(day.avgMos)} r={isHovered ? 4.5 : 3} fill={isHovered ? '#4ade80' : '#13151d'} stroke="#4ade80" strokeWidth={isHovered ? 2 : 1.5} style={{ transition: 'r 0.15s, fill 0.15s' }} onMouseEnter={() => setHoveredIdx(i)} onMouseLeave={() => setHoveredIdx(null)} />
                    )}
                    {day.asr !== null && (
                      <circle cx={x} cy={yAsr(day.asr)} r={isHovered ? 4.5 : 3} fill={isHovered ? '#60a5fa' : '#13151d'} stroke="#60a5fa" strokeWidth={isHovered ? 2 : 1.5} style={{ transition: 'r 0.15s, fill 0.15s' }} onMouseEnter={() => setHoveredIdx(i)} onMouseLeave={() => setHoveredIdx(null)} />
                    )}
                    {isHovered && <line x1={x} y1={PAD_TOP} x2={x} y2={PAD_TOP + innerH} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />}
                  </>
                ) : (
                  <circle cx={x} cy={PAD_TOP + innerH / 2} r={2.5} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={1} strokeDasharray="2 2" />
                )}
              </g>
            );
          })}
        </svg>

        {hoveredDay !== null && hoveredIdx !== null && (
          <div
            style={{
              position: 'absolute',
              left: `clamp(0px, calc(${((hoveredIdx / 6) * 100).toFixed(1)}% - 90px), calc(100% - 200px))`,
              top: 4,
              pointerEvents: 'none',
              background: 'rgba(15,17,23,0.95)',
              border: '1px solid rgba(96,165,250,0.22)',
              borderRadius: 8,
              padding: '8px 12px',
              minWidth: 190,
              boxShadow: '0 8px 24px -4px rgba(0,0,0,0.6)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
              zIndex: 10,
            }}
          >
            <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#94a3b8', marginBottom: 6 }}>{hoveredDay.label}</div>
            {hoveredDay.total === 0 ? (
              <div style={{ fontSize: '0.68rem', color: GLASS.textFaint }}>No calls recorded</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                  <span style={{ fontSize: '0.68rem', color: '#64748b' }}>Calls</span>
                  <span style={{ fontSize: '0.68rem', fontWeight: 600, color: GLASS.text, fontVariantNumeric: 'tabular-nums' }}>{hoveredDay.total}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.68rem', color: '#60a5fa' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#60a5fa', display: 'inline-block', flexShrink: 0 }} />ASR
                  </span>
                  <span style={{ fontSize: '0.68rem', fontWeight: 600, color: GLASS.text, fontVariantNumeric: 'tabular-nums' }}>{hoveredDay.asr !== null ? `${hoveredDay.asr.toFixed(1)}%` : '—'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.68rem', color: '#4ade80' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#4ade80', display: 'inline-block', flexShrink: 0 }} />MOS
                  </span>
                  <span style={{ fontSize: '0.68rem', fontWeight: 600, color: GLASS.text, fontVariantNumeric: 'tabular-nums' }}>{hoveredDay.avgMos !== null ? hoveredDay.avgMos.toFixed(2) : '—'}</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 18, marginTop: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width="20" height="6" style={{ flexShrink: 0 }}>
            <line x1="0" y1="3" x2="20" y2="3" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" />
            <circle cx="10" cy="3" r="2.5" fill="#13151d" stroke="#4ade80" strokeWidth="1.5" />
          </svg>
          <span style={{ fontSize: '0.66rem', color: GLASS.textFaint }}>MOS (left axis, 1–5)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width="20" height="6" style={{ flexShrink: 0 }}>
            <line x1="0" y1="3" x2="20" y2="3" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" />
            <circle cx="10" cy="3" r="2.5" fill="#13151d" stroke="#60a5fa" strokeWidth="1.5" />
          </svg>
          <span style={{ fontSize: '0.66rem', color: GLASS.textFaint }}>ASR% (right axis, 0–100%)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width="14" height="14" style={{ flexShrink: 0 }}>
            <circle cx="7" cy="7" r="4" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="1" strokeDasharray="2 2" />
          </svg>
          <span style={{ fontSize: '0.66rem', color: '#334155' }}>No data</span>
        </div>
      </div>
    </GlassPanel>
  );
}
