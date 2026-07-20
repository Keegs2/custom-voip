/**
 * Pure, presentation-free helpers for the RCF page. No React, no JSX — these are
 * data transforms (sorting, filtering, quality math, E.164 parsing, time/labels)
 * shared across the page's components and hooks.
 */

import type { RcfEntry } from '../../types/rcf';
import type { Cdr } from '../../types/cdr';
import type { DidInventoryItem } from '../../types/didInventory';
import { fmt } from '../../utils/format';
import type { SortField, SortDir, DidFilterState, DailyStats } from './types';

// ── Sorting ──────────────────────────────────────────────────────────────────

export function sortEntries(entries: RcfEntry[], field: SortField, dir: SortDir): RcfEntry[] {
  return [...entries].sort((a, b) => {
    let aVal = '';
    let bVal = '';
    switch (field) {
      case 'did':        aVal = a.did;                 bVal = b.did;                 break;
      case 'name':       aVal = a.name ?? '';          bVal = b.name ?? '';          break;
      case 'forward_to': aVal = a.forward_to;          bVal = b.forward_to;          break;
      case 'customer':   aVal = a.customer_name ?? ''; bVal = b.customer_name ?? ''; break;
      case 'status':     aVal = String(a.enabled);     bVal = String(b.enabled);     break;
    }
    const cmp = aVal.localeCompare(bVal, undefined, { numeric: true });
    return dir === 'asc' ? cmp : -cmp;
  });
}

// ── Time / labels ────────────────────────────────────────────────────────────

