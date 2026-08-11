/**
 * TroubleshootingPage — platform SIP trace search backed by POST /homer/search.
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
 * One deliberate exception to daylight: the <SipLadder> visualization
 * (components/sip-ladder/*) is a dark-designed technical diagram and is NOT
 * converted. Expanded rows seat it inside a composed dark frame
 * (`.dlx5-ladderframe`) — a code-block-in-light-docs contrast, with a slim
 * header strip labeling the call and the per-call Grafana deep link.
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
import { SipLadder } from '../components/sip-ladder';
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns ISO 8601 string for a date offset by `offsetHours` from now. */
function isoOffset(offsetHours: number): string {
  const d = new Date(Date.now() + offsetHours * 60 * 60 * 1000);
  // datetime-local inputs need "YYYY-MM-DDTHH:MM" — drop seconds/tz
  return d.toISOString().slice(0, 16);
}

/** Strip leading + so Homer storage format matches. */
function stripPlus(value: string): string {
  return value.trim().replace(/^\+/, '');
}

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
      <p style={{ margin: 0, color: INK_DIM, fontSize: '0.85rem', maxWidth: 340 }}>
        Search for SIP traces by phone number, Call-ID, or date range
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
  startTime: string;
  endTime: string;
}

function ResultsTable({ callGroups, correlations, pipelineWarnings, startTime, endTime }: ResultsTableProps) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem', color: INK_SOFT }}>
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
            <th className="dl-th" style={{ padding: '10px 16px 10px 8px', width: 30 }} aria-label="Expand" />
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
              // Fallback: use the search form's time range
              fromMs = Math.floor(new Date(startTime).getTime());
              toMs = Math.floor(new Date(endTime).getTime());
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

                  {/* Expand chevron */}
                  <td style={{ padding: '9px 16px 9px 8px', textAlign: 'right' }}>
                    <span className="dlx5-chevron" aria-hidden="true">
                      <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </span>
                  </td>
                </tr>

                {isExpanded && (
                  <tr>
                    <td colSpan={10} className="dlx5-expand-cell">
                      {/* Composed dark technical frame — the ladder keeps its
                          dark design; everything around it is daylight. */}
                      <div className="dlx5-ladderframe">
                        <div className="dlx5-ladderframe-head">
                          <span className="dlx5-ladderframe-title">Signaling Ladder</span>
                          <span className="dlx5-ladderframe-route">
                            {displayUser(row.from_user)} → {displayUser(row.to_user)} · {group.callIds.length}{' '}
                            {group.callIds.length === 1 ? 'leg' : 'legs'}
                          </span>
                          <a
                            className="dlx5-ghost-dark"
                            href={grafanaLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <ExternalIcon size={11} />
                            Open in Grafana
                          </a>
                        </div>
                        <div className="dlx5-ladderframe-body">
                          <SipLadder
                            messages={group.messages}
                            correlations={correlations}
                            pipelineWarnings={pipelineWarnings}
                          />
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

export function TroubleshootingPage() {
  // ── All hooks unconditionally at the top (React rules of hooks) ──
  const [fromUser, setFromUser] = useState('');
  const [toUser, setToUser] = useState('');
  const [callId, setCallId] = useState('');
  const [startTime, setStartTime] = useState(() => isoOffset(-24));
  const [endTime, setEndTime] = useState(() => isoOffset(0));
  const [validationError, setValidationError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  // Shared desktop sidebar collapse — same localStorage key as AppLayout, so
  // the state carries across navigation between shells.
  const { collapsed, toggleCollapsed } = useSidebarCollapse();

  const searchMutation = useMutation({
    mutationFn: (params: HomerSearchParams) => searchSipTraces(params),
  });

  const handleSearch = useCallback(() => {
    // Validation: at least one of From, To, or Call-ID must be filled
    if (!fromUser.trim() && !toUser.trim() && !callId.trim()) {
      setValidationError('Enter at least one of From, To, or Call-ID to search.');
      return;
    }
    setValidationError(null);
    setHasSearched(true);

    const params: HomerSearchParams = {
      start_time: new Date(startTime).toISOString(),
      end_time: new Date(endTime).toISOString(),
    };

    if (fromUser.trim()) params.from_user = stripPlus(fromUser);
    if (toUser.trim()) params.to_user = stripPlus(toUser);
    if (callId.trim()) params.call_id = callId.trim();

    searchMutation.mutate(params);
  }, [fromUser, toUser, callId, startTime, endTime, searchMutation]);

  const handleClear = useCallback(() => {
    setFromUser('');
    setToUser('');
    setCallId('');
    setStartTime(isoOffset(-24));
    setEndTime(isoOffset(0));
    setValidationError(null);
    setHasSearched(false);
    searchMutation.reset();
  }, [searchMutation]);

  // Submit on Enter from any input field
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') handleSearch();
    },
    [handleSearch],
  );

  // ── Memoised call grouping (hook — must stay above early returns) ──
  const results = searchMutation.data?.data ?? [];
  const correlations = searchMutation.data?.correlations ?? {};
  const pipelineWarnings = searchMutation.data?.pipeline_warnings ?? [];

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
                Search SIP traces by phone number, Call-ID, or date range — expand a call to read its full signaling ladder.
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
                <span className="dl-panel-title">Search Criteria</span>
                <span className="dl-panel-sub">
                  At least one of From, To, or Call-ID is required.
                </span>
              </div>
              <div className="dl-panel-body">
                <div className="dlx5-form-grid">
                  <div>
                    <label className="dl-flabel" htmlFor="sip-from">From</label>
                    <input
                      id="sip-from"
                      type="text"
                      value={fromUser}
                      onChange={(e) => setFromUser(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="Caller number or SIP user"
                      className="dl-input"
                      style={{ width: '100%' }}
                    />
                  </div>

                  <div>
                    <label className="dl-flabel" htmlFor="sip-to">To</label>
                    <input
                      id="sip-to"
                      type="text"
                      value={toUser}
                      onChange={(e) => setToUser(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="Destination number"
                      className="dl-input"
                      style={{ width: '100%' }}
                    />
                  </div>

                  <div>
                    <label className="dl-flabel" htmlFor="sip-callid">Call-ID</label>
                    <input
                      id="sip-callid"
                      type="text"
                      value={callId}
                      onChange={(e) => setCallId(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="SIP Call-ID"
                      className="dl-input dl-input-mono"
                      style={{ width: '100%', fontSize: '0.8rem' }}
                    />
                  </div>
                </div>

                <div className="dlx5-form-grid2">
                  <div>
                    <label className="dl-flabel" htmlFor="sip-start">Date Range — From</label>
                    <input
                      id="sip-start"
                      type="datetime-local"
                      value={startTime}
                      onChange={(e) => setStartTime(e.target.value)}
                      className="dl-input"
                      style={{ width: '100%', colorScheme: 'light' }}
                    />
                  </div>

                  <div>
                    <label className="dl-flabel" htmlFor="sip-end">Date Range — To</label>
                    <input
                      id="sip-end"
                      type="datetime-local"
                      value={endTime}
                      onChange={(e) => setEndTime(e.target.value)}
                      className="dl-input"
                      style={{ width: '100%', colorScheme: 'light' }}
                    />
                  </div>
                </div>

                {validationError && (
                  <p className="dlx5-invalid" role="alert">
                    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <circle cx={12} cy={12} r={10} />
                      <line x1={12} y1={8} x2={12} y2={12} />
                      <line x1={12} y1={16} x2="12.01" y2={16} />
                    </svg>
                    {validationError}
                  </p>
                )}

                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="dl-btn dl-btn-primary"
                    onClick={handleSearch}
                    disabled={isLoading}
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
                    No SIP traces found for your search criteria. Widen the date range or loosen the number match.
                  </div>
                </div>
              )}

              {!isLoading && !isError && callGroups.length > 0 && (
                <ResultsTable
                  callGroups={callGroups}
                  correlations={correlations}
                  pipelineWarnings={pipelineWarnings}
                  startTime={startTime}
                  endTime={endTime}
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
