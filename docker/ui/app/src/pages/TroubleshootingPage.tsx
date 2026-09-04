/**
 * TroubleshootingPage — platform SIP trace search backed by POST /homer/search.
 *
 * The primary control is a smart omnibox: support pastes a phone number in ANY
 * form (`+1 (617) 454-4217`, `617.454.4217`, `16174544217`, a ≥3-digit
 * partial…) or a SIP Call-ID, and the client only DETECTS which one it is —
 * number-looking input is sent VERBATIM as `number` (the server owns all
 * normalization and matches caller/callee/payload-wide), Call-ID-looking input
 * goes out as `call_id`. A live hint under the box always states exactly what
 * will be searched. Advanced From/To/Call-ID fields live in a collapsible row;
 * the time range uses relative presets that resolve to concrete instants at
 * Search time (same idiom as the CDR page's filter bar).
 *
 * Daylight console treatment (see the DAYLIGHT CONSOLE block in index.css and
 * the page-scoped `dlx5-*` primitives in styles/dl-troubleshoot.css).
 *
 * This page renders full-screen OUTSIDE AppLayout and mounts its own
 * <Sidebar /> — the `.dlx5-canvas` modifier re-grounds the shared `.dl-scope`
 * paper for that layout (no AppLayout padding to cancel; 240px sidebar
 * offset). The sidebar collapse feature is shared with AppLayout via
 * SidebarCollapse.tsx — the `.dlx5-canvas--collapsed` modifier drops the
 * offset to 0 when the sidebar slides off.
 *
 * The <SipLadder> visualization (components/sip-ladder/*) is daylight-themed
 * end-to-end off its own LADDER_COLORS theme object — expanded rows seat it
 * inside a light inset frame (`.dlx5-ladderframe`) with a slim header strip
 * labeling the call and the per-call Grafana deep link.
 *
 * Containment: results render inside `.dlx5-tablewrap` (the CDR page's
 * visible-scrollbar pan idiom, plus `container-type: inline-size`), and the
 * expanded-row content sits in `.dlx5-expand-inner` — sticky at the left
 * fold, exactly `100cqw` (one visible card) wide — so the ladder frame and
 * its "Open in Grafana" control can never be pushed past the card edge, no
 * matter how wide the results table is or how far it is panned.
 */
import React, { useState, useCallback, useMemo, type KeyboardEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Sidebar } from '../components/layout/Sidebar';
import { SidebarCollapseTab } from '../components/layout/SidebarCollapse';
import { useSidebarCollapse } from '../components/layout/useSidebarCollapse';
import { Spinner } from '../components/ui/Spinner';
import { searchSipTraces } from '../api/homer';
import type { HomerSearchParams, HomerSearchResult } from '../api/homer';
import { fmt } from '../utils/format';
import { toDatetimeLocal } from './calls/callsFilters';
import { SipLadder } from '../components/sip-ladder';
import { PcapExportControl } from '../components/pcap/PcapExportControl';
import type { MessageAttestation } from '../types/stir';
import {
  attestLabel,
  attestDescription,
  verstatVerdict,
} from '../components/stir/attestationColors';
import '../styles/dl-troubleshoot.css';

// ─── Daylight palette constants (mirror the .dl-scope CSS vars) ──────────────

const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';

const INK_SOFT = '#46566f';
const INK_DIM = '#5d6f8c';
const INK_FAINT = '#8b99b0';
const AZURE_DEEP = '#1d63dd';

// ─── Time-range presets ──────────────────────────────────────────────────────
// Same idiom as the Calls & Quality filter bar (pages/calls/callsFilters.ts): presets
// are RELATIVE and resolve to concrete instants when Search is clicked, so
// "Last 24h" always means 24h before the search, not before page load. While a
// preset is active the datetime pickers show a live preview and are disabled.

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const TRACE_PRESETS = [
  { id: '15m', label: 'Last 15m', ms: 15 * MINUTE_MS },
  { id: '1h', label: 'Last hour', ms: HOUR_MS },
  { id: '24h', label: 'Last 24h', ms: DAY_MS },
  { id: '7d', label: 'Last 7d', ms: 7 * DAY_MS },
] as const;

type TracePresetId = (typeof TRACE_PRESETS)[number]['id'] | 'custom';

/** Concrete window for a relative preset, anchored at `now`. */
function presetWindow(preset: Exclude<TracePresetId, 'custom'>, now: Date): { start: Date; end: Date } {
  const ms = TRACE_PRESETS.find((p) => p.id === preset)?.ms ?? DAY_MS;
  return { start: new Date(now.getTime() - ms), end: now };
}

// ─── Omnibox input classification ────────────────────────────────────────────

/** What a free-form search input will be sent as. */
type NeedleKind =
  | 'empty'      // nothing typed
  | 'number'     // digit needle with ≥3 digits → `number` param, sent VERBATIM
  | 'callid'     // Call-ID-looking (or non-numeric text) → sent verbatim
  | 'too-short'; // number-looking but <3 digits → Search disabled, no request

interface NeedleClassification {
  kind: NeedleKind;
  /** For number/too-short kinds: the digits the SERVER will match (display mirror). */
  digits: string;
}

/**
 * DISPLAY-ONLY mirror of the server's number normalization: strip to digits,
 * then drop the leading 1 from an 11-digit NANP number.
 *
 * THE SERVER OWNS THE TRUTH — requests always carry the user's input VERBATIM
 * (`number: "<raw>"`). This mirror exists solely so the live hint can show
 * what the server will actually search for.
 */
