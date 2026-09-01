/**
 * quality.ts — shared voice-quality color semantics + small formatters for
 * the merged Calls & Quality page (/cdrs + /call-quality).
 *
 * Thresholds are the ones the Call Quality page shipped with (three PRs of
 * tuning) — MOS 4.0/3.5, R-factor 80/60, loss 1%/5%, jitter 20ms/50ms
 * (jitter_avg_ms is the RMS mid-band estimate in real ms — ITU-ish guidance:
 * <20ms comfortable, 20–50ms noticeable, >50ms audible degradation).
 * Status colors are quality semantics only, never decoration.
 */

export const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';

/** Ink-dark status tones tuned for legibility on the white paper canvas. */
export const GOOD = '#15803d';
export const WARN = '#b45309';
export const BAD = '#b91c1c';
export const INK_FAINT = '#8b99b0';
export const AZURE_DEEP = '#1d63dd';

export function mosColor(mos: number | null | undefined): string {
  if (mos == null) return INK_FAINT;
  if (mos >= 4.0) return GOOD;
  if (mos >= 3.5) return WARN;
  return BAD;
}

export interface QualityTone {
  text: string;
  bg: string;
  border: string;
}

/** Translucent pill tone for a MOS value on the white canvas. */
export function mosTone(mos: number | null | undefined): QualityTone {
  if (mos == null) return { text: INK_FAINT, bg: 'rgba(93,111,140,0.08)', border: 'rgba(93,111,140,0.2)' };
  if (mos >= 4.0) return { text: GOOD, bg: 'rgba(22,163,74,0.1)', border: 'rgba(22,163,74,0.26)' };
  if (mos >= 3.5) return { text: WARN, bg: 'rgba(180,83,9,0.09)', border: 'rgba(180,83,9,0.26)' };
  return { text: BAD, bg: 'rgba(220,38,38,0.07)', border: 'rgba(220,38,38,0.26)' };
}

export function rFactorColor(r: number | null | undefined): string {
  if (r == null) return INK_FAINT;
  if (r >= 80) return GOOD;
  if (r >= 60) return WARN;
  return BAD;
}

export function packetLossColor(pct: number | null | undefined): string {
  if (pct == null) return INK_FAINT;
  if (pct <= 1) return GOOD;
  if (pct <= 5) return WARN;
  return BAD;
}

export function jitterColor(ms: number | null | undefined): string {
  if (ms == null) return INK_FAINT;
  if (ms <= 20) return GOOD;
  if (ms <= 50) return WARN;
  return BAD;
}

export function qualityPctColor(pct: number | null | undefined): string {
  if (pct == null) return INK_FAINT;
  if (pct >= 80) return GOOD;
  if (pct >= 60) return WARN;
  return BAD;
}

export function fmtDurationShort(sec: number): string {
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
