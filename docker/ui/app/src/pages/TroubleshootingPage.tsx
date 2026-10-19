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
 * Search form layout (2026-10): omnibox row (40px controls, primary Search at
 * the row's end) with the live hint under it, then a 3-column filter grid
 * (Time range · Start · End) that the Advanced grid (From · To · Call-ID)
 * shares column-for-column, so every label and control lines up vertically.
 *
 * Results columns (2026-09 redesign): Time (compact 24h+ms) · From→To ·
 * Orig/Term carrier (derived client-side from the group's endpoint aliases)
 * · Result · Attestation · Duration · Zone (HEP capture node id → zone).
 *
 * Call detail (2026-10): clicking a row — or Enter/Space on a focused row —
 * opens <CallTraceModal> (pages/troubleshooting/CallTraceModal.tsx), a large
 * portal panel with a distinct cobalt outline holding the call summary, the
 * Grafana deep link, PCAP export, network path, correlation notice and the
 * full <SipLadder> + packet inspector. It replaced the old inline expanded
 * row. ←/→ (or the panel's Prev/Next) step through the calls on the current
 * results page; Esc / backdrop / × close it and focus returns to the row.
 *
 * Cursor paging: the search response carries `oldest_ts_ns` + `has_more`;
 * Next re-issues the COMMITTED search with `before_ns` via `withPageCursor`
 * (the one pinned-contract seam), Prev pops a client-side cursor stack
 * (page 1 = the original search). New search resets to page 1. Any new
 * response (page or search) closes the call panel — the selection is bound
 * to the exact call-group array it was made against.
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
 */
import React, { useState, useCallback, useMemo, useRef, type KeyboardEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Sidebar } from '../components/layout/Sidebar';
import { SidebarCollapseTab } from '../components/layout/SidebarCollapse';
import { useSidebarCollapse } from '../components/layout/useSidebarCollapse';
import { Spinner } from '../components/ui/Spinner';
import { searchSipTraces } from '../api/homer';
import type { HomerSearchParams } from '../api/homer';
import { toDatetimeLocal } from './calls/callsFilters';
import {
  deriveCorrelationNotice,
  groupMessagesByCall,
  type CallGroup,
  type CorrelationNotice,
} from './troubleshooting/callGrouping';
import {
  AZURE_DEEP,
  INK_DIM,
  INK_FAINT,
  INK_SOFT,
  MONO,
  carrierEndpointLabel,
  deriveCarrierEndpoints,
  deriveZone,
  displayUser,
  fmtCallDuration,
  fmtCompactTs,
} from './troubleshooting/callDisplay';
import {
  AttemptsBadge,
  AttestationBadge,
  CorrelationBanner,
  ExternalIcon,
  StatusPill,
  ZonePill,
} from './troubleshooting/CallBadges';
import { CallTraceModal, type StepDirection } from './troubleshooting/CallTraceModal';
import '../styles/dl-troubleshoot.css';

// Dev-only self-test for one-row-per-call grouping (RESULT from the A leg,
// failover attempts, correlation notice). `import.meta.env.DEV` is statically
// false in production builds, so the module is dead-code-eliminated.
if (import.meta.env.DEV) {
  void import('./troubleshooting/callGrouping.assert');
}

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

// ─── Call grouping & display helpers ────────────────────────────────────────
// groupMessagesByCall + CallGroup live in ./troubleshooting/callGrouping.ts —
// a PURE module (no React/deps) so the self-tests (callGrouping.assert.ts,
// components/sip-ladder/sipLadderFidelity.assert.ts) can bundle-and-node-
// execute the REAL grouping code, same pattern as ladderOrder.assert.ts.
// Groups link via `correlations` AND the API's `legs` map; RESULT/duration
// come from the A leg, failover attempts are exposed as `group.attempts`.
// Per-call display derivations (zone, carrier endpoints, timestamps, Grafana
// link) live in ./troubleshooting/callDisplay.ts and the pill/badge atoms in
// ./troubleshooting/CallBadges.tsx — shared by the table and the call modal.

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
        SIP Call-ID, then open a call to read its signaling ladder.
      </p>
      <p style={{ margin: 0, color: INK_FAINT, fontFamily: MONO, fontSize: '0.7rem' }}>
        +1 (617) 454-4217 · 617.454.4217 · 4544217 · a84b4c76@sbc-1
      </p>
    </div>
  );
}


interface ResultsTableProps {
  callGroups: CallGroup[];
  /** Pipeline diagnostics from the API — surfaced inside the call modal's ladder */
  pipelineWarnings: string[];
  /** Search-level leg-correlation warning — repeated inside the call modal */
  correlationNotice: CorrelationNotice | null;
  /** The COMMITTED search window (frozen at Search time) — Grafana-link fallback. */
  windowStartIso: string;
  windowEndIso: string;
}

/** The open call. Bound to the exact `callGroups` array it was made against:
 *  a new response (paging or a new search) produces a new array, which makes
 *  a stale selection read as closed WITHOUT an effect — the modal can never
 *  show a call that isn't in the current results. */
interface CallSelection {
  groups: CallGroup[];
  idx: number;
}

function ResultsTable({
  callGroups,
  pipelineWarnings,
  correlationNotice,
  windowStartIso,
  windowEndIso,
}: ResultsTableProps) {
  // ── ALL hooks unconditionally at the top ──
  const [selection, setSelection] = useState<CallSelection | null>(null);
  // Row elements by index — focus return on close + ↑/↓ row navigation.
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>());

  // Per-row derivations, computed once per response (not per selection change).
  const rowFacts = useMemo(
    () =>
      callGroups.map((group) => ({
        endpoints: deriveCarrierEndpoints(group.messages),
        zone: deriveZone(group.messages),
      })),
    [callGroups],
  );

  const activeIdx =
    selection !== null && selection.groups === callGroups && selection.idx < callGroups.length
      ? selection.idx
      : null;

  const openCall = useCallback(
    (idx: number) => setSelection({ groups: callGroups, idx }),
    [callGroups],
  );

  const handleStep = useCallback((direction: StepDirection) => {
    setSelection((current) => {
      if (current === null) return current;
      const next = current.idx + direction;
      if (next < 0 || next >= current.groups.length) return current;
      return { groups: current.groups, idx: next };
    });
  }, []);

  // Close → focus returns to the row of the call that was open LAST (after
  // stepping, that is not necessarily the row that was clicked).
  const handleClose = useCallback(() => {
    const idx = activeIdx;
    setSelection(null);
    if (idx === null) return;
    const rowEl = rowRefs.current.get(idx);
    if (rowEl) {
      rowEl.focus({ preventScroll: true });
      rowEl.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIdx]);

  const handleRowKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTableRowElement>, idx: number) => {
      if (e.target !== e.currentTarget) return; // a control inside the row
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openCall(idx);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const target = rowRefs.current.get(e.key === 'ArrowDown' ? idx + 1 : idx - 1);
        if (target) {
          e.preventDefault();
          target.focus();
        }
      }
    },
    [openCall],
  );

  const activeGroup = activeIdx !== null ? callGroups[activeIdx] : null;

  return (
    <>
      <div className="dlx5-tablewrap">
        {/* min-width keeps the nowrap columns readable; narrower panels PAN
            inside the wrap (visible scrollbar) instead of crushing/overflowing. */}
        <table style={{ width: '100%', minWidth: 960, borderCollapse: 'collapse', fontSize: '0.78rem', color: INK_SOFT }}>
          <thead>
            <tr>
              <th className="dl-th" style={{ padding: '10px 10px 10px 20px' }}>Time</th>
              <th className="dl-th" style={{ padding: '10px 10px' }}>From → To</th>
              <th className="dl-th" style={{ padding: '10px 10px' }}>Orig</th>
              <th className="dl-th" style={{ padding: '10px 10px' }}>Term</th>
              <th className="dl-th" style={{ padding: '10px 10px' }}>Result</th>
              <th className="dl-th" style={{ padding: '10px 10px' }}>Attestation</th>
              <th className="dl-th" style={{ padding: '10px 10px' }}>Duration</th>
              <th className="dl-th" style={{ padding: '10px 10px' }}>Zone</th>
              <th className="dl-th" style={{ padding: '10px 20px 10px 8px', width: 84 }}>
                <span className="dlx5-visually-hidden">Open call detail</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {callGroups.map((group, idx) => {
              const row = group.representative;
              const { endpoints, zone } = rowFacts[idx];
              const isActive = activeIdx === idx;

              return (
                <tr
                  key={`${row.callid}-${idx}`}
                  ref={(el) => {
                    if (el) rowRefs.current.set(idx, el);
                    else rowRefs.current.delete(idx);
                  }}
                  className={isActive ? 'dl-row dlx5-row dlx5-row-open' : 'dl-row dlx5-row'}
                  tabIndex={0}
                  aria-haspopup="dialog"
                  aria-label={`Call ${displayUser(row.from_user)} to ${displayUser(row.to_user)} at ${fmtCompactTs(row.timestamp)} — open SIP ladder`}
                  onClick={() => openCall(idx)}
                  onKeyDown={(e) => handleRowKeyDown(e, idx)}
                  title="Open the SIP ladder and call detail"
                >
                  {/* Time — compact single line, 24h, ms precision */}
                  <td
                    style={{
                      padding: '9px 10px 9px 20px',
                      whiteSpace: 'nowrap',
                      fontFamily: MONO,
                      fontSize: '0.7rem',
                      color: INK_SOFT,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {fmtCompactTs(row.timestamp)}
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

                  {/* Orig carrier — external source of the ingress INVITE */}
                  <td
                    style={{ padding: '9px 10px', fontFamily: MONO, fontSize: '0.7rem', color: INK_DIM, whiteSpace: 'nowrap' }}
                    title={endpoints.orig ?? 'No externally-sourced INVITE captured'}
                  >
                    {endpoints.orig !== null ? carrierEndpointLabel(endpoints.orig) : '—'}
                  </td>

                  {/* Term carrier — external destination of the egress INVITE */}
                  <td
                    style={{ padding: '9px 10px', fontFamily: MONO, fontSize: '0.7rem', color: INK_DIM, whiteSpace: 'nowrap' }}
                    title={endpoints.term ?? 'No terminating leg (inbound-only or failed call)'}
                  >
                    {endpoints.term !== null ? carrierEndpointLabel(endpoints.term) : '—'}
                  </td>

                  {/* Result */}
                  <td style={{ padding: '9px 10px', whiteSpace: 'nowrap' }}>
                    <StatusPill status={group.finalStatus} />
                    <AttemptsBadge attempts={group.attempts} />
                  </td>

                  {/* Attestation */}
                  <td style={{ padding: '9px 10px' }}>
                    <AttestationBadge attestation={group.attestation} />
                  </td>

                  {/* Duration */}
                  <td style={{ padding: '9px 10px', fontVariantNumeric: 'tabular-nums', color: INK_DIM, whiteSpace: 'nowrap' }}>
                    {group.durationSec !== null ? fmtCallDuration(group.durationSec) : '—'}
                  </td>

                  {/* Zone (from the HEP capture node id) */}
                  <td style={{ padding: '9px 10px', whiteSpace: 'nowrap' }}>
                    <ZonePill zone={zone} />
                  </td>

                  {/* Open-panel affordance (label + panel glyph) */}
                  <td style={{ padding: '9px 20px 9px 8px', textAlign: 'right' }}>
                    <span className="dlx5-openhint" aria-hidden="true">
                      Ladder
                      <span className="dlx5-chevron">
                        <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                          <rect x={3} y={4} width={18} height={16} rx={2} />
                          <line x1={3} y1={9} x2={21} y2={9} />
                        </svg>
                      </span>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {activeGroup !== null && activeIdx !== null && (
        <CallTraceModal
          group={activeGroup}
          position={activeIdx}
          total={callGroups.length}
          pipelineWarnings={pipelineWarnings}
          correlationNotice={correlationNotice}
          windowStartIso={windowStartIso}
          windowEndIso={windowEndIso}
          onClose={handleClose}
          onStep={handleStep}
        />
      )}
    </>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

/** The search committed by the last Search click — powers the results-header
 *  summary, the Grafana fallback window, and cursor paging (all frozen at
 *  commit time — paging re-issues these EXACT params, never live form state). */
interface CommittedSearch {
  /** e.g. `for numbers containing (617) 454-4217 · Call-ID containing “x@y”` */
  summary: string;
  startIso: string;
  endIso: string;
  /** The exact request of page 1 — every page re-issues this + a cursor. */
  baseParams: HomerSearchParams;
}

/**
 * THE one place paging attaches its cursor to the committed search — PINNED
 * CONTRACT with POST /homer/search (docker/api/src/routers/homer.py):
 * the response carries `oldest_ts_ns` (cursor) + `has_more`; the next page
 * re-issues the SAME search with `before_ns = oldest_ts_ns` (strict
 * `timestamp_ns < before_ns` server-side). `before_ns` is the implemented
 * mechanism; if it were ever dropped, the one-line fallback is deriving a
 * shrunken end window instead:
 *   `{ ...base, end_time: new Date(Math.floor(beforeNs / 1e6)).toISOString() }`
 * (lossy — end_time parses at µs precision vs ns timestamps — which is
 * exactly why before_ns exists).
 */
function withPageCursor(
  base: HomerSearchParams,
  beforeNs: number | null,
): HomerSearchParams {
  if (beforeNs === null) return base; // page 1 — the original search
  return { ...base, before_ns: beforeNs };
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
  // Cursor paging: the stack of `before_ns` cursors that produced the pages
  // AFTER page 1 (page = stack length + 1). Prev pops; page 1 = empty stack
  // = the original committed search. Reset on every new search.
  const [cursorStack, setCursorStack] = useState<number[]>([]);
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
      baseParams: params,
    });
    setHasSearched(true);
    setCursorStack([]); // new search always starts at page 1
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
    setCursorStack([]);
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
  const legs = searchData?.legs; // absent on older APIs → correlations-only grouping
  const pipelineWarnings = searchData?.pipeline_warnings ?? [];

  const callGroups = useMemo(
    () => groupMessagesByCall(results, correlations, legs),
    [results, correlations, legs],
  );
  const correlationNotice = useMemo(() => deriveCorrelationNotice(searchData), [searchData]);

  // ── Cursor paging handlers (hooks — still above any early return) ──
  // Next: push this page's oldest_ts_ns and re-issue the COMMITTED search
  // bounded below it. Prev: pop and re-issue with the previous cursor
  // (empty stack = the original page-1 search). Both go through
  // withPageCursor — the single seam pinned to the backend contract.
  const handleNextPage = useCallback(() => {
    if (!lastSearch) return;
    const oldest = searchData?.oldest_ts_ns;
    if (searchData?.has_more !== true || typeof oldest !== 'number' || oldest <= 0) return;
    setCursorStack((stack) => [...stack, oldest]);
    runSearch(withPageCursor(lastSearch.baseParams, oldest));
  }, [lastSearch, searchData, runSearch]);

  const handlePrevPage = useCallback(() => {
    if (!lastSearch || cursorStack.length === 0) return;
    const popped = cursorStack.slice(0, -1);
    setCursorStack(popped);
    runSearch(
      withPageCursor(
        lastSearch.baseParams,
        popped.length > 0 ? popped[popped.length - 1] : null,
      ),
    );
  }, [lastSearch, cursorStack, runSearch]);

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

  // Cursor-paging readouts. `page` is authoritative from the cursor stack
  // (it already reflects the page being FETCHED during a transition). Next
  // needs both contract fields: has_more true AND a usable cursor. No totals
  // exist for trace search — the pager is Prev / "Page N" / Next only.
  const page = cursorStack.length + 1;
  const canNextPage =
    searchData?.has_more === true &&
    typeof searchData.oldest_ts_ns === 'number' &&
    searchData.oldest_ts_ns > 0;
  // Deep pages keep the pager through a fetch error so Prev can step back to
  // a good page (Next self-disables — an errored response has no cursor).
  const showPager = hasSearched && (page > 1 || (!isError && canNextPage));

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
        {/* dlx5-shell-wide: page-scoped 1800px cap matching the Calls &
            Quality page (dlx4-shell-wide) — the shared .dl-shell stays 1200. */}
        <div className="dl-shell dlx5-shell-wide">
          {/* ── Quiet console header ─────────────────────────────────── */}
          <header className="dl-header dlx5-header fx-load">
            <div className="dl-header-id">
              <div className="dl-crumb">
                <span>Troubleshooting</span>
                <span className="dl-crumb-sep" aria-hidden="true">/</span>
                <span>Granite CRAG</span>
              </div>
              <h1 className="dl-title">SIP Trace Search</h1>
              <p className="dl-sub">
                Find any call by phone number — any format, full or partial — or by Call-ID, then open it to read the full signaling ladder.
              </p>
            </div>

            <a
              className="dl-btn dl-btn-ghost dlx5-header-action"
              href="/grafana/"
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalIcon size={13} />
              Open SIP Dashboard
            </a>
          </header>

          <div className="dl-stack dlx5-stack">
            {/* ── Search form ──────────────────────────────────────────── */}
            <section className="dl-panel dlx5-search fx-load fx-load-d1" aria-labelledby="sip-search-title">
              <div className="dl-panel-head">
                <span className="dl-panel-title" id="sip-search-title">Search</span>
                <span className="dl-panel-sub">
                  Numbers match the caller, the callee, or anywhere in the SIP message — paste them in any format.
                </span>
              </div>
              <div className="dl-panel-body dlx5-search-body">
                {/* Omnibox — the one control most searches need. Search /
                    Clear sit on the field's row at the same 40px height. */}
                <div className="dlx5-field">
                  <label className="dl-flabel" htmlFor="sip-omni">Number or Call-ID</label>
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
                        aria-describedby="sip-omni-hint"
                        value={omni}
                        onChange={(e) => setOmni(e.target.value)}
                        onKeyDown={handleKeyDown}
                        autoFocus
                      />
                    </div>
                    <button
                      type="button"
                      className="dl-btn dl-btn-primary dlx5-search-btn"
                      onClick={handleSearch}
                      disabled={isLoading || !canSearch}
                    >
                      {isLoading ? <Spinner size="xs" /> : <SearchIcon />}
                      {isLoading ? 'Searching…' : 'Search'}
                    </button>
                    <button
                      type="button"
                      className="dl-btn dl-btn-ghost dlx5-clear-btn"
                      onClick={handleClear}
                      disabled={isLoading}
                    >
                      Clear
                    </button>
                  </div>

                  {/* Live, always-truthful hint — states exactly what Search will send */}
                  <div className="dlx5-hintstrip" id="sip-omni-hint" aria-live="polite">
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
                </div>

                {/* Time range — relative presets, resolved at Search time.
                    Same 3-column grid as the Advanced row below, so the two
                    rows align column-for-column. */}
                <div className="dlx5-grid3 dlx5-timerow">
                  <div className="dlx5-field">
                    <span className="dl-flabel" id="sip-range-label">Time Range</span>
                    <div className="dlx5-seg" role="group" aria-labelledby="sip-range-label">
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

                  <div className="dlx5-field">
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
                      className="dl-input dlx5-ctl"
                      style={{ colorScheme: 'light' }}
                    />
                  </div>

                  <div className="dlx5-field">
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
                      className="dl-input dlx5-ctl"
                      style={{ colorScheme: 'light' }}
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
                <div className="dlx5-advbar">
                  <button
                    type="button"
                    className="dlx5-adv-toggle"
                    aria-expanded={advancedOpen}
                    aria-controls="sip-advanced"
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
                  <span className="dlx5-advbar-note">From · To · Call-ID — combined with the search above</span>
                </div>

                {advancedOpen && (
                  <div className="dlx5-grid3 dlx5-adv" id="sip-advanced">
                    <div className="dlx5-field">
                      <label className="dl-flabel" htmlFor="sip-from">From</label>
                      <input
                        id="sip-from"
                        type="text"
                        value={fromUser}
                        onChange={(e) => setFromUser(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Caller — number, any format (3+ digits)"
                        className="dl-input dlx5-ctl"
                      />
                      <p className="dl-help">Only calls FROM this number/user.</p>
                    </div>

                    <div className="dlx5-field">
                      <label className="dl-flabel" htmlFor="sip-to">To</label>
                      <input
                        id="sip-to"
                        type="text"
                        value={toUser}
                        onChange={(e) => setToUser(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="Callee — number, any format (3+ digits)"
                        className="dl-input dlx5-ctl"
                      />
                      <p className="dl-help">Only calls TO this number/user.</p>
                    </div>

                    <div className="dlx5-field">
                      <label className="dl-flabel" htmlFor="sip-callid">Call-ID</label>
                      <input
                        id="sip-callid"
                        type="text"
                        value={advCallIdValue}
                        disabled={omniIsCallId}
                        onChange={(e) => setAdvCallId(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder="SIP Call-ID"
                        className="dl-input dl-input-mono dlx5-ctl"
                        style={{ fontSize: '0.8rem' }}
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
            </section>

            {/* ── Results ──────────────────────────────────────────────── */}
            <section className="dl-panel fx-load fx-load-d2" aria-labelledby="sip-results-title">
              <div className="dl-panel-head dlx5-results-head">
                <span className="dl-panel-title" id="sip-results-title">Results</span>
                {hasSearched && !isLoading && !isError && (
                  <span className="dl-count dlx5-results-count">
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
                    {page > 1
                      ? `No older traces on page ${page} — the result set ended. Step back with Prev.`
                      : 'No SIP traces matched. Try a wider time range, fewer digits (any 3+ digit partial matches), or drop an Advanced filter.'}
                  </div>
                </div>
              )}

              {!isLoading && !isError && correlationNotice !== null && results.length > 0 && (
                <div style={{ padding: '12px 20px 0' }}>
                  <CorrelationBanner notice={correlationNotice} />
                </div>
              )}

              {/* key={page}: a page swap is new data under the same component —
                  remount so an open call panel from the outgoing page can never
                  point at a different call on the incoming one (the selection is
                  also bound to the callGroups array identity — belt and braces). */}
              {!isLoading && !isError && callGroups.length > 0 && lastSearch && (
                <ResultsTable
                  key={page}
                  callGroups={callGroups}
                  pipelineWarnings={pipelineWarnings}
                  correlationNotice={correlationNotice}
                  windowStartIso={lastSearch.startIso}
                  windowEndIso={lastSearch.endIso}
                />
              )}

              {/* Cursor pager — "Page N" status left, Prev / Next right, on the
                  table's 20px edges (no totals exist for trace search; Next
                  disables when the server reports the window exhausted). Page 1
                  with nothing older: no pager. */}
              {showPager && (
                <nav className="dlx5-pager" aria-label="Trace result pages">
                  <span className="dlx5-pager-status">
                    <span className="dlx5-pg-cur">Page {page.toLocaleString()}</span>
                    {canNextPage && (
                      <span className="dlx5-pager-note">older traces exist in this window</span>
                    )}
                  </span>
                  <span className="dlx5-pager-btns">
                    <button
                      type="button"
                      className="dlx5-pgbtn"
                      aria-label="Previous page"
                      disabled={isLoading || page <= 1}
                      onClick={handlePrevPage}
                    >
                      Prev
                    </button>
                    <button
                      type="button"
                      className="dlx5-pgbtn"
                      aria-label="Next page (older traces)"
                      disabled={isLoading || !canNextPage}
                      onClick={handleNextPage}
                    >
                      Next
                    </button>
                  </span>
                </nav>
              )}
            </section>
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