export function timeAgo(isoString: string): string {
  const diffSec = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

export function fmtAssignedDate(iso: string | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Quality colour helpers ───────────────────────────────────────────────────

export function mosLabel(mos: number | null | undefined): { text: string; color: string; dot: string } {
  if (mos == null) return { text: '—', color: '#4a5568', dot: '#4a5568' };
  if (mos >= 4.0) return { text: 'Great', color: '#22c55e', dot: '#22c55e' };
  if (mos >= 3.0) return { text: 'OK', color: '#f59e0b', dot: '#f59e0b' };
  return { text: 'Poor', color: '#ef4444', dot: '#ef4444' };
}

export function carrierDisplayName(carrier: string | null | undefined): string {
  if (!carrier) return '—';
  switch (carrier) {
    case 'carrier_primary': return 'Bandwidth Dallas';
    case 'carrier_secondary': return 'Bandwidth LA';
    default: return carrier.replace(/^carrier_/, '').replace(/_/g, ' ');
  }
}

export function callStatusInfo(cdr: Cdr): { label: string; bg: string; color: string; border: string } {
  const GREEN = { bg: 'rgba(34,197,94,0.12)', color: '#4ade80', border: '1px solid rgba(34,197,94,0.2)' };
  const AMBER = { bg: 'rgba(245,158,11,0.12)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.2)' };
  const RED = { bg: 'rgba(239,68,68,0.12)', color: '#f87171', border: '1px solid rgba(239,68,68,0.2)' };
  const BLUE = { bg: 'rgba(59,130,246,0.12)', color: '#60a5fa', border: '1px solid rgba(59,130,246,0.2)' };

  const cause = (cdr.hangup_cause ?? '').toUpperCase();

  if (cdr.answer_time != null && cdr.duration_seconds > 0) return { label: 'Answered', ...GREEN };

  switch (cause) {
    case 'ORIGINATOR_CANCEL': return { label: 'Caller Hung Up', ...AMBER };
    case 'NO_ANSWER': return { label: 'No Answer', ...AMBER };
    case 'USER_BUSY': return { label: 'Busy', ...RED };
    case 'CALL_REJECTED': return { label: 'Rejected', ...RED };
    case 'NORMAL_TEMPORARY_FAILURE': return { label: 'Unavailable', ...RED };
    case 'UNALLOCATED_NUMBER': return { label: 'Invalid Number', ...RED };
    case 'NO_ROUTE_DESTINATION': return { label: 'No Route', ...RED };
    case 'RECOVERY_ON_TIMER_EXPIRE': return { label: 'Timed Out', ...RED };
    case 'NORMAL_CLEARING':
      if (cdr.answer_time == null) return { label: 'Not Connected', ...AMBER };
      return { label: 'Answered', ...GREEN };
    default: break;
  }

  if (cdr.sip_code != null && cdr.sip_code >= 400) {
    if (cdr.sip_code === 486) return { label: 'Busy', ...RED };
    if (cdr.sip_code === 487) return { label: 'Cancelled', ...AMBER };
    if (cdr.sip_code === 603) return { label: 'Declined', ...RED };
    return { label: 'Failed', ...RED };
  }

  if (cdr.answer_time == null) return { label: 'No Answer', ...AMBER };
  return { label: 'Answered', ...BLUE };
}

// ── Call activity aggregation ────────────────────────────────────────────────

export function computeQualityStats(cdrs: Cdr[]) {
  let answered = 0;
  let mosSum = 0;
  let mosCount = 0;
  let durationSum = 0;

  for (const cdr of cdrs) {
    if (cdr.answer_time != null && cdr.duration_seconds > 0) {
      answered++;
      durationSum += cdr.duration_seconds;
    }
    if (cdr.mos != null) {
      mosSum += cdr.mos;
      mosCount++;
    }
  }

  const total = cdrs.length;
  const asr = total > 0 ? (answered / total) * 100 : null;
  const avgMos = mosCount > 0 ? mosSum / mosCount : null;
  const acd = answered > 0 ? durationSum / answered : null;

  return { total, answered, asr, avgMos, acd };
}

/** Build daily quality summary for the last 7 days. */
export function buildDailyDots(cdrs: Cdr[]): DailyStats[] {
  const byDate = new Map<string, { mosSum: number; mosCount: number; total: number; answered: number }>();

  for (const cdr of cdrs) {
    const key = cdr.start_time.slice(0, 10);
    const bucket = byDate.get(key) ?? { mosSum: 0, mosCount: 0, total: 0, answered: 0 };
    bucket.total++;
    if (cdr.answer_time != null && cdr.duration_seconds > 0) bucket.answered++;
    if (cdr.mos != null) { bucket.mosSum += cdr.mos; bucket.mosCount++; }
    byDate.set(key, bucket);
  }

  const result: DailyStats[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const shortLabel = d.toLocaleDateString(undefined, { weekday: 'short' });
    const b = byDate.get(key);

    if (!b || b.total === 0) {
      result.push({ date: key, label, shortLabel, total: 0, answered: 0, asr: null, avgMos: null });
      continue;
    }

    const asr = (b.answered / b.total) * 100;
    const avgMos = b.mosCount > 0 ? b.mosSum / b.mosCount : null;
    result.push({ date: key, label, shortLabel, total: b.total, answered: b.answered, asr, avgMos });
  }
  return result;
}

// ── E.164 / DID inventory helpers ────────────────────────────────────────────

/** Extract NPA (area code) from E.164 +1NPANXXXXXX */
export function extractNpa(did: string): string {
  return did.replace(/^\+1/, '').substring(0, 3);
}

/** Extract NXX (exchange) from E.164 +1NPANXXXXXX */
export function extractNxx(did: string): string {
  return did.replace(/^\+1/, '').substring(3, 6);
}

/** Apply DID filters (AND logic) to an array of inventory items. */
export function applyDidFilters(items: DidInventoryItem[], filters: DidFilterState): DidInventoryItem[] {
  return items.filter((item) => {
    if (filters.npa && extractNpa(item.did) !== filters.npa) return false;
    if (filters.nxx && extractNxx(item.did) !== filters.nxx) return false;
    if (filters.state && item.state !== filters.state) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      const matches =
        item.did.includes(q) ||
        (item.city ?? '').toLowerCase().includes(q) ||
        (item.rate_center ?? '').toLowerCase().includes(q) ||
        fmt(item.did).toLowerCase().includes(q);
      if (!matches) return false;
    }
    return true;
  });
}

/** Extract unique sorted states from an array of inventory items. */
export function extractStates(items: DidInventoryItem[]): string[] {
  const set = new Set<string>();
  for (const item of items) {
    if (item.state) set.add(item.state);
  }
  return [...set].sort();
}
