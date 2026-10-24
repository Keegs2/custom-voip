/**
 * callDisplay.ts — PURE display derivations for one call group on the
 * Troubleshooting page (no React). Shared by the results table
 * (TroubleshootingPage.tsx) and the call-trace modal (CallTraceModal.tsx) so
 * the row and the modal header can never disagree about a call's zone,
 * carrier endpoints, timestamps or Grafana window.
 */
import type { HomerSearchResult } from '../../api/homer';
import { fmt } from '../../utils/format';
import type { CallGroup } from './callGrouping';
import { T } from '../../styles/theme';

// ─── Palette — theme tokens (docker/ui/CLAUDE.md §18). `var()` strings that
// follow light / dark; on light they resolve to the old daylight ink ramp.

export const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';
export const INK_SOFT = T.textSoft;
export const INK_DIM = T.textDim;
export const INK_FAINT = T.textFaint;
export const AZURE_DEEP = T.accentText;
/** Separators, arrows and the empty "—" (a page token in dl-troubleshoot.css). */
export const INK_GHOST = 'var(--ts-ghost)';

// ─── Phone / time formatting ─────────────────────────────────────────────────

/** Returns true when a string looks like a phone number (mostly digits). */
function looksLikePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

/** Display phone numbers prettily when they look like phones; otherwise return as-is. */
export function displayUser(value: string): string {
  return looksLikePhone(value) ? fmt(value) : value;
}

/** Compact single-line timestamp for the results table: "Sep 4 04:52:02.885"
 *  — 24h clock, millisecond precision (microseconds are ladder-level detail),
 *  no AM/PM. Fractional seconds come from the ISO string directly (stored
 *  precision is µs; Date truncates to ms anyway). */
export function fmtCompactTs(iso: string): string {
  try {
    const d = new Date(iso);
    const date = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
    }).format(d);
    const time = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).format(d);
    const fracMatch = iso.match(/\.(\d+)/);
    const ms = (fracMatch ? fracMatch[1] : '').padEnd(3, '0').slice(0, 3);
    return `${date} ${time}.${ms}`;
  } catch {
    return iso;
  }
}