function mirrorServerNumberNormalization(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

/**
 * Classify a free-form search input as a number needle or a Call-ID.
 *
 * Heuristic (pinned to the /homer/search contract):
 * - contains `@` → Call-ID (numbers never carry @; most Call-IDs do)
 * - after removing ONE leading `+` and common number punctuation
 *   (spaces, parens, dots, dashes), any non-digit remains (letters, symbols)
 *   → Call-ID
 * - otherwise it's a number needle; <3 digits is "too short" (the server
 *   would 422 — we disable Search with an inline hint instead of sending).
 */
function classifyNeedle(raw: string): NeedleClassification {
  const value = raw.trim();
  if (!value) return { kind: 'empty', digits: '' };
  if (value.includes('@')) return { kind: 'callid', digits: '' };
  const unformatted = value.replace(/^\+/, '').replace(/[\s().-]/g, '');
  if (/\D/.test(unformatted)) return { kind: 'callid', digits: '' };
  const digits = mirrorServerNumberNormalization(value);
  if (digits.length < 3) return { kind: 'too-short', digits };
  return { kind: 'number', digits };
}

/** Readable digit grouping for hint display — the SAME digits the server will
 *  match, just punctuated: 10 → (617) 454-4217 · 7 → 454-4217 · else as-is. */
function groupDigits(digits: string): string {
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return digits;
}

// ─── Derived search state (pure — one place turns form state into truth) ─────

/** One criterion of the pending search, phrased for the live hint /
 *  results-header summary. `label` + `needle` render as
 *  "…{label} {needle}…", e.g. "for numbers containing" + "(617) 454-4217". */
interface CriterionSegment {
  label: string;
  needle: string;
}

interface SearchFormState {
  omni: string;
  fromUser: string;
  toUser: string;
  advCallId: string;
  rangePreset: TracePresetId;
  startLocal: string;
  endLocal: string;
}

interface DerivedSearch {
  omniKind: NeedleKind;
  /** Advanced Call-ID actually in effect ('' while the omnibox IS the Call-ID). */
  effectiveAdvCallId: string;
  /** Everything the search will match, in hint order. Empty = nothing to search. */
  segments: CriterionSegment[];
  /** Number-needle problem blocking the search (too-short input), or null. */
  needleError: string | null;
  /** Custom-range problem blocking the search, or null. */
  rangeError: string | null;
  /** True when a 3-5 digit needle meets a >24h window — worth a slowness hint. */
  broadSearch: boolean;
}

function deriveSearch(form: SearchFormState): DerivedSearch {
  const omniC = classifyNeedle(form.omni);
  const fromC = classifyNeedle(form.fromUser);
  const toC = classifyNeedle(form.toUser);

  // While the omnibox holds a Call-ID the advanced Call-ID field mirrors it
  // (disabled in the UI), so it contributes nothing of its own.
  const effectiveAdvCallId = omniC.kind === 'callid' ? '' : form.advCallId.trim();

  const segments: CriterionSegment[] = [];
  if (omniC.kind === 'number') {
    segments.push({ label: 'for numbers containing', needle: groupDigits(omniC.digits) });
  } else if (omniC.kind === 'callid') {
    segments.push({ label: 'Call-ID (exact match)', needle: `“${form.omni.trim()}”` });
  }
  if (fromC.kind === 'number') {
    segments.push({ label: 'From containing', needle: groupDigits(fromC.digits) });
  } else if (fromC.kind === 'callid') {
    segments.push({ label: 'From containing', needle: `“${form.fromUser.trim()}”` });
  }
  if (toC.kind === 'number') {
    segments.push({ label: 'To containing', needle: groupDigits(toC.digits) });
  } else if (toC.kind === 'callid') {
    segments.push({ label: 'To containing', needle: `“${form.toUser.trim()}”` });
  }
  if (effectiveAdvCallId) {
    segments.push({ label: 'Call-ID containing', needle: `“${effectiveAdvCallId}”` });
  }

  // Too-short number needles block the search (the server would 422) — say so
  // inline instead of ever sending a doomed request.
  let needleError: string | null = null;
  if (omniC.kind === 'too-short') {
    needleError = 'Keep typing — a number search needs at least 3 digits.';
  } else if (fromC.kind === 'too-short') {
    needleError = 'From needs at least 3 digits to search as a number.';
  } else if (toC.kind === 'too-short') {
    needleError = 'To needs at least 3 digits to search as a number.';
  }

  // Custom-range validation (presets can't be invalid).
  let rangeError: string | null = null;
  let windowMs: number | null = null;
  if (form.rangePreset === 'custom') {
    if (!form.startLocal || !form.endLocal) {
      rangeError = 'Custom range requires both a start and an end date/time.';
    } else {
      const start = new Date(form.startLocal);
      const end = new Date(form.endLocal);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        rangeError = 'Enter a valid start and end date/time.';
      } else if (start.getTime() >= end.getTime()) {
        rangeError = 'Start must be before end.';
      } else {
        windowMs = end.getTime() - start.getTime();
      }
    }
  } else {
    windowMs = TRACE_PRESETS.find((p) => p.id === form.rangePreset)?.ms ?? null;
  }

  // Broad-search guidance: a short (3-5 digit) needle over a large (>24h)
  // window scans a lot of traffic. Non-blocking — a Call-ID criterion narrows
  // the search enough to skip the warning.
  const hasCallId = omniC.kind === 'callid' || effectiveAdvCallId !== '';
  const hasShortNumberNeedle = [omniC, fromC, toC].some(
    (c) => c.kind === 'number' && c.digits.length <= 5,
  );
  const broadSearch =
    !hasCallId && hasShortNumberNeedle && windowMs !== null && windowMs > DAY_MS;

  return {
    omniKind: omniC.kind,
    effectiveAdvCallId,
    segments,
    needleError,
    rangeError,
    broadSearch,
  };
}

/** Compact local-time stamp for the committed-search summary line. */
function fmtWindowStamp(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

// ─── Display helpers ─────────────────────────────────────────────────────────

/** Returns true when a string looks like a phone number (mostly digits). */
function looksLikePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

/** Display phone numbers prettily when they look like phones; otherwise return as-is. */
function displayUser(value: string): string {
  return looksLikePhone(value) ? fmt(value) : value;
}

/** Format an ISO date string into date + time parts (microsecond precision) for
 *  the two-line time cell. JavaScript Date only has millisecond precision, so we
 *  extract the fractional seconds directly from the ISO string
 *  (e.g. "2026-05-20T06:44:42.123456Z"). */
function fmtDateParts(iso: string): { date: string; time: string } {
  try {
    const d = new Date(iso);
    const date = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
    }).format(d);
    const time = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).format(d);
    // Extract fractional seconds from the ISO string directly (up to 6 digits)
    // since Date.getMilliseconds() truncates to 3 digits
    const fracMatch = iso.match(/\.(\d+)Z?$/);
    const frac = fracMatch ? fracMatch[1].padEnd(6, '0').slice(0, 6) : '000000';
    return { date, time: time.replace(/(\d{2})\s*(AM|PM)/i, `$1.${frac} $2`) };
  } catch {
    return { date: iso, time: '' };
  }
}

