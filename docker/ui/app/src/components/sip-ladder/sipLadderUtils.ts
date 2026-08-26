import type { HomerSearchResult } from '../../api/homer';
import type { NodeRole } from './sipLadderTypes';

// ─── Color constants — THE ladder theme object ──────────────────────────────

/**
 * Complete color palette for the SIP ladder diagram — the SINGLE source of
 * truth for every color in the ladder stack (SipLadder / SipMessageRow /
 * PacketDetailPanel / the layout engine's synthetic connectors). Re-theming
 * the ladder means editing THIS object only; components must never hard-code
 * a color literal of their own.
 *
 * DAYLIGHT theme: white canvas, hairline grid, ink text — aligned with the
 * app-wide daylight console (`--rcf-*` tokens on `.dl-scope` in index.css;
 * values mirrored here because this file styles inline, outside CSS var
 * scope guarantees).
 *
 * Semantic arrow hues keep the SAME mapping the dark ladder had (INVITE
 * A-leg blue / B-leg orange / 1xx purple / 2xx green / 4xx-5xx red / ACK
 * cyan-teal / BYE gray / retransmissions dimmed / internal loopback dashed
 * slate) but are re-derived one shade darker-saturated so every label and
 * arrow holds ≥ 4.5:1 (WCAG AA, small text) against the white canvas.
 */
export const LADDER_COLORS = {
  // Surface (mirrors --rcf-card / --rcf-tint / --rcf-tint-hover / --rcf-line)
  bg: '#ffffff',
  surface: '#f7f9fc',
  surfaceHover: '#f2f7ff',
  border: '#e2e8f2',
  borderLight: '#edf1f7',

  // Text — the ink ramp (mirrors --rcf-ink / -soft / -dim)
  text: '#0e1726',
  textMuted: '#46566f',
  textFaint: '#5d6f8c',

  // SIP methods (requests)
  invite: '#1d63dd',   // was #3b82f6 — azure-deep, 5.4:1 on white
  bye: '#64748b',      // was #94a3b8 — slate-500, 4.8:1
  ack: '#0e7490',      // was #22d3ee — cyan-700 keeps the teal read, 5.4:1

  // SIP responses
  provisional: '#7c3aed', // was #8b5cf6 — violet-600, 5.7:1
  success: '#15803d',     // was #22c55e — green-700 (--rcf-green), 5.0:1
  redirect: '#b45309',    // was #f59e0b — amber-700, 5.0:1
  clientError: '#b45309', // was #f59e0b — same amber family as before
  serverError: '#b91c1c', // was #ef4444 — red-700 (--rcf-red), 6.5:1

  // Call legs
  aLeg: '#1d63dd', // was #3b82f6
  bLeg: '#b45309', // was #f59e0b

  // Retransmission arrows — deliberately dimmed (duplicate wire noise; the
  // full-contrast original renders adjacent, and the filter can hide these).
  retransmission: 'rgba(70,86,111,0.75)',

  // Internal loopback connector (synthetic VIP ↔ sibling-SBC same-box handoff).
  // A muted dark slate that is clearly readable on the white ladder yet still
  // reads as "inferred/internal" — distinct from every real SIP method/status
  // hue, so the connector never masquerades as a captured packet.
  internalHandoff: '#475569',

  // Node roles (column-header sublabels) — same hue families as the arrows.
  roleCarrier: '#b45309',
  roleVip: '#7c3aed',
  roleSbc: '#1d63dd',
  roleMedia: '#15803d',

  // Interactive accent (azure family — mirrors --rcf-azure / --rcf-azure-deep)
  accent: '#1d63dd',
  accentWash: 'rgba(47,125,246,0.08)',
  accentWashSoft: 'rgba(47,125,246,0.04)',
  accentChip: 'rgba(47,125,246,0.12)',
  accentBorder: 'rgba(47,125,246,0.3)',
  accentBorderStrong: 'rgba(47,125,246,0.5)',

  // Control chrome (buttons/pills — mirrors the dlx5-seg-btn family)
  controlBorder: '#cdd8e8',
  controlBorderHover: '#a3b6d3',
  inkChip: 'rgba(14,23,38,0.05)',

  // Diagram elements
  columnLine: 'rgba(14,23,38,0.1)',
  arrowHead: '#0e1726',
} as const;

// ─── SIP response descriptions ─────────────────────────────────────────────

/**
 * Maps SIP response status codes to human-readable descriptions.
 * Covers all common codes encountered in carrier and B2BUA scenarios.
 */
