import React, { useState, useCallback, useMemo, type KeyboardEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Sidebar } from '../components/layout/Sidebar';
import { Spinner } from '../components/ui/Spinner';
import { searchSipTraces } from '../api/homer';
import type { HomerSearchParams, HomerSearchResult } from '../api/homer';
import { fmt } from '../utils/format';
import { SipLadder } from '../components/sip-ladder';
import type { MessageAttestation } from '../types/stir';
import {
  attestColor,
  attestLabel,
  attestDescription,
  verstatVerdict,
} from '../components/stir/attestationColors';

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

/** Format an ISO date string to a readable local datetime with microsecond precision.
 *  JavaScript Date only has millisecond precision, so we extract the fractional
 *  seconds directly from the ISO string (e.g. "2026-05-20T06:44:42.123456Z"). */
function fmtDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    const base = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).format(d);
    // Extract fractional seconds from the ISO string directly (up to 6 digits)
    // since Date.getMilliseconds() truncates to 3 digits
    const fracMatch = iso.match(/\.(\d+)Z?$/);
    const frac = fracMatch ? fracMatch[1].padEnd(6, '0').slice(0, 6) : '000000';
    const dotFrac = '.' + frac;
    return base.replace(/(\d{2})\s*(AM|PM)/i, `$1${dotFrac} $2`);
  } catch {
    return iso;
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

// ─── Status badge ─────────────────────────────────────────────────────────────

interface StatusBadgeProps {
  status: number | null;
}

function StatusBadge({ status }: StatusBadgeProps) {
  let bg: string;
  let color: string;
  let border: string;

  if (status === null) {
    bg = 'rgba(71,85,105,0.5)';
    color = '#94a3b8';
    border = 'rgba(71,85,105,0.4)';
    return (
      <span
        style={{
          display: 'inline-block',
          padding: '2px 8px',
          borderRadius: 4,
          fontSize: '0.7rem',
          fontWeight: 600,
          fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
          background: bg,
          color,
          border: `1px solid ${border}`,
        }}
      >
        —
      </span>
    );
  }

  if (status >= 200 && status < 300) {
    bg = 'rgba(34,197,94,0.15)';
    color = '#4ade80';
    border = 'rgba(34,197,94,0.3)';
  } else if (status >= 400 && status < 500) {
    bg = 'rgba(245,158,11,0.15)';
    color = '#fbbf24';
    border = 'rgba(245,158,11,0.3)';
  } else if (status >= 500) {
    bg = 'rgba(239,68,68,0.15)';
    color = '#f87171';
    border = 'rgba(239,68,68,0.3)';
  } else if (status >= 100 && status < 200) {
    bg = 'rgba(59,130,246,0.15)';
    color = '#60a5fa';
    border = 'rgba(59,130,246,0.3)';
  } else {
    bg = 'rgba(71,85,105,0.5)';
    color = '#94a3b8';
    border = 'rgba(71,85,105,0.4)';
  }

  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: '0.7rem',
        fontWeight: 600,
        fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
        background: bg,
        color,
        border: `1px solid ${border}`,
      }}
    >
      {status}
    </span>
  );
}

// ─── Empty / loading / error states ──────────────────────────────────────────

function EmptyState() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '64px 32px',
        gap: 16,
      }}
    >
      {/* Network / signal icon built from SVG */}
      <svg
        width={48}
        height={48}
        viewBox="0 0 24 24"
        fill="none"
        stroke="rgba(59,130,246,0.4)"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 12.55a11 11 0 0 1 14.08 0" />
        <path d="M1.42 9a16 16 0 0 1 21.16 0" />
        <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
        <circle cx={12} cy={20} r={1} fill="rgba(59,130,246,0.4)" stroke="none" />
      </svg>
      <p style={{ color: '#475569', fontSize: '0.9rem', textAlign: 'center', maxWidth: 340 }}>
        Search for SIP traces by phone number, Call-ID, or date range
      </p>
    </div>
  );
}