// ─── Call grouping ───────────────────────────────────────────────────────────

/** A single call represented by one row in the search results. */
interface CallGroup {
  /** The representative message (initial inbound INVITE, or earliest message) */
  representative: HomerSearchResult;
  /** All Call-IDs in this correlation group */
  callIds: string[];
  /** Every SIP message belonging to this call */
  messages: HomerSearchResult[];
  /** Final SIP response status (highest non-1xx response, or null) */
  finalStatus: number | null;
  /** Duration in seconds from first INVITE to last BYE, or null if unavailable */
  durationSec: number | null;
  /**
   * STIR/SHAKEN attestation for this call. Per-call, so it's identical across
   * the call's messages — we take the first message that carries a non-null
   * `attestation`. `null` when the call has no stored attestation.
   */
  attestation: MessageAttestation | null;
}

/**
 * Groups SIP messages into calls using the correlations map.
 *
 * The correlations map has Call-ID -> list of related Call-IDs. We build
 * connected components (union-find style) so that A-leg and B-leg messages
 * are merged into a single call group. Then we pick the best representative
 * message for each group: the earliest INVITE request (status === null),
 * falling back to the earliest message overall.
 */
function groupMessagesByCall(
  results: HomerSearchResult[],
  correlations: Record<string, string[]>,
): CallGroup[] {
  // Build union-find: map each Call-ID to its canonical group key
  const parent = new Map<string, string>();

  function find(id: string): string {
    let root = id;
    while (parent.has(root) && parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    // Path compression
    let current = id;
    while (current !== root) {
      const next = parent.get(current) ?? current;
      parent.set(current, root);
      current = next;
    }
    return root;
  }

  function union(a: string, b: string): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent.set(rootB, rootA);
    }
  }

  // Initialize each Call-ID as its own parent
  for (const row of results) {
    if (!parent.has(row.callid)) {
      parent.set(row.callid, row.callid);
    }
  }

  // Union correlated Call-IDs
  for (const [cid, related] of Object.entries(correlations)) {
    if (!parent.has(cid)) {
      parent.set(cid, cid);
    }
    for (const relatedCid of related) {
      if (!parent.has(relatedCid)) {
        parent.set(relatedCid, relatedCid);
      }
      union(cid, relatedCid);
    }
  }

  // Group messages by their root Call-ID
  const groups = new Map<string, HomerSearchResult[]>();
  for (const row of results) {
    const root = find(row.callid);
    const existing = groups.get(root);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(root, [row]);
    }
  }

  // Build CallGroup objects
  const callGroups: CallGroup[] = [];
  for (const [, messages] of groups) {
    // Sort messages by timestamp (earliest first)
    messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // Collect all unique Call-IDs in this group
    const callIdSet = new Set<string>();
    for (const msg of messages) {
      callIdSet.add(msg.callid);
    }
    const callIds = Array.from(callIdSet);

    // Find the representative: earliest INVITE request (status === null)
    let representative = messages.find(
      (m) => m.method.toUpperCase() === 'INVITE' && m.status === null,
    );
    // Fallback: just the earliest message
    if (!representative) {
      representative = messages[0];
    }

    // Determine the final call status: highest non-1xx response code in the group.
    // This shows whether the call was answered (200), rejected (4xx/5xx), etc.
    let finalStatus: number | null = null;
    for (const msg of messages) {
      if (msg.status !== null && msg.status >= 200) {
        if (finalStatus === null || msg.status > finalStatus) {
          finalStatus = msg.status;
        }
      }
    }
    // If we only have 1xx provisional responses, show the highest one
    if (finalStatus === null) {
      for (const msg of messages) {
        if (msg.status !== null && msg.status >= 100 && msg.status < 200) {
          if (finalStatus === null || msg.status > finalStatus) {
            finalStatus = msg.status;
          }
        }
      }
    }

    // Calculate duration: from first INVITE to the last BYE (or last message)
    let durationSec: number | null = null;
    const firstInvite = messages.find(
      (m) => m.method.toUpperCase() === 'INVITE' && m.status === null,
    );
    const lastBye = [...messages]
      .reverse()
      .find((m) => m.method.toUpperCase() === 'BYE');
    if (firstInvite && lastBye) {
      const startNs = firstInvite.timestamp_ns;
      const endNs = lastBye.timestamp_ns;
      if (
        typeof startNs === 'number' &&
        typeof endNs === 'number' &&
        startNs > 0 &&
        endNs > 0
      ) {
        durationSec = Math.round((endNs - startNs) / 1_000_000_000);
      }
    }

    // Attestation is per-call: the API stamps the SAME object on every message
    // sharing a Call-ID, so the first message that carries a non-null one is
    // representative for the whole group. Falls back to null (no record).
    const attestation =
      messages.find((m) => m.attestation != null)?.attestation ?? null;

    callGroups.push({
      representative,
      callIds,
      messages,
      finalStatus,
      durationSec,
      attestation,
    });
  }

  // Sort call groups by representative timestamp (newest first for search results)
  callGroups.sort((a, b) =>
    b.representative.timestamp.localeCompare(a.representative.timestamp),
  );

  return callGroups;
}

