import { useState, useCallback, type KeyboardEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Sidebar } from '../components/layout/Sidebar';
import { Spinner } from '../components/ui/Spinner';
import { searchSipTraces } from '../api/homer';
import type { HomerSearchParams, HomerSearchResult } from '../api/homer';
import { fmt } from '../utils/format';

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

/** Format an ISO date string to a readable local datetime. */
function fmtDateTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

// ─── Method badge ─────────────────────────────────────────────────────────────

interface MethodBadgeProps {
  method: string;
}

function MethodBadge({ method }: MethodBadgeProps) {
  const upper = method.toUpperCase();

  let bg = 'rgba(71,85,105,0.5)';
  let color = '#94a3b8';
  let border = 'rgba(71,85,105,0.4)';

  if (upper === 'INVITE') {
    bg = 'rgba(34,197,94,0.15)';
    color = '#4ade80';
    border = 'rgba(34,197,94,0.3)';
  } else if (upper === 'BYE') {
    bg = 'rgba(245,158,11,0.15)';
    color = '#fbbf24';
    border = 'rgba(245,158,11,0.3)';
  } else if (upper === 'REGISTER') {
    bg = 'rgba(59,130,246,0.15)';
    color = '#60a5fa';
    border = 'rgba(59,130,246,0.3)';
  } else if (upper === 'CANCEL') {
    bg = 'rgba(239,68,68,0.15)';
    color = '#f87171';
    border = 'rgba(239,68,68,0.3)';
  } else if (upper === 'OPTIONS') {
    bg = 'rgba(168,85,247,0.15)';
    color = '#c084fc';
    border = 'rgba(168,85,247,0.3)';
  } else if (upper === 'ACK' || upper === 'PRACK') {
    bg = 'rgba(6,182,212,0.15)';
    color = '#22d3ee';
    border = 'rgba(6,182,212,0.3)';
  }

  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: '0.7rem',
        fontWeight: 600,
        letterSpacing: '0.04em',
        background: bg,
        color,
        border: `1px solid ${border}`,
        fontFamily: 'ui-monospace, monospace',
      }}
    >
      {upper}
    </span>
  );
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
          fontFamily: 'ui-monospace, monospace',
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
        fontFamily: 'ui-monospace, monospace',
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

// ─── Results table ────────────────────────────────────────────────────────────

interface ResultsTableProps {
  results: HomerSearchResult[];
}