function NoResultsState() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '64px 32px',
        gap: 12,
      }}
    >
      <svg
        width={36}
        height={36}
        viewBox="0 0 24 24"
        fill="none"
        stroke="#475569"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx={11} cy={11} r={8} />
        <path d="m21 21-4.35-4.35" />
        <path d="M8 11h6" />
      </svg>
      <p style={{ color: '#475569', fontSize: '0.875rem' }}>
        No SIP traces found for your search criteria
      </p>
    </div>
  );
}

// ─── Message count badge ─────────────────────────────────────────────────────

interface MsgCountBadgeProps {
  count: number;
}

function MsgCountBadge({ count }: MsgCountBadgeProps) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 10,
        fontSize: '0.7rem',
        fontWeight: 600,
        fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
        background: 'rgba(59,130,246,0.12)',
        color: '#60a5fa',
        border: '1px solid rgba(59,130,246,0.25)',
        whiteSpace: 'nowrap',
      }}
    >
      {count} msg{count !== 1 ? 's' : ''}
    </span>
  );
}

// ─── Duration badge ──────────────────────────────────────────────────────────

interface DurationBadgeProps {
  seconds: number | null;
}

function DurationBadge({ seconds }: DurationBadgeProps) {
  if (seconds === null) {
    return (
      <span
        style={{
          fontSize: '0.78rem',
          fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
          color: '#475569',
        }}
      >
        —
      </span>
    );
  }

  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: '0.7rem',
        fontWeight: 600,
        fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
        background: 'rgba(168,85,247,0.12)',
        color: '#c084fc',
        border: '1px solid rgba(168,85,247,0.25)',
        whiteSpace: 'nowrap',
      }}
    >
      {fmtCallDuration(seconds)}
    </span>
  );
}

// ─── Attestation badge ───────────────────────────────────────────────────────

interface AttestationBadgeProps {
  attestation: MessageAttestation | null;
}

/**
 * Compact STIR/SHAKEN badge for a call row: the primary `signed_attestation`
 * (what WE emitted) as a small semantic-coloured pill (A=green, B=amber,
 * C=gray, div=blue — via the shared `attestationColors`). The full chain lives
 * in the call-detail/ladder view, so here we keep it to one pill and stash the
 * fuller story — caller attestation + verstat ✓/✗ + source — in the `title`.
 *
 * `null` (no stored attestation: legacy / pre-deploy / signing-off) renders a
 * subtle muted "—", never an error.
 */