/** Format seconds into a human-readable duration string. */
function fmtCallDuration(seconds: number): string {
  if (seconds < 0) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

// ─── Status pill ─────────────────────────────────────────────────────────────

interface StatusPillProps {
  status: number | null;
}

/** Final SIP status as a semantic pill on the paper canvas:
 *  2xx green (answered) · 1xx azure (provisional only) · 4xx amber · 5xx red. */
function StatusPill({ status }: StatusPillProps) {
  if (status === null) {
    return <span className="dlx5-status dlx5-status-none">—</span>;
  }
  let toneClass = 'dlx5-status-none';
  if (status >= 200 && status < 300) toneClass = 'dlx5-status-ok';
  else if (status >= 500) toneClass = 'dlx5-status-err';
  else if (status >= 400) toneClass = 'dlx5-status-warn';
  else if (status >= 100 && status < 200) toneClass = 'dlx5-status-info';
  return <span className={`dlx5-status ${toneClass}`}>{status}</span>;
}

// ─── Attestation badge ───────────────────────────────────────────────────────

interface AttestTone {
  text: string;
  bg: string;
  border: string;
}

/** Light-canvas STIR tones — same semantic mapping as the shared
 *  `attestationColors` palette (A=green, B=amber, C=gray, div=azure) but with
 *  ink-dark variants legible on white (the shared tokens are tuned for the
 *  dark surfaces they still serve elsewhere). */
const ATTEST_TONES: Record<'A' | 'B' | 'C' | 'div' | 'none', AttestTone> = {
  A: { text: '#15803d', bg: 'rgba(22,163,74,0.1)', border: 'rgba(22,163,74,0.26)' },
  B: { text: '#b45309', bg: 'rgba(180,83,9,0.09)', border: 'rgba(180,83,9,0.26)' },
  C: { text: '#5d6f8c', bg: 'rgba(93,111,140,0.08)', border: 'rgba(93,111,140,0.2)' },
  div: { text: '#1d63dd', bg: 'rgba(47,125,246,0.09)', border: 'rgba(47,125,246,0.26)' },
  none: { text: '#8b99b0', bg: 'rgba(93,111,140,0.08)', border: 'rgba(93,111,140,0.2)' },
};

function attestTone(level: string | null | undefined): AttestTone {
  if (level === 'A' || level === 'B' || level === 'C' || level === 'div') {
    return ATTEST_TONES[level];
  }
  return ATTEST_TONES.none;
}

interface AttestationBadgeProps {
  attestation: MessageAttestation | null;
}

/**
 * Compact STIR/SHAKEN badge for a call row. One pill; the full chain lives in
 * the call-detail/ladder view, so the fuller story — caller attestation +
 * verstat ✓/✗ + source — is stashed in the `title` on hover.
 *
 * Rendering:
 *   - base `A`/`B`/`C` → the single semantic-coloured letter (A=green, B=amber,
 *     C=gray).
 *   - `div` (diversion / forwarded call) → `div` is only the *mechanism*, so we
 *     surface the level the call actually CARRIES: a two-tone "A→div" chain pill,
 *     the carried level tinted by the caller's `inbound_attest` (A=green/B=amber/
 *     C=gray) followed by the azure `div`. If `inbound_attest` is unknown, we fall
 *     back to a plain azure `div`.
 *   - an out-of-band value (e.g. a runtime "unsigned") → a muted "unsigned".
 *   - `null` (no stored attestation: legacy / pre-deploy / signing-off) → a
 *     subtle muted "—", never an error.
 */
function AttestationBadge({ attestation }: AttestationBadgeProps) {
  if (attestation === null) {
    return (
      <span
        title="No STIR/SHAKEN attestation on record for this call (legacy, unsigned, or pre-deploy)."
        style={{ fontSize: '0.78rem', fontFamily: MONO, color: '#b6c2d4' }}
      >
        —
      </span>
    );
  }

  // Compose the hover "story": what the caller presented (attestation + verstat
  // verdict glyph + source) and what we signed. Kept terse — one line per fact.
  const verdict = verstatVerdict(attestation.inbound_verstat);
  const verstatGlyph = verdict === 'pass' ? '✓' : verdict === 'fail' ? '✗' : '–';
  const callerAttest = attestation.inbound_attest
    ? `${attestLabel(attestation.inbound_attest)} (${attestDescription(attestation.inbound_attest)})`
    : 'none';
  const verstatText = attestation.inbound_verstat ?? 'No validation';
  const sourceText = attestation.verstat_source
    ? ` [${attestation.verstat_source}]`
    : '';
  const title = [
    `Caller: ${callerAttest}`,
    `Verification: ${verstatGlyph} ${verstatText}${sourceText}`,
    `Signed: ${attestLabel(attestation.signed_attestation)} (${attestDescription(attestation.signed_attestation)})`,
  ].join('\n');

  const signed = attestation.signed_attestation;

  // `div` is only the *mechanism*. The meaningful signal is the attestation the
  // call actually carries — the caller's preserved level (`inbound_attest`). So
  // for a diversion we render a two-tone chain pill "A→div": the carried level
  // coloured by the CALLER's attestation, then the azure `div` mechanism. If the
  // caller's level is unknown (edge case) we fall back to a plain azure `div`.
  if (signed === 'div' && attestation.inbound_attest !== null) {
    const carried = attestTone(attestation.inbound_attest);
    const divTone = ATTEST_TONES.div;
    return (
      <span
        className="dlx5-attest"
        title={title}
        style={{ background: carried.bg, borderColor: carried.border }}
      >
        <span style={{ color: carried.text }}>{attestLabel(attestation.inbound_attest)}</span>
        <span style={{ color: INK_FAINT, margin: '0 1px' }}>→</span>
        <span style={{ color: divTone.text }}>div</span>
      </span>
    );
  }

  // Base A/B/C/div(no-caller): the single semantic-coloured letter, as before.
  // Any out-of-band value (e.g. a runtime "unsigned") isn't part of the
  // AttestationLevel union — render it as a muted "unsigned" rather than a hard
  // semantic colour.
  const isKnownLevel = signed === 'A' || signed === 'B' || signed === 'C' || signed === 'div';
  const tone = isKnownLevel ? attestTone(signed) : ATTEST_TONES.none;
  return (
    <span
      className="dlx5-attest"
      title={title}
      style={{ background: tone.bg, borderColor: tone.border, color: tone.text }}
    >
      {isKnownLevel ? attestLabel(signed) : 'unsigned'}
    </span>
  );
}

// ─── Empty / no-result states ────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="dl-center">
      <div className="dl-center-icon">
        {/* Network / signal icon */}
        <svg
          width={26}
          height={26}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 12.55a11 11 0 0 1 14.08 0" />
          <path d="M1.42 9a16 16 0 0 1 21.16 0" />
          <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
          <circle cx={12} cy={20} r={1} fill="currentColor" stroke="none" />
        </svg>
      </div>
      <p style={{ margin: 0, color: INK_DIM, fontSize: '0.85rem', maxWidth: 380 }}>
        Search by phone number — any format, full or a 3+ digit partial — or by
        SIP Call-ID, then expand a call to read its signaling ladder.
      </p>
      <p style={{ margin: 0, color: INK_FAINT, fontFamily: MONO, fontSize: '0.7rem' }}>
        +1 (617) 454-4217 · 617.454.4217 · 4544217 · a84b4c76@sbc-1
      </p>
    </div>
  );
}

// ─── Results table ────────────────────────────────────────────────────────────

