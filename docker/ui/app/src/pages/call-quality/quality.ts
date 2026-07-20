/**
 * Pure quality-domain helpers for the Call Quality feature: threshold colour
 * mappers, value formatters, and the CDR → stats/daily-bucket reducers.
 *
 * These are framework-free (no React, no JSX) so they live in a plain `.ts`
 * module that both the page hooks and the presentational components can import.
 *
 * The quality colours are SEMANTIC (they encode good/fair/poor thresholds), so
 * they intentionally stay green/amber/red rather than the page's blue accent.
 */

import { GLASS } from '../../components/glass/glass';
import type { Cdr } from '../../types/cdr';
import type { DailyQuality, FilterState, OverviewStats } from './types';

const NEUTRAL = '#4a5568';

export function mosColor(mos: number | null | undefined): string {
  if (mos == null) return NEUTRAL;
  if (mos >= 4.0) return GLASS.success;
  if (mos >= 3.5) return GLASS.warning;
  return GLASS.danger;
}

export function mosBg(mos: number | null | undefined): string {
  if (mos == null) return 'rgba(74,85,104,0.15)';
  if (mos >= 4.0) return 'rgba(34,197,94,0.12)';
  if (mos >= 3.5) return 'rgba(245,158,11,0.12)';
  return 'rgba(239,68,68,0.12)';
}

export function rFactorColor(r: number | null | undefined): string {
  if (r == null) return NEUTRAL;
  if (r >= 80) return GLASS.success;
  if (r >= 60) return GLASS.warning;
  return GLASS.danger;
}

export function packetLossColor(pct: number | null | undefined): string {
  if (pct == null) return NEUTRAL;
  if (pct <= 1) return GLASS.success;
  if (pct <= 5) return GLASS.warning;
  return GLASS.danger;
}

export function jitterColor(ms: number | null | undefined): string {
  if (ms == null) return NEUTRAL;
  if (ms <= 20) return GLASS.success;
  if (ms <= 50) return GLASS.warning;
  return GLASS.danger;
}

export function asrColor(asr: number): string {
  if (asr >= 70) return GLASS.success;
  if (asr >= 50) return GLASS.warning;
  return GLASS.danger;
}

export function qualityPctColor(pct: number): string {
  if (pct >= 80) return GLASS.success;
  if (pct >= 60) return GLASS.warning;
  return GLASS.danger;
}

export function mosLabel(mos: number): string {
  return mos >= 4.0 ? 'Excellent' : mos >= 3.5 ? 'Good' : 'Poor';
}

export function rFactorLabel(r: number): string {
  return r >= 80 ? 'Good' : r >= 60 ? 'Fair' : 'Poor';
}

// ── Formatters ───────────────────────────────────────────────────────────────

export function fmtDuration(sec: number): string {
  if (sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ── Reducers ─────────────────────────────────────────────────────────────────

export function computeOverviewStats(cdrs: Cdr[]): OverviewStats {
  let answered = 0;
  let mosSum = 0; let mosCount = 0;
  let plSum = 0; let plCount = 0;
  let jSum = 0; let jCount = 0;
  let rSum = 0; let rCount = 0;

  for (const cdr of cdrs) {
    if (cdr.answer_time != null) answered++;
    if (cdr.mos != null) { mosSum += cdr.mos; mosCount++; }
    if (cdr.packet_loss_pct != null) { plSum += cdr.packet_loss_pct; plCount++; }
    if (cdr.jitter_avg_ms != null) { jSum += cdr.jitter_avg_ms; jCount++; }
    if (cdr.r_factor != null) { rSum += cdr.r_factor; rCount++; }
  }

  return {
    totalCalls: cdrs.length,
    answeredCalls: answered,
    asr: cdrs.length > 0 ? Math.round((answered / cdrs.length) * 100) : 0,
    avgMos: mosCount > 0 ? mosSum / mosCount : null,
    avgPacketLossPct: plCount > 0 ? plSum / plCount : null,
    avgJitterMs: jCount > 0 ? jSum / jCount : null,
    avgRFactor: rCount > 0 ? rSum / rCount : null,
  };
}

export function buildDailyQuality(cdrs: Cdr[], startDate: Date, endDate: Date): DailyQuality[] {
  const byDate = new Map<string, { mosSum: number; mosCount: number; plSum: number; plCount: number; jSum: number; jCount: number }>();

  for (const cdr of cdrs) {
    const key = cdr.start_time.slice(0, 10);
    const bucket = byDate.get(key) ?? { mosSum: 0, mosCount: 0, plSum: 0, plCount: 0, jSum: 0, jCount: 0 };
    if (cdr.mos != null) { bucket.mosSum += cdr.mos; bucket.mosCount++; }
    if (cdr.packet_loss_pct != null) { bucket.plSum += cdr.packet_loss_pct; bucket.plCount++; }
    if (cdr.jitter_avg_ms != null) { bucket.jSum += cdr.jitter_avg_ms; bucket.jCount++; }
    byDate.set(key, bucket);
  }

  const slots: DailyQuality[] = [];
  const msPerDay = 86400000;
  const dayCount = Math.round((endDate.getTime() - startDate.getTime()) / msPerDay);

  for (let i = 0; i <= Math.min(dayCount, 60); i++) {
    const d = new Date(startDate.getTime() + i * msPerDay);
    const key = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const b = byDate.get(key);
    slots.push({
      date: key,
      label,
      avgMos: b && b.mosCount > 0 ? b.mosSum / b.mosCount : null,
      avgPacketLossPct: b && b.plCount > 0 ? b.plSum / b.plCount : null,
      avgJitterMs: b && b.jCount > 0 ? b.jSum / b.jCount : null,
    });
  }
  return slots;
}

export function getDefaultFilters(): FilterState {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 30);
  return {
    customerId: null,
    trunkId: null,
    numberSearch: '',
    direction: 'all',
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
    productType: 'all',
  };
}