function AttestationBadge({ attestation }: AttestationBadgeProps) {
  if (attestation === null) {
    return (
      <span
        title="No STIR/SHAKEN attestation on record for this call (legacy, unsigned, or pre-deploy)."
        style={{
          fontSize: '0.78rem',
          fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
          color: '#475569',
        }}
      >
        —
      </span>
    );
  }

  const signedToken = attestColor(attestation.signed_attestation);

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

  return (
    <span
      title={title}
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: '0.7rem',
        fontWeight: 700,
        fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
        background: signedToken.bg,
        color: signedToken.text,
        border: `1px solid ${signedToken.border}`,
        whiteSpace: 'nowrap',
      }}
    >
      {attestLabel(attestation.signed_attestation)}
    </span>
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
  const thStyle: React.CSSProperties = {
    padding: '11px 14px',
    textAlign: 'left',
    fontSize: '0.7rem',
    fontWeight: 700,
    letterSpacing: '0.05em',
    color: '#475569',
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
    background: 'rgba(59,130,246,0.035)',
    boxShadow: 'inset 0 -1px 0 0 rgba(59,130,246,0.12)',
  };

  const tdStyle: React.CSSProperties = {
    padding: '10px 14px',
    fontSize: '0.82rem',
    color: '#e2e8f0',
    verticalAlign: 'middle',
  };

  const monoStyle: React.CSSProperties = {
    fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: '0.78rem',
    color: '#94a3b8',
  };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={thStyle}>Time</th>
            <th style={thStyle}>From</th>
            <th style={thStyle}>To</th>
            <th style={thStyle}>Call-ID</th>
            <th style={thStyle}>Source</th>
            <th style={thStyle}>Dest</th>
            <th style={thStyle}>Result</th>
            <th style={thStyle}>Attestation</th>
            <th style={thStyle}>Duration</th>
            <th style={thStyle}>Messages</th>
            <th style={thStyle}>Node</th>
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

            return (
              <React.Fragment key={`${row.callid}-${idx}`}>
              <tr
                className={isExpanded ? undefined : 'glass-row-hover'}
                onClick={() => setExpandedIdx(isExpanded ? null : idx)}
                style={{
                  cursor: 'pointer',
                  transition: 'background 0.15s',
                  background: isExpanded ? 'rgba(59,130,246,0.08)' : undefined,
                }}
                title="Click to expand SIP ladder"
              >
                <td style={{ ...tdStyle, ...monoStyle, whiteSpace: 'nowrap' }}>
                  {fmtDateTime(row.timestamp)}
                </td>
                <td style={tdStyle}>{displayUser(row.from_user)}</td>
                <td style={tdStyle}>{displayUser(row.to_user)}</td>
                <td
                  style={{
                    ...tdStyle,
                    ...monoStyle,
                    maxWidth: 220,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={group.callIds.join('\n')}
                >
                  {row.callid}
                </td>
                <td style={{ ...tdStyle, ...monoStyle }}>{row.src_ip}</td>
                <td style={{ ...tdStyle, ...monoStyle }}>{row.dst_ip}</td>
                <td style={tdStyle}>
                  <StatusBadge status={group.finalStatus} />
                </td>
                <td style={tdStyle}>
                  <AttestationBadge attestation={group.attestation} />
                </td>
                <td style={tdStyle}>
                  <DurationBadge seconds={group.durationSec} />
                </td>
                <td style={tdStyle}>
                  <MsgCountBadge count={group.messages.length} />
                </td>
                <td style={{ ...tdStyle, ...monoStyle, color: '#64748b' }}>
                  {row.node ?? '—'}
                </td>
              </tr>
              {isExpanded && (
                <tr>
                  <td colSpan={11} style={{ padding: 0, border: 'none' }}>
                    <div style={{ padding: '0 8px 16px' }}>
                      {/* Secondary action: open in Grafana */}
                      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 8px 0' }}>
                        <a
                          href={grafanaLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 5,
                            padding: '4px 10px',
                            borderRadius: 6,
                            border: '1px solid rgba(59,130,246,0.25)',
                            background: 'rgba(59,130,246,0.06)',
                            color: '#60a5fa',
                            fontSize: '0.72rem',
                            fontWeight: 500,
                            textDecoration: 'none',
                            transition: 'background 0.15s',
                          }}
                        >
                          <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                            <polyline points="15 3 21 3 21 9" />
                            <line x1="10" y1="14" x2="21" y2="3" />
                          </svg>
                          Open in Grafana
                        </a>
                      </div>
                      <SipLadder
                        messages={group.messages}
                        correlations={correlations}
                        pipelineWarnings={pipelineWarnings}
                      />
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

// ─── Input styling helper ─────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.72rem',
  fontWeight: 600,
  letterSpacing: '0.06em',
  color: '#64748b',
  textTransform: 'uppercase',
  marginBottom: 6,
};

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
    <div className="min-h-screen bg-[#0f1117]">
      <Sidebar />

      <div
        style={{
          marginLeft: 240,
          minHeight: '100vh',
          padding: '32px 40px',
          boxSizing: 'border-box',
        }}
      >
        {/* ── Page header ────────────────────────────────────────────── */}
        <div
          className="glass-header"
          style={{
            padding: '24px 28px',
            marginBottom: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, position: 'relative', zIndex: 1 }}>
            {/* Blue accent bar */}
            <div
              style={{
                width: 4,
                height: 40,
                borderRadius: 2,
                background: 'linear-gradient(180deg, #3b82f6 0%, #2563eb 100%)',
                boxShadow: '0 0 12px rgba(59,130,246,0.5)',
                flexShrink: 0,
              }}
            />
            <div>
              <h1
                style={{
                  margin: 0,
                  fontSize: '1.25rem',
                  fontWeight: 700,
                  color: '#e2e8f0',
                  letterSpacing: '-0.01em',
                }}
              >
                SIP Trace Search
              </h1>
              <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: '#64748b' }}>
                Search SIP traces by phone number, Call-ID, or date range
              </p>
            </div>
          </div>

          {/* Open Grafana link */}
          <a
            href="/grafana/"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '7px 14px',
              borderRadius: 8,
              border: '1px solid rgba(59,130,246,0.35)',
              background: 'rgba(59,130,246,0.08)',
              color: '#60a5fa',
              fontSize: '0.8rem',
              fontWeight: 500,
              textDecoration: 'none',
              transition: 'background 0.15s, border-color 0.15s',
              whiteSpace: 'nowrap',
              flexShrink: 0,
              position: 'relative',
              zIndex: 1,
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget as HTMLAnchorElement;
              el.style.background = 'rgba(59,130,246,0.15)';
              el.style.borderColor = 'rgba(59,130,246,0.55)';
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget as HTMLAnchorElement;
              el.style.background = 'rgba(59,130,246,0.08)';
              el.style.borderColor = 'rgba(59,130,246,0.35)';
            }}
          >
            <svg
              width={14}
              height={14}
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
            Open SIP Dashboard
          </a>
        </div>

        {/* ── Search form ────────────────────────────────────────────── */}
        <div
          className="glass-surface glass-hover"
          style={{
            padding: '24px 28px',
            marginBottom: 24,
          }}
        >
          {/* Row 1: From, To, Call-ID */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1fr',
              gap: 16,
              marginBottom: 16,
            }}
          >
            <div>
              <label htmlFor="sip-from" style={labelStyle}>
                From
              </label>
              <input
                id="sip-from"
                type="text"
                value={fromUser}
                onChange={(e) => setFromUser(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Caller number or SIP user"
                className="form-control"
              />
            </div>

            <div>
              <label htmlFor="sip-to" style={labelStyle}>
                To
              </label>
              <input
                id="sip-to"
                type="text"
                value={toUser}
                onChange={(e) => setToUser(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Destination number"
                className="form-control"
              />
            </div>

            <div>
              <label htmlFor="sip-callid" style={labelStyle}>
                Call-ID
              </label>
              <input
                id="sip-callid"
                type="text"
                value={callId}
                onChange={(e) => setCallId(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="SIP Call-ID"
                className="form-control"
                style={{ fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace', fontSize: '0.8rem' }}
              />
            </div>
          </div>

          {/* Row 2: Date range */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 16,
              marginBottom: 20,
            }}
          >
            <div>
              <label htmlFor="sip-start" style={labelStyle}>
                Date Range — From
              </label>
              <input
                id="sip-start"
                type="datetime-local"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="form-control"
                style={{ colorScheme: 'dark' }}
              />
            </div>

            <div>
              <label htmlFor="sip-end" style={labelStyle}>
                Date Range — To
              </label>
              <input
                id="sip-end"
                type="datetime-local"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="form-control"
                style={{ colorScheme: 'dark' }}
              />
            </div>
          </div>

          {/* Validation error */}
          {validationError && (
            <p
              style={{
                margin: '0 0 14px',
                fontSize: '0.8rem',
                color: '#f87171',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <svg
                width={14}
                height={14}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx={12} cy={12} r={10} />
                <line x1={12} y1={8} x2={12} y2={12} />
                <line x1={12} y1={16} x2="12.01" y2={16} />
              </svg>
              {validationError}
            </p>
          )}

          {/* Buttons */}
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type="button"
              onClick={handleSearch}
              disabled={isLoading}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                padding: '9px 20px',
                borderRadius: 8,
                border: '1px solid rgba(59,130,246,0.4)',
                background: isLoading
                  ? 'rgba(59,130,246,0.08)'
                  : 'linear-gradient(135deg, rgba(59,130,246,0.24) 0%, rgba(37,99,235,0.18) 100%)',
                color: '#93c5fd',
                fontSize: '0.875rem',
                fontWeight: 600,
                cursor: isLoading ? 'not-allowed' : 'pointer',
                opacity: isLoading ? 0.65 : 1,
                transition: 'background 0.15s, border-color 0.15s',
                boxShadow: isLoading ? 'none' : '0 0 12px rgba(59,130,246,0.18)',
              }}
            >
              {isLoading ? (
                <Spinner />
              ) : (
                <svg
                  width={15}
                  height={15}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx={11} cy={11} r={8} />
                  <path d="m21 21-4.35-4.35" />
                </svg>
              )}
              {isLoading ? 'Searching…' : 'Search'}
            </button>

            <button
              type="button"
              onClick={handleClear}
              disabled={isLoading}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                padding: '9px 16px',
                borderRadius: 8,
                border: '1px solid rgba(42,47,69,0.8)',
                background: 'transparent',
                color: '#64748b',
                fontSize: '0.875rem',
                fontWeight: 500,
                cursor: isLoading ? 'not-allowed' : 'pointer',
                transition: 'color 0.15s, border-color 0.15s',
              }}
              onMouseEnter={(e) => {
                const el = e.currentTarget as HTMLButtonElement;
                el.style.color = '#94a3b8';
                el.style.borderColor = 'rgba(71,85,105,0.8)';
              }}
              onMouseLeave={(e) => {
                const el = e.currentTarget as HTMLButtonElement;
                el.style.color = '#64748b';
                el.style.borderColor = 'rgba(42,47,69,0.8)';
              }}
            >
              Clear
            </button>
          </div>
        </div>

        {/* ── Results area ───────────────────────────────────────────── */}
        <div
          className="glass-surface"
          style={{
            overflow: 'hidden',
          }}
        >
          {/* Results header */}
          <div
            style={{
              padding: '16px 24px',
              borderBottom: '1px solid rgba(59,130,246,0.1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#64748b' }}>
              Results
            </span>
            {hasSearched && !isLoading && !isError && (
              <span style={{ fontSize: '0.78rem', color: '#475569' }}>
                {totalCalls} {totalCalls === 1 ? 'call' : 'calls'} found ({totalMessages} total messages)
              </span>
            )}
          </div>

          {/* Content */}
          {isLoading && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '64px 32px',
                gap: 12,
                color: '#64748b',
                fontSize: '0.875rem',
              }}
            >
              <Spinner />
              Searching SIP traces…
            </div>
          )}

          {isError && !isLoading && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '48px 32px',
                gap: 10,
                color: '#f87171',
                fontSize: '0.875rem',
              }}
            >
              <svg
                width={16}
                height={16}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx={12} cy={12} r={10} />
                <line x1={12} y1={8} x2={12} y2={12} />
                <line x1={12} y1={16} x2="12.01" y2={16} />
              </svg>
              {errorMessage ?? 'Search failed. Is the Homer backend reachable?'}
            </div>
          )}

          {!isLoading && !isError && !hasSearched && <EmptyState />}

          {!isLoading && !isError && hasSearched && results.length === 0 && (
            <NoResultsState />
          )}

          {!isLoading && !isError && callGroups.length > 0 && (
            <ResultsTable callGroups={callGroups} correlations={correlations} pipelineWarnings={pipelineWarnings} startTime={startTime} endTime={endTime} />
          )}
        </div>
      </div>
    </div>
  );
}