function ResultsTable({ results }: ResultsTableProps) {
  const thStyle: React.CSSProperties = {
    padding: '10px 14px',
    textAlign: 'left',
    fontSize: '0.7rem',
    fontWeight: 600,
    letterSpacing: '0.08em',
    color: '#475569',
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
    borderBottom: '1px solid rgba(42,47,69,0.6)',
    background: 'rgba(15,17,23,0.5)',
  };

  const tdStyle: React.CSSProperties = {
    padding: '10px 14px',
    fontSize: '0.82rem',
    color: '#e2e8f0',
    borderBottom: '1px solid rgba(42,47,69,0.4)',
    verticalAlign: 'middle',
  };

  const monoStyle: React.CSSProperties = {
    fontFamily: 'ui-monospace, monospace',
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
            <th style={thStyle}>Method</th>
            <th style={thStyle}>Source IP</th>
            <th style={thStyle}>Dest IP</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Node</th>
          </tr>
        </thead>
        <tbody>
          {results.map((row, idx) => {
            // Build Grafana deep-link with the Call-ID variable pre-filled.
            // The dashboard UID and variable name match the dashboard JSON from Phase 1.
            // Use Grafana directly on port 3000 to avoid nginx sub-path redirect issues
            const grafanaLink = `${window.location.protocol}//${window.location.hostname}:3000/grafana/d/sip-search/sip-search?var-callid=${encodeURIComponent(row.callid)}`;

            return (
              <tr
                key={`${row.callid}-${row.timestamp}-${idx}`}
                onClick={() => window.open(grafanaLink, '_blank', 'noopener,noreferrer')}
                style={{ cursor: 'pointer', transition: 'background 0.15s' }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLTableRowElement).style.background =
                    'rgba(59,130,246,0.06)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLTableRowElement).style.background = '';
                }}
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
                  title={row.callid}
                >
                  {row.callid}
                </td>
                <td style={tdStyle}>
                  <MethodBadge method={row.method} />
                </td>
                <td style={{ ...tdStyle, ...monoStyle }}>{row.src_ip}</td>
                <td style={{ ...tdStyle, ...monoStyle }}>{row.dst_ip}</td>
                <td style={tdStyle}>
                  <StatusBadge status={row.status} />
                </td>
                <td style={{ ...tdStyle, ...monoStyle, color: '#64748b' }}>
                  {row.node ?? '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Input styling helper ─────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(42,47,69,0.8)',
  borderRadius: 8,
  color: '#e2e8f0',
  fontSize: '0.875rem',
  outline: 'none',
  boxSizing: 'border-box',
  transition: 'border-color 0.15s',
};

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

  // ── Derived values (after all hooks) ──
  const results = searchMutation.data?.data ?? [];
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
          style={{
            background: 'linear-gradient(135deg, rgba(26,29,39,0.95) 0%, rgba(19,21,29,0.9) 100%)',
            border: '1px solid rgba(42,47,69,0.6)',
            borderRadius: 16,
            padding: '24px 28px',
            marginBottom: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            backdropFilter: 'blur(12px)',
            boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
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
          style={{
            background: 'linear-gradient(135deg, rgba(26,29,39,0.95) 0%, rgba(19,21,29,0.9) 100%)',
            border: '1px solid rgba(42,47,69,0.6)',
            borderRadius: 16,
            padding: '24px 28px',
            marginBottom: 24,
            backdropFilter: 'blur(12px)',
            boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
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
                style={inputStyle}
                onFocus={(e) => {
                  (e.target as HTMLInputElement).style.borderColor = 'rgba(59,130,246,0.6)';
                }}
                onBlur={(e) => {
                  (e.target as HTMLInputElement).style.borderColor = 'rgba(42,47,69,0.8)';
                }}
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
                style={inputStyle}
                onFocus={(e) => {
                  (e.target as HTMLInputElement).style.borderColor = 'rgba(59,130,246,0.6)';
                }}
                onBlur={(e) => {
                  (e.target as HTMLInputElement).style.borderColor = 'rgba(42,47,69,0.8)';
                }}
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
                style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem' }}
                onFocus={(e) => {
                  (e.target as HTMLInputElement).style.borderColor = 'rgba(59,130,246,0.6)';
                }}
                onBlur={(e) => {
                  (e.target as HTMLInputElement).style.borderColor = 'rgba(42,47,69,0.8)';
                }}
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
                style={{ ...inputStyle, colorScheme: 'dark' }}
                onFocus={(e) => {
                  (e.target as HTMLInputElement).style.borderColor = 'rgba(59,130,246,0.6)';
                }}
                onBlur={(e) => {
                  (e.target as HTMLInputElement).style.borderColor = 'rgba(42,47,69,0.8)';
                }}
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
                style={{ ...inputStyle, colorScheme: 'dark' }}
                onFocus={(e) => {
                  (e.target as HTMLInputElement).style.borderColor = 'rgba(59,130,246,0.6)';
                }}
                onBlur={(e) => {
                  (e.target as HTMLInputElement).style.borderColor = 'rgba(42,47,69,0.8)';
                }}
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
                border: '1px solid rgba(34,197,94,0.4)',
                background: isLoading
                  ? 'rgba(34,197,94,0.08)'
                  : 'linear-gradient(135deg, rgba(34,197,94,0.2) 0%, rgba(22,163,74,0.15) 100%)',
                color: '#4ade80',
                fontSize: '0.875rem',
                fontWeight: 600,
                cursor: isLoading ? 'not-allowed' : 'pointer',
                opacity: isLoading ? 0.65 : 1,
                transition: 'background 0.15s, border-color 0.15s',
                boxShadow: isLoading ? 'none' : '0 0 12px rgba(34,197,94,0.15)',
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
          style={{
            background: 'linear-gradient(135deg, rgba(26,29,39,0.95) 0%, rgba(19,21,29,0.9) 100%)',
            border: '1px solid rgba(42,47,69,0.6)',
            borderRadius: 16,
            backdropFilter: 'blur(12px)',
            boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
            overflow: 'hidden',
          }}
        >
          {/* Results header */}
          <div
            style={{
              padding: '16px 24px',
              borderBottom: '1px solid rgba(42,47,69,0.6)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#64748b', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              Results
            </span>
            {hasSearched && !isLoading && !isError && (
              <span style={{ fontSize: '0.78rem', color: '#475569' }}>
                {results.length} {results.length === 1 ? 'trace' : 'traces'} found
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

          {!isLoading && !isError && results.length > 0 && (
            <ResultsTable results={results} />
          )}
        </div>
      </div>
    </div>
  );
}