/** Format seconds into a human-readable duration string. */
export function fmtCallDuration(seconds: number): string {
  if (seconds < 0) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

// ─── Zone derivation (HEP capture node id → zone) ────────────────────────────

/** HEP capture-id → zone (docker/homer/CLAUDE.md capture-id matrix):
 *  SBC = 1xx, FS = 2xx, FS-2 hot standby = 2x1. All of one call's messages
 *  are captured in a single zone, so any mapped id decides it. */
const NODE_ZONES: Record<string, string> = {
  '100': 'East', '200': 'East', '201': 'East',
  '110': 'West', '210': 'West', '211': 'West',
  '120': 'Central', '220': 'Central', '221': 'Central',
};

export interface ZoneInfo {
  label: string;
  /** False when no capture id mapped — `label` is then the raw node id. */
  known: boolean;
}

/** Zone for a call group: first message node id that maps wins (a `node` can
 *  be comma-joined, e.g. "100,200", when several nodes captured the same wire
 *  message). Unmapped ids fall back to showing the raw id; no node → null. */
export function deriveZone(messages: ReadonlyArray<HomerSearchResult>): ZoneInfo | null {
  let raw: string | null = null;
  for (const msg of messages) {
    if (!msg.node) continue;
    if (raw === null) raw = msg.node;
    for (const id of msg.node.split(',')) {
      const zone = NODE_ZONES[id.trim()];
      if (zone) return { label: zone, known: true };
    }
  }
  return raw === null ? null : { label: raw, known: false };
}

// ─── ORIG / TERM carrier derivation (from HEP endpoint aliases) ──────────────
//
// heplify-server aliases wire IPs to node names before storage (see
// docker/homer/scripts/ip-alias.lua): platform nodes carry SBC/VIP/
// FreeSWITCH/Services tokens; carriers are "BW-*" / "Sinch-*"; a customer
// PBX (trunk source) stays a raw IP. The same src/dst data that fed the old
// NETWORK PATH cell derives the two carrier columns:
//   ORIG = source alias of the EARLIEST externally-sourced INVITE request
//   TERM = destination alias of the OUTERMOST (last) externally-destined
//          INVITE request — under carrier failover the final attempt is the
//          one that actually terminated the call.

/** True for our own nodes (SBC / VIP / FreeSWITCH / FS / Services — zone-
 *  prefixed or not). Mirrors sipLadderUtils.classifyNodeRole token rules. */
function isPlatformNode(alias: string): boolean {
  const upper = alias.toUpperCase();
  if (
    upper.includes('SBC') ||
    upper.includes('VIP') ||
    upper.includes('FREESWITCH') ||
    upper.includes('SERVICES')
  ) {
    return true;
  }
  return /(^|[^A-Z0-9])FS($|[^A-Z0-9])/.test(upper);
}

/** Known PoP-code expansions for the compact carrier fold. Codes not listed
 *  render as-is (aliases are already human-cased: "Denver", "Chicago"). */
const POP_NAMES: Record<string, string> = {
  DAL: 'Dallas',
  ATL: 'Atlanta',
  CHI: 'Chicago',
  DEN: 'Denver',
};

/**
 * Compact carrier label for an external endpoint alias — same folding
 * vocabulary as pages/calls/callsFormat.ts ("BW·Dallas", "Sinch·Denver"),
 * adapted to HEP aliases ("BW-DAL", "Sinch-Atlanta-LD", "BW-TC2-DAL").
 * Non-carrier external endpoints (customer PBX IPs) render verbatim.
 */
export function carrierEndpointLabel(alias: string): string {
  const dash = alias.indexOf('-');
  const head = dash === -1 ? alias : alias.slice(0, dash);
  const headLower = head.toLowerCase();
  if (headLower !== 'bw' && headLower !== 'bandwidth' && headLower !== 'sinch') {
    return alias; // customer PBX / raw IP — show the raw value
  }
  const carrier = headLower === 'sinch' ? 'Sinch' : 'BW';
  if (dash === -1) return carrier;
  const pop = alias
    .slice(dash + 1)
    .split('-')
    .filter(Boolean)
    .map((tok) => POP_NAMES[tok.toUpperCase()] ?? tok)
    .join(' ');
  return pop ? `${carrier}·${pop}` : carrier;
}

export interface CarrierEndpoints {
  /** External alias sourcing the earliest inbound INVITE, or null. */
  orig: string | null;
  /** External alias receiving the outermost B-leg INVITE, or null
   *  (inbound-only / failed call — no terminating leg ever left us). */
  term: string | null;
}

/** Scans a call group's messages (already time-sorted ascending) for the
 *  external endpoints of its ingress and egress INVITEs. */
export function deriveCarrierEndpoints(
  messages: ReadonlyArray<HomerSearchResult>,
): CarrierEndpoints {
  let orig: string | null = null;
  let term: string | null = null;
  for (const msg of messages) {
    if (msg.status !== null || msg.method.toUpperCase() !== 'INVITE') continue;
    if (orig === null && msg.src_ip && !isPlatformNode(msg.src_ip)) {
      orig = msg.src_ip;
    }
    if (msg.dst_ip && !isPlatformNode(msg.dst_ip)) {
      term = msg.dst_ip; // last external-destined INVITE wins (failover)
    }
  }
  return { orig, term };
}

// ─── Grafana deep link ───────────────────────────────────────────────────────

/**
 * Grafana SIP-search deep link scoped to exactly this call's SIP messages:
 * ALL correlated Call-IDs (A-leg + every B-leg attempt) as a regex OR
 * pattern, over the call's own time span (5 s before the first message, 60 s
 * after the last — a B leg may outlive the A leg). Falls back to the
 * COMMITTED search window when no message carries a usable timestamp.
 */
export function buildGrafanaLink(
  group: CallGroup,
  windowStartIso: string,
  windowEndIso: string,
): string {
  const callTimestamps = group.messages
    .map((r) => r.timestamp_ns)
    .filter((ts): ts is number => typeof ts === 'number' && ts > 0);

  let fromMs: number;
  let toMs: number;
  if (callTimestamps.length > 0) {
    fromMs = Math.floor(Math.min(...callTimestamps) / 1_000_000) - 5_000;
    toMs = Math.floor(Math.max(...callTimestamps) / 1_000_000) + 60_000;
  } else {
    fromMs = Math.floor(new Date(windowStartIso).getTime());
    toMs = Math.floor(new Date(windowEndIso).getTime());
  }

  const params = new URLSearchParams({
    'var-callid': group.callIds.join('|'),
    from: String(fromMs),
    to: String(toMs),
    kiosk: 'tv',
  });
  return `/grafana/d/sip-search/sip-search?${params.toString()}`;
}