const RESPONSE_DESCRIPTIONS: Record<number, string> = {
  // 1xx Provisional
  100: 'Trying',
  180: 'Ringing',
  181: 'Call Is Being Forwarded',
  182: 'Queued',
  183: 'Session Progress',
  199: 'Early Dialog Terminated',

  // 2xx Success
  200: 'OK',
  202: 'Accepted',

  // 3xx Redirection
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Moved Temporarily',
  305: 'Use Proxy',
  380: 'Alternative Service',

  // 4xx Client Errors
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  410: 'Gone',
  413: 'Request Entity Too Large',
  415: 'Unsupported Media Type',
  416: 'Unsupported URI Scheme',
  420: 'Bad Extension',
  421: 'Extension Required',
  422: 'Session Interval Too Small',
  423: 'Interval Too Brief',
  480: 'Temporarily Unavailable',
  481: 'Call/Transaction Does Not Exist',
  482: 'Loop Detected',
  483: 'Too Many Hops',
  484: 'Address Incomplete',
  485: 'Ambiguous',
  486: 'Busy Here',
  487: 'Request Terminated',
  488: 'Not Acceptable Here',
  489: 'Bad Event',
  491: 'Request Pending',
  493: 'Undecipherable',

  // 5xx Server Errors
  500: 'Server Internal Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Server Time-out',
  505: 'Version Not Supported',
  513: 'Message Too Large',

  // 6xx Global Failures
  600: 'Busy Everywhere',
  603: 'Decline',
  604: 'Does Not Exist Anywhere',
  606: 'Not Acceptable',
};

// ─── Exported utility functions ─────────────────────────────────────────────

/**
 * Formats a time delta in milliseconds into a human-readable string.
 *
 * Examples:
 *   0.3   → "0.3ms"
 *   1.2   → "1.2ms"
 *   45    → "45ms"
 *   1200  → "1.2s"
 *   28000 → "28s"
 */
export function formatTimeDelta(deltaMs: number): string {
  if (deltaMs < 0) {
    return formatTimeDelta(Math.abs(deltaMs));
  }

  if (deltaMs < 1) {
    // Sub-millisecond: show one decimal
    return `${deltaMs.toFixed(1)}ms`;
  }

  if (deltaMs < 10) {
    // Single-digit ms: show one decimal for precision
    return `${deltaMs.toFixed(1)}ms`;
  }

  if (deltaMs < 1000) {
    // Under one second: show whole milliseconds
    return `${Math.round(deltaMs)}ms`;
  }

  if (deltaMs < 10000) {
    // Under 10 seconds: show one decimal
    return `${(deltaMs / 1000).toFixed(1)}s`;
  }

  // 10+ seconds: show whole seconds
  return `${Math.round(deltaMs / 1000)}s`;
}

/**
 * Builds the display label for a SIP message arrow.
 *
 * - Requests: method name ("INVITE", "BYE", "ACK", "OPTIONS", "CANCEL")
 * - Responses: status code + reason phrase ("200 OK", "183 Session Progress")
 */
export function formatMessageLabel(msg: HomerSearchResult): string {
  if (msg.status === null) {
    // SIP request — label is the method name
    return msg.method;
  }

  // SIP response — status code + description
  const description = getResponseDescription(msg.status);
  return `${msg.status} ${description}`;
}

/**
 * Detects RFC 3261 retransmissions by checking whether an identical message
 * (same Call-ID, method, status, source, destination) was seen within the
 * given time window.
 *
 * @param msg        The message to check
 * @param prevMessages  All chronologically earlier messages to compare against
 * @param windowMs   Retransmission detection window (default 500ms per RFC 3261 T1*64)
 */