interface ResultsTableProps {
  callGroups: CallGroup[];
  correlations: Record<string, string[]>;
  /** Pipeline diagnostics from the API — surfaced above each expanded ladder */
  pipelineWarnings: string[];
  /** The COMMITTED search window (frozen at Search time) — Grafana-link fallback. */
  windowStartIso: string;
  windowEndIso: string;
}

function ResultsTable({ callGroups, correlations, pipelineWarnings, windowStartIso, windowEndIso }: ResultsTableProps) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  return (
    <div className="dlx5-tablewrap">
      {/* min-width keeps the nowrap columns readable; narrower panels PAN
          inside the wrap (visible scrollbar) instead of crushing/overflowing. */}
      <table style={{ width: '100%', minWidth: 940, borderCollapse: 'collapse', fontSize: '0.78rem', color: INK_SOFT }}>
        <thead>
          <tr>
            <th className="dl-th" style={{ padding: '10px 10px 10px 20px' }}>Time</th>
            <th className="dl-th" style={{ padding: '10px 10px' }}>From → To</th>
            <th className="dl-th" style={{ padding: '10px 10px' }}>Call-ID</th>
            <th className="dl-th dlx5-col-path" style={{ padding: '10px 10px' }}>Network Path</th>
            <th className="dl-th" style={{ padding: '10px 10px' }}>Result</th>
            <th className="dl-th" style={{ padding: '10px 10px' }}>Attestation</th>
            <th className="dl-th" style={{ padding: '10px 10px' }}>Duration</th>
            <th className="dl-th" style={{ padding: '10px 10px' }}>Msgs</th>
            <th className="dl-th" style={{ padding: '10px 10px' }}>Node</th>
            <th className="dl-th" style={{ padding: '10px 16px 10px 8px', width: 72 }} aria-label="Expand" />
          </tr>
        </thead>
        <tbody>
          {callGroups.map((group, idx) => {
            const row = group.representative;

            // Scope the Grafana deep link to exactly this call's SIP messages
            // by passing ALL correlated Call-IDs (A-leg + B-leg) as a regex OR
            // pattern. The API's correlations map tells us which Call-IDs belong
            // to the same call via X-CID header analysis.
            const callIdPattern = group.callIds.join('|');

            // Gather timestamps from ALL messages in this call group for the time window
            const callTimestamps = group.messages
              .map((r) => r.timestamp_ns)
              .filter((ts): ts is number => typeof ts === 'number' && ts > 0);

            let fromMs: number;
            let toMs: number;
            if (callTimestamps.length > 0) {
              // 5 s before first message, 60 s after last (B-leg may outlive A-leg)
              fromMs = Math.floor(Math.min(...callTimestamps) / 1_000_000) - 5_000;
              toMs = Math.floor(Math.max(...callTimestamps) / 1_000_000) + 60_000;
            } else {
              // Fallback: use the committed search window
              fromMs = Math.floor(new Date(windowStartIso).getTime());
              toMs = Math.floor(new Date(windowEndIso).getTime());
            }

            const params = new URLSearchParams({
              'var-callid': callIdPattern,
              from: String(fromMs),
              to: String(toMs),
              kiosk: 'tv',
            });
            const grafanaLink = `/grafana/d/sip-search/sip-search?${params.toString()}`;

            const isExpanded = expandedIdx === idx;
            const ts = fmtDateParts(row.timestamp);

            return (
              <React.Fragment key={`${row.callid}-${idx}`}>
                <tr
                  className={isExpanded ? 'dl-row dlx5-row-open' : 'dl-row'}
                  onClick={() => setExpandedIdx(isExpanded ? null : idx)}
                  style={{ cursor: 'pointer' }}
                  title="Click to expand SIP ladder"
                >
                  {/* Time — two lines so microsecond precision doesn't widen the table */}
                  <td style={{ padding: '8px 10px 8px 20px', whiteSpace: 'nowrap' }}>
                    <div style={{ color: INK_SOFT, fontSize: '0.74rem', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                      {ts.date}
                    </div>
                    <div style={{ color: INK_DIM, fontFamily: MONO, fontSize: '0.66rem', fontVariantNumeric: 'tabular-nums' }}>
                      {ts.time}
                    </div>
                  </td>

                  {/* From → To */}
                  <td style={{ padding: '9px 10px', whiteSpace: 'nowrap' }}>
                    <span style={{ fontFamily: MONO, fontSize: '0.72rem', fontWeight: 500, color: INK_SOFT }}>
                      {displayUser(row.from_user)}
                    </span>
                    <span style={{ color: '#b6c2d4', margin: '0 6px' }}>→</span>
                    <span style={{ fontFamily: MONO, fontSize: '0.72rem', fontWeight: 600, color: AZURE_DEEP }}>
                      {displayUser(row.to_user)}
                    </span>
                  </td>

                  {/* Call-ID */}
                  <td
                    style={{
                      padding: '9px 10px',
                      fontFamily: MONO,
                      fontSize: '0.7rem',
                      color: INK_DIM,
                      maxWidth: 110,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={group.callIds.join('\n')}
                  >
                    {row.callid}
                  </td>

                  {/* Network path: src → dst */}
                  <td className="dlx5-col-path" style={{ padding: '9px 10px', fontFamily: MONO, fontSize: '0.7rem', color: INK_DIM, whiteSpace: 'nowrap' }}>
                    {row.src_ip}
                    <span style={{ color: '#b6c2d4', margin: '0 6px' }}>→</span>
                    {row.dst_ip}
                  </td>

                  {/* Result */}
                  <td style={{ padding: '9px 10px' }}>
                    <StatusPill status={group.finalStatus} />
                  </td>

                  {/* Attestation */}
                  <td style={{ padding: '9px 10px' }}>
                    <AttestationBadge attestation={group.attestation} />
                  </td>

                  {/* Duration */}
                  <td style={{ padding: '9px 10px', fontVariantNumeric: 'tabular-nums', color: INK_DIM, whiteSpace: 'nowrap' }}>
                    {group.durationSec !== null ? fmtCallDuration(group.durationSec) : '—'}
                  </td>

                  {/* Message count */}
                  <td style={{ padding: '9px 10px', fontVariantNumeric: 'tabular-nums', color: INK_DIM }}>
                    {group.messages.length}
                  </td>

                  {/* Node */}
                  <td style={{ padding: '9px 10px', fontFamily: MONO, fontSize: '0.7rem', color: INK_FAINT, whiteSpace: 'nowrap' }}>
                    {row.node ?? '—'}
                  </td>

                  {/* Explicit open-ladder affordance (label + rotating chevron) */}
                  <td style={{ padding: '9px 16px 9px 8px', textAlign: 'right' }}>
                    <span className="dlx5-openhint" aria-hidden="true">
                      {isExpanded ? 'Close' : 'Ladder'}
                      <span className="dlx5-chevron">
                        <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </span>
                    </span>
                  </td>
                </tr>

                {isExpanded && (
                  <tr>
                    <td colSpan={10} className="dlx5-expand-cell">
                      {/* Sticky containment plane: exactly one visible card
                          wide (100cqw), pinned at the left fold — the ladder
                          frame and the Grafana control never leave the screen
                          however wide the results table pans. */}
                      <div className="dlx5-expand-inner">
                        {/* Daylight inset frame hosting the ladder */}
                        <div className="dlx5-ladderframe">
                          <div className="dlx5-ladderframe-head">
                            <span className="dlx5-ladderframe-title">Signaling Ladder</span>
                            <span className="dlx5-ladderframe-route">
                              {displayUser(row.from_user)} → {displayUser(row.to_user)} · {group.callIds.length}{' '}
                              {group.callIds.length === 1 ? 'leg' : 'legs'}
                            </span>
                            <a
                              className="dlx5-frame-link"
                              href={grafanaLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <ExternalIcon size={11} />
                              Open in Grafana
                            </a>
                          </div>
                          {/* PCAP export strip — keyed by the representative
                              Call-ID so a different call's row NEVER inherits
                              this row's toggle state; unmounting on collapse
                              already resets it (default = edge-only, safe). */}
                          <PcapExportControl key={row.callid} callId={row.callid} />
                          <div className="dlx5-ladderframe-body">
                            <SipLadder
                              messages={group.messages}
                              correlations={correlations}
                              pipelineWarnings={pipelineWarnings}
                            />
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

/** The search committed by the last Search click — powers the results-header
 *  summary and the Grafana fallback window (frozen at commit time). */
interface CommittedSearch {
  /** e.g. `for numbers containing (617) 454-4217 · Call-ID containing “x@y”` */
  summary: string;
  startIso: string;
  endIso: string;
}

export function TroubleshootingPage() {
  // ── All hooks unconditionally at the top (React rules of hooks) ──
  const [omni, setOmni] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [fromUser, setFromUser] = useState('');
  const [toUser, setToUser] = useState('');
  const [advCallId, setAdvCallId] = useState('');
  const [rangePreset, setRangePreset] = useState<TracePresetId>('24h');
  // Custom-range pickers (local wall-clock) — authoritative only when
  // rangePreset === 'custom'; seeded from the default preset's window.
  const [startLocal, setStartLocal] = useState(() => toDatetimeLocal(new Date(Date.now() - DAY_MS)));
  const [endLocal, setEndLocal] = useState(() => toDatetimeLocal(new Date()));
  const [hasSearched, setHasSearched] = useState(false);
  const [lastSearch, setLastSearch] = useState<CommittedSearch | null>(null);
  // Shared desktop sidebar collapse — same localStorage key as AppLayout, so
  // the state carries across navigation between shells.
  const { collapsed, toggleCollapsed } = useSidebarCollapse();

  const searchMutation = useMutation({
    mutationFn: (params: HomerSearchParams) => searchSipTraces(params),
  });
  const { mutate: runSearch, reset: resetSearch } = searchMutation;

  // One pure derivation turns form state into the truth shown in the hint:
  // input classification, criteria segments, blocking errors, broad-search.
  const derived = useMemo(
    () => deriveSearch({ omni, fromUser, toUser, advCallId, rangePreset, startLocal, endLocal }),
    [omni, fromUser, toUser, advCallId, rangePreset, startLocal, endLocal],
  );

  const canSearch =
    derived.segments.length > 0 && derived.needleError === null && derived.rangeError === null;

  const handleSearch = useCallback(() => {
    // Mirrors the disabled state — Enter can arrive while invalid.
    if (!canSearch) return;

    // Resolve the RELATIVE preset to concrete instants NOW (commit time).
    let start: Date;
    let end: Date;
    if (rangePreset === 'custom') {
      start = new Date(startLocal); // local wall-clock → instant
      end = new Date(endLocal);
    } else {
      ({ start, end } = presetWindow(rangePreset, new Date()));
    }

    const params: HomerSearchParams = {
      start_time: start.toISOString(),
      end_time: end.toISOString(),
    };

    // Omnibox: the input goes out VERBATIM — the server owns normalization.
    const omniValue = omni.trim();
    if (derived.omniKind === 'number') params.number = omniValue;
    else if (derived.omniKind === 'callid') params.call_id = omniValue;

    // Advanced criteria are additive (AND-combined server-side). The advanced
    // Call-ID is '' while the omnibox IS the Call-ID (the field mirrors it).
    if (fromUser.trim()) params.from_user = fromUser.trim();
    if (toUser.trim()) params.to_user = toUser.trim();
    if (derived.effectiveAdvCallId) params.call_id = derived.effectiveAdvCallId;

    setLastSearch({
      summary: derived.segments.map((s) => `${s.label} ${s.needle}`).join(' · '),
      startIso: params.start_time,
      endIso: params.end_time,
    });
    setHasSearched(true);
    runSearch(params);
  }, [canSearch, derived, omni, fromUser, toUser, rangePreset, startLocal, endLocal, runSearch]);

  const handleClear = useCallback(() => {
    setOmni('');
    setFromUser('');
    setToUser('');
    setAdvCallId('');
    setAdvancedOpen(false);
    setRangePreset('24h');
    setStartLocal(toDatetimeLocal(new Date(Date.now() - DAY_MS)));
    setEndLocal(toDatetimeLocal(new Date()));
    setHasSearched(false);
    setLastSearch(null);
    resetSearch();
  }, [resetSearch]);

  // Submit on Enter from any input field
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') handleSearch();
    },
    [handleSearch],
  );

  // ── Memoised call grouping (hooks — must stay above early returns) ──
  // The fallbacks are memoised on the response object so their identity is
  // stable across renders — otherwise `?? []` / `?? {}` would re-run the
  // union-find grouping on every keystroke.
  const searchData = searchMutation.data;
  const results = useMemo(() => searchData?.data ?? [], [searchData]);
  const correlations = useMemo(() => searchData?.correlations ?? {}, [searchData]);
  const pipelineWarnings = searchData?.pipeline_warnings ?? [];

  const callGroups = useMemo(
    () => groupMessagesByCall(results, correlations),
    [results, correlations],
  );

  // ── Derived values (after all hooks) ──
  const totalMessages = results.length;
  const totalCalls = callGroups.length;
  const isLoading = searchMutation.isPending;
  const isError = searchMutation.isError;
  const errorMessage = isError
    ? (searchMutation.error instanceof Error
        ? searchMutation.error.message
        : 'Search failed')
    : null;

  const isCustomRange = rangePreset === 'custom';
  // While a preset is active the pickers show its live preview (recomputed
  // each render — close enough to "now"; the authoritative resolution happens
  // at Search time). Same idiom as the CDR filter bar.
  const rangePreview = isCustomRange ? null : presetWindow(rangePreset, new Date());
  const startPickerValue = rangePreview ? toDatetimeLocal(rangePreview.start) : startLocal;
  const endPickerValue = rangePreview ? toDatetimeLocal(rangePreview.end) : endLocal;

  // Advanced Call-ID mirrors the omnibox while the omnibox IS a Call-ID.
  const omniIsCallId = derived.omniKind === 'callid';
  const advCallIdValue = omniIsCallId ? omni.trim() : advCallId;
  // Criteria active in the advanced row (badge on the collapsed toggle).
  const advActiveCount =
    (fromUser.trim() ? 1 : 0) + (toUser.trim() ? 1 : 0) + (derived.effectiveAdvCallId ? 1 : 0);

  // ── Render ──
  return (
    <>
      <Sidebar collapsed={collapsed} />

      {/* Collapse/expand tab — shared with AppLayout via SidebarCollapse.tsx
          (state persists under `sidebar_collapsed`, carrying across shells). */}
      <SidebarCollapseTab collapsed={collapsed} onToggle={toggleCollapsed} />

      {/* Page-owned daylight canvas — .dlx5-canvas re-grounds .dl-scope for
          the no-AppLayout, fixed-sidebar layout (see dl-troubleshoot.css).
          The --collapsed modifier animates the 240px offset to 0 in sync
          with the sidebar slide. */}
      <div className={collapsed ? 'dl-scope dlx5-canvas dlx5-canvas--collapsed' : 'dl-scope dlx5-canvas'}>
        <div className="dl-shell">
          {/* ── Quiet console header ─────────────────────────────────── */}
          <header className="dl-header fx-load">
            <div className="dl-header-id">
              <div className="dl-crumb">
                <span>Troubleshooting</span>
                <span className="dl-crumb-sep" aria-hidden="true">/</span>
                <span>Granite CRAG</span>
              </div>
              <h1 className="dl-title">SIP Trace Search</h1>
              <p className="dl-sub">
                Find any call by phone number — any format, full or partial — or by Call-ID, then expand it to read the full signaling ladder.
              </p>
            </div>

            <div style={{ flexShrink: 0, paddingBottom: 4 }}>
              <a
                className="dl-btn dl-btn-ghost"
                href="/grafana/"
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalIcon size={13} />
                Open SIP Dashboard
              </a>
            </div>
          </header>

          <div className="dl-stack" style={{ paddingBottom: 24 }}>
            {/* ── Search form ──────────────────────────────────────────── */}
            <div className="dl-panel fx-load fx-load-d1">
              <div className="dl-panel-head">
                <span className="dl-panel-title">Search</span>
                <span className="dl-panel-sub">
                  Numbers match the caller, the callee, or anywhere in the SIP message — paste them in any format.
                </span>
              </div>
              <div className="dl-panel-body">
                {/* Omnibox — the one control most searches need */}
                <div className="dlx5-omnirow">
                  <div className="dlx5-omniwrap">
                    <span className="dlx5-omni-icon" aria-hidden="true">
                      <SearchIcon />
                    </span>
                    <input
                      id="sip-omni"
                      type="text"
                      className="dl-input dl-input-mono dlx5-omni"
                      placeholder="Number or Call-ID — any format"
                      aria-label="Search by number or Call-ID, any format"
                      value={omni}
                      onChange={(e) => setOmni(e.target.value)}
                      onKeyDown={handleKeyDown}
                      autoFocus
                    />
                  </div>
                  <button
                    type="button"
                    className="dl-btn dl-btn-primary"
                    onClick={handleSearch}
                    disabled={isLoading || !canSearch}
                  >
                    {isLoading ? <Spinner size="xs" /> : <SearchIcon />}
                    {isLoading ? 'Searching…' : 'Search'}
                  </button>
                  <button
                    type="button"
                    className="dl-btn dl-btn-ghost"
                    onClick={handleClear}
                    disabled={isLoading}
                  >
                    Clear
                  </button>
                </div>

                {/* Live, always-truthful hint — states exactly what Search will send */}
                <div className="dlx5-hintstrip" aria-live="polite">
                  {derived.needleError !== null ? (
                    <p className="dlx5-hint dlx5-hint-warn">{derived.needleError}</p>
                  ) : derived.segments.length > 0 ? (
                    <p className="dlx5-hint">
                      Searching{' '}
                      {derived.segments.map((s, i) => (
                        <React.Fragment key={`${s.label}-${i}`}>
                          {i > 0 && <span className="dlx5-hint-sep"> · </span>}
                          {s.label}{' '}
                          <span className="dlx5-hint-needle">{s.needle}</span>
                        </React.Fragment>
                      ))}
                    </p>
                  ) : (
                    <p className="dlx5-hint">
                      Type a number in any format — full or a 3+ digit partial — or paste a SIP Call-ID.
                    </p>
                  )}
                  {derived.broadSearch && (
                    <p className="dlx5-hint dlx5-hint-warn">
                      Broad search — a short needle over a window this large may be slow. Narrow the time range if it drags.
                    </p>
                  )}
                </div>

                {/* Time range — relative presets, resolved at Search time */}
                <div className="dlx5-timerow">
                  <div>
                    <span className="dl-flabel">Time Range</span>
                    <div className="dlx5-seg" role="group" aria-label="Time range presets">
                      {TRACE_PRESETS.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          aria-pressed={rangePreset === p.id}
                          className={rangePreset === p.id ? 'dlx5-seg-btn dlx5-seg-btn-active' : 'dlx5-seg-btn'}
                          onClick={() => setRangePreset(p.id)}
                        >
                          {p.label}
                        </button>
                      ))}
                      <button
                        type="button"
                        aria-pressed={isCustomRange}
                        className={isCustomRange ? 'dlx5-seg-btn dlx5-seg-btn-active' : 'dlx5-seg-btn'}
                        onClick={() => {
                          // Seed the editable pickers from the window currently shown.
                          setStartLocal(startPickerValue);
                          setEndLocal(endPickerValue);
                          setRangePreset('custom');
                        }}
                      >
                        Custom
                      </button>
                    </div>
                  </div>

                  <div className="dlx5-timefield">
                    <label className="dl-flabel" htmlFor="sip-start">
                      Start{isCustomRange ? ' (local)' : ''}
                    </label>
                    <input
                      id="sip-start"
                      type="datetime-local"
                      value={startPickerValue}
                      disabled={!isCustomRange}
                      aria-invalid={derived.rangeError !== null}
                      onChange={(e) => setStartLocal(e.target.value)}
                      onKeyDown={handleKeyDown}
                      className="dl-input"
                      style={{ width: '100%', colorScheme: 'light' }}
                    />
                  </div>

                  <div className="dlx5-timefield">
                    <label className="dl-flabel" htmlFor="sip-end">
                      End{isCustomRange ? ' (local)' : ''}
                    </label>
                    <input
                      id="sip-end"
                      type="datetime-local"
                      value={endPickerValue}
                      disabled={!isCustomRange}
                      aria-invalid={derived.rangeError !== null}
                      onChange={(e) => setEndLocal(e.target.value)}
                      onKeyDown={handleKeyDown}
                      className="dl-input"
                      style={{ width: '100%', colorScheme: 'light' }}
                    />
                  </div>
                </div>

                {derived.rangeError !== null && (
                  <p className="dlx5-invalid" role="alert">
                    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <circle cx={12} cy={12} r={10} />
                      <line x1={12} y1={8} x2={12} y2={12} />
                      <line x1={12} y1={16} x2="12.01" y2={16} />
                    </svg>
                    {derived.rangeError}
                  </p>
                )}

                {/* Advanced — From / To / Call-ID, collapsed by default */}
                <button
                  type="button"
                  className="dlx5-adv-toggle"
                  aria-expanded={advancedOpen}
                  onClick={() => setAdvancedOpen((open) => !open)}
                >
                  <span className="dlx5-adv-caret" aria-hidden="true">
                    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </span>
                  Advanced
                  {!advancedOpen && advActiveCount > 0 && (
                    <span className="dlx5-adv-count">{advActiveCount} active</span>
                  )}
                </button>

                {advancedOpen && (
                  <div className="dlx5-form-grid dlx5-adv">
                    <div>
                      <label className="dl-flabel" htmlFor="sip-from">From</label>
                      <input
                        id="sip-from"
                        type="text"
                        value={fromUser}
                        onChange={(e) => setFromUser(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Caller — number, any format (3+ digits)"
                        className="dl-input"
                        style={{ width: '100%' }}
                      />
                      <p className="dl-help">Only calls FROM this number/user.</p>
                    </div>

                    <div>
                      <label className="dl-flabel" htmlFor="sip-to">To</label>
                      <input
                        id="sip-to"
                        type="text"
                        value={toUser}
                        onChange={(e) => setToUser(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Callee — number, any format (3+ digits)"
                        className="dl-input"
                        style={{ width: '100%' }}
                      />
                      <p className="dl-help">Only calls TO this number/user.</p>
                    </div>

                    <div>
                      <label className="dl-flabel" htmlFor="sip-callid">Call-ID</label>
                      <input
                        id="sip-callid"
                        type="text"
                        value={advCallIdValue}
                        disabled={omniIsCallId}
                        onChange={(e) => setAdvCallId(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="SIP Call-ID"
                        className="dl-input dl-input-mono"
                        style={{ width: '100%', fontSize: '0.8rem' }}
                      />
                      <p className="dl-help">
                        {omniIsCallId
                          ? 'Synced from the search box — clear it to type a Call-ID here.'
                          : 'Exact-field Call-ID match.'}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* ── Results ──────────────────────────────────────────────── */}
            <div className="dl-panel fx-load fx-load-d2">
              <div className="dl-panel-head">
                <span className="dl-panel-title">Results</span>
                {hasSearched && !isLoading && !isError && (
                  <span className="dl-count" style={{ marginLeft: 'auto' }}>
                    {totalCalls} {totalCalls === 1 ? 'call' : 'calls'} · {totalMessages} messages
                  </span>
                )}
                {hasSearched && lastSearch && (
                  <span className="dl-panel-sub">
                    Searched {lastSearch.summary} · {fmtWindowStamp(lastSearch.startIso)} →{' '}
                    {fmtWindowStamp(lastSearch.endIso)} (local)
                  </span>
                )}
              </div>

              {isLoading && (
                <div className="dl-center" style={{ flexDirection: 'row', gap: 10, color: INK_DIM, fontSize: '0.85rem' }}>
                  <Spinner size="xs" />
                  Searching SIP traces…
                </div>
              )}

              {isError && !isLoading && (
                <div style={{ padding: 20 }}>
                  <div className="dl-banner dl-banner-err">
                    {errorMessage ?? 'Search failed. Is the Homer backend reachable?'}
                  </div>
                </div>
              )}

              {!isLoading && !isError && !hasSearched && <EmptyState />}

              {!isLoading && !isError && hasSearched && results.length === 0 && (
                <div style={{ padding: 20 }}>
                  <div className="dl-empty">
                    No SIP traces matched. Try a wider time range, fewer digits
                    (any 3+ digit partial matches), or drop an Advanced filter.
                  </div>
                </div>
              )}

              {!isLoading && !isError && callGroups.length > 0 && lastSearch && (
                <ResultsTable
                  callGroups={callGroups}
                  correlations={correlations}
                  pipelineWarnings={pipelineWarnings}
                  windowStartIso={lastSearch.startIso}
                  windowEndIso={lastSearch.endIso}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

// ─── SVG Icons ────────────────────────────────────────────────────────────────

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14 }}>
      <circle cx="6.5" cy="6.5" r="4" />
      <path d="M11 11l2.5 2.5" />
    </svg>
  );
}

function ExternalIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}