export function isRetransmission(
  msg: HomerSearchResult,
  prevMessages: ReadonlyArray<HomerSearchResult>,
  windowMs: number = 500,
): boolean {
  const msgTimeMs = msg.timestamp_ns / 1_000_000;
  const windowStart = msgTimeMs - windowMs;

  // Walk backwards through previous messages (most recent first is most likely to match)
  for (let i = prevMessages.length - 1; i >= 0; i--) {
    const prev = prevMessages[i]!;
    const prevTimeMs = prev.timestamp_ns / 1_000_000;

    // If we've gone past the detection window, no point checking further
    if (prevTimeMs < windowStart) {
      break;
    }

    if (
      prev.callid === msg.callid &&
      prev.method === msg.method &&
      prev.status === msg.status &&
      prev.src_ip === msg.src_ip &&
      prev.dst_ip === msg.dst_ip
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Classifies a node's architectural role from its aliased name.
 *
 * Names are aliased by the heplify-server Lua script and may carry a zone prefix
 * (or any other prefix/suffix) once multi-datacenter expansion lands. Matching is
 * therefore done by SUBSTRING, not by prefix, so zone-qualified aliases like
 * "West-SBC-1", "Central-FreeSWITCH", or "West-SBC-VIP" resolve to the same role
 * as their un-prefixed East counterparts.
 *
 * Precedence is critical — the checks are ordered most-specific first so a name
 * that matches several patterns lands on the right role:
 *
 *   1. VIP      → 'sbc-vip'         e.g. "SBC-VIP", "West-SBC-VIP"
 *                 (MUST precede the SBC check; every VIP name also contains "SBC")
 *   2. BW       → 'carrier-ingress' e.g. "BW-NY", "BW-DAL", "BW-TC2-LA"
 *                 (refined to 'carrier-egress' by the layout engine via call flow)
 *   3. SBC      → 'sbc'             e.g. "SBC-1", "West-SBC-2"
 *   4. media    → 'media-server'    e.g. "FreeSWITCH", "West-FreeSWITCH",
 *                                        "FS", "FS-1", "media-FS"
 *   5. anything else (incl. raw-IP fallbacks for un-aliased nodes, and the
 *      "Services" / "West-Services" host) → 'unknown'
 *
 * Note on the media match: we test for "FREESWITCH" first, then for the standalone
 * "FS" token guarded by word boundaries ("FS" at the start, end, or delimited by
 * a non-alphanumeric on both sides). The guard prevents false positives like
 * "Services" (no standalone "FS") while still catching "FS-1" or "media-FS".
 */
export function classifyNodeRole(name: string): NodeRole {
  const upper = name.toUpperCase();

  // 1. VIP — most specific. "West-SBC-VIP" must resolve here, not at the SBC check.
  if (upper.includes('VIP')) {
    return 'sbc-vip';
  }

  // 2. Carrier (Bandwidth). All carrier aliases are "BW" / "BW-*" / "*-BW-*".
  //    Refined to 'carrier-egress' by the layout engine using call-flow direction.
  if (upper === 'BW' || /(^|[^A-Z0-9])BW($|[^A-Z0-9])/.test(upper)) {
    return 'carrier-ingress';
  }

  // 3. SBC — any name carrying the "SBC" token (zone-prefixed or not).
  if (upper.includes('SBC')) {
    return 'sbc';
  }

  // 4. Media server — FreeSWITCH (full word) or a standalone "FS" token.
  //    The word-boundary guard keeps "Services" / "West-Services" out.
  if (upper.includes('FREESWITCH') || /(^|[^A-Z0-9])FS($|[^A-Z0-9])/.test(upper)) {
    return 'media-server';
  }

  // 5. Everything else — including literal-IP fallbacks for un-aliased nodes.
  return 'unknown';
}

/**
 * Returns a human-readable description for a SIP response status code.
 * Falls back to generic category descriptions for unknown codes.
 */
export function getResponseDescription(status: number): string {
  const known = RESPONSE_DESCRIPTIONS[status];
  if (known !== undefined) {
    return known;
  }

  // Fallback by category
  if (status >= 100 && status < 200) return 'Provisional';
  if (status >= 200 && status < 300) return 'Success';
  if (status >= 300 && status < 400) return 'Redirection';
  if (status >= 400 && status < 500) return 'Client Error';
  if (status >= 500 && status < 600) return 'Server Error';
  if (status >= 600 && status < 700) return 'Global Failure';

  return 'Unknown';
}

/**
 * Returns the display color for a SIP message based on its method, status,
 * and which call leg it belongs to.
 */
export function getMessageColor(
  msg: HomerSearchResult,
  leg: 'a' | 'b' | 'unknown',
): string {
  if (msg.status === null) {
    // SIP request
    if (msg.method === 'INVITE') {
      return leg === 'b' ? LADDER_COLORS.bLeg : LADDER_COLORS.aLeg;
    }
    if (msg.method === 'BYE') return LADDER_COLORS.bye;
    if (msg.method === 'ACK') return LADDER_COLORS.ack;
    if (msg.method === 'CANCEL') return LADDER_COLORS.serverError;
    return LADDER_COLORS.invite; // OPTIONS, REGISTER, NOTIFY, etc.
  }

  // SIP response — color by status category
  if (msg.status >= 200 && msg.status < 300) return LADDER_COLORS.success;
  if (msg.status >= 100 && msg.status < 200) return LADDER_COLORS.provisional;
  if (msg.status >= 300 && msg.status < 400) return LADDER_COLORS.redirect;
  if (msg.status >= 400 && msg.status < 500) return LADDER_COLORS.clientError;
  if (msg.status >= 500) return LADDER_COLORS.serverError;

  return LADDER_COLORS.textMuted;
}
