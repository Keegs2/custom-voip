import { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../../api/client';
import { Badge } from '../../components/ui/Badge';
import { Spinner } from '../../components/ui/Spinner';
import { fmt, fmtDuration } from '../../utils/format';

// ─── Types ──────────────────────────────────────────────────────────────────

type DIDProduct = 'rcf' | 'api' | 'trunk' | 'ucaas';

interface DIDResult {
  did: string;
  product: DIDProduct;
  customer_id: number;
  customer_name: string;
  status: 'active' | 'disabled' | 'suspended';
  details: Record<string, string | number | boolean | null>;
}

interface DIDSearchResponse {
  results: DIDResult[];
  total: number;
}

type CallDirection = 'inbound' | 'outbound';
type CallResult = 'answered' | 'failed' | 'busy' | 'no-answer' | 'cancelled';

interface CallRecord {
  id: string;
  direction: CallDirection;
  caller: string;
  callee: string;
  duration: number;
  result: CallResult;
  timestamp: string;
}

interface CallHistoryResponse {
  calls: CallRecord[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const PAGE_SIZE = 25;

const PRODUCT_ACCENT: Record<DIDProduct, string> = {
  rcf:   '#22c55e',
  api:   '#a855f7',
  trunk: '#f59e0b',
  ucaas: '#0ea5e9',
};

const PRODUCT_BADGE_VARIANT: Record<DIDProduct, 'rcf' | 'api' | 'trunk' | 'ucaas'> = {
  rcf:   'rcf',
  api:   'api',
  trunk: 'trunk',
  ucaas: 'ucaas',
};

const PRODUCT_LABEL: Record<DIDProduct, string> = {
  rcf:   'RCF',
  api:   'API',
  trunk: 'Trunk',
  ucaas: 'UCaaS',
};

const CALL_RESULT_COLOR: Record<CallResult, string> = {
  answered:    '#22c55e',
  failed:      '#ef4444',
  busy:        '#f59e0b',
  'no-answer': '#64748b',
  cancelled:   '#64748b',
};

// ─── API functions ────────────────────────────────────────────────────────────

interface FetchDIDsParams {
  /** When provided, performs a filtered search. When absent, lists all DIDs. */
  q?: string;
  limit: number;
  offset: number;
}

async function fetchDIDs({ q, limit, offset }: FetchDIDsParams): Promise<DIDSearchResponse> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (q) params.set('q', q);
  return apiRequest<DIDSearchResponse>('GET', `/search/did?${params.toString()}`);
}

async function fetchDIDCalls(did: string): Promise<CallHistoryResponse> {
  return apiRequest<CallHistoryResponse>('GET', `/search/did/${encodeURIComponent(did)}/calls`);
}

// ─── Pagination control ───────────────────────────────────────────────────────

interface PaginationProps {
  currentPage: number; // 0-indexed
  totalPages: number;
  onPageChange: (page: number) => void;
  isFetching: boolean;
}

function Pagination({ currentPage, totalPages, onPageChange, isFetching }: PaginationProps) {
  if (totalPages <= 1) return null;

  // Build the window of page numbers to show: always show first, last, and up
  // to 2 siblings on either side of the current page, with ellipsis gaps.
  const pages: Array<number | 'ellipsis-start' | 'ellipsis-end'> = [];
  if (totalPages <= 7) {
    for (let i = 0; i < totalPages; i++) pages.push(i);
  } else {
    pages.push(0);
    if (currentPage > 3) pages.push('ellipsis-start');
    const rangeStart = Math.max(1, currentPage - 2);
    const rangeEnd = Math.min(totalPages - 2, currentPage + 2);
    for (let i = rangeStart; i <= rangeEnd; i++) pages.push(i);
    if (currentPage < totalPages - 4) pages.push('ellipsis-end');
    pages.push(totalPages - 1);
  }

  const btnBase: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 32,
    height: 32,
    padding: '0 8px',
    borderRadius: 8,
    border: '1px solid rgba(255,255,255,0.07)',
    background: 'rgba(255,255,255,0.03)',
    color: '#64748b',
    fontSize: '0.78rem',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'background 0.12s, color 0.12s, border-color 0.12s',
    lineHeight: 1,
    userSelect: 'none',
  };

  const btnActive: React.CSSProperties = {
    ...btnBase,
    background: 'rgba(59,130,246,0.18)',
    border: '1px solid rgba(59,130,246,0.4)',
    color: '#93c5fd',
    fontWeight: 700,
    cursor: 'default',
  };

  const btnDisabled: React.CSSProperties = {
    ...btnBase,
    opacity: 0.3,
    cursor: 'not-allowed',
    pointerEvents: 'none',
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px 20px',
        borderTop: '1px solid rgba(255,255,255,0.05)',
        background: 'rgba(0,0,0,0.08)',
      }}
    >
      {/* Left: page x of y */}
      <span style={{ fontSize: '0.72rem', color: '#475569', display: 'flex', alignItems: 'center', gap: 6 }}>
        Page {currentPage + 1} of {totalPages}
        {isFetching && <Spinner size="xs" />}
      </span>

      {/* Center: page buttons */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {/* Previous */}
        <button
          type="button"
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 0}
          style={currentPage === 0 ? btnDisabled : btnBase}
          onMouseEnter={(e) => { if (currentPage !== 0) { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.07)'; (e.currentTarget as HTMLButtonElement).style.color = '#94a3b8'; } }}
          onMouseLeave={(e) => { if (currentPage !== 0) { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.03)'; (e.currentTarget as HTMLButtonElement).style.color = '#64748b'; } }}
          aria-label="Previous page"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 12, height: 12 }}>
            <path d="M10 12L6 8l4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {pages.map((p, idx) => {
          if (p === 'ellipsis-start' || p === 'ellipsis-end') {
            return (
              <span key={p === 'ellipsis-start' ? 'es' : 'ee'} style={{ color: '#334155', fontSize: '0.78rem', padding: '0 2px', userSelect: 'none' }}>
                …
              </span>
            );
          }
          return (
            <button
              key={p}
              type="button"
              onClick={() => onPageChange(p)}
              disabled={p === currentPage}
              style={p === currentPage ? btnActive : btnBase}
              onMouseEnter={(e) => { if (p !== currentPage) { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.07)'; (e.currentTarget as HTMLButtonElement).style.color = '#94a3b8'; } }}
              onMouseLeave={(e) => { if (p !== currentPage) { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.03)'; (e.currentTarget as HTMLButtonElement).style.color = '#64748b'; } }}
              aria-label={`Page ${p + 1}`}
              aria-current={p === currentPage ? 'page' : undefined}
            >
              {p + 1}
            </button>
          );
        })}

        {/* Next */}
        <button
          type="button"
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage >= totalPages - 1}
          style={currentPage >= totalPages - 1 ? btnDisabled : btnBase}
          onMouseEnter={(e) => { if (currentPage < totalPages - 1) { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.07)'; (e.currentTarget as HTMLButtonElement).style.color = '#94a3b8'; } }}
          onMouseLeave={(e) => { if (currentPage < totalPages - 1) { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.03)'; (e.currentTarget as HTMLButtonElement).style.color = '#64748b'; } }}
          aria-label="Next page"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 12, height: 12 }}>
            <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* Right: intentionally empty for balance */}
      <span style={{ minWidth: 80 }} />
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface ProductDetailProps {
  product: DIDProduct;
  details: Record<string, string | number | boolean | null>;
}

function ProductDetail({ product, details }: ProductDetailProps) {
  const accent = PRODUCT_ACCENT[product];

  const renderField = (key: string, value: string | number | boolean | null) => {
    const label = key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const displayValue = value === null ? '—' : value === true ? 'Yes' : value === false ? 'No' : String(value);

    return (
      <div
        key={key}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          padding: '10px 14px',
          borderRadius: 8,
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid rgba(255,255,255,0.04)',
          minWidth: 0,
        }}
      >
        <div
          style={{
            fontSize: '0.6rem',
            fontWeight: 700,
            color: '#4a5568',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: '0.875rem',
            fontWeight: 600,
            color: accent,
            fontFamily: 'monospace',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {displayValue}
        </div>
      </div>
    );
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
        gap: 8,
        marginBottom: 20,
      }}
    >
      {Object.entries(details).map(([k, v]) => renderField(k, v))}
    </div>
  );
}

interface CallHistoryRowProps {
  call: CallRecord;
  isOdd: boolean;
}

function CallHistoryRow({ call, isOdd }: CallHistoryRowProps) {
  const resultColor = CALL_RESULT_COLOR[call.result] ?? '#64748b';
  const ts = new Date(call.timestamp);
  const timeStr = ts.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <tr
      style={{
        background: isOdd ? 'rgba(255,255,255,0.015)' : 'transparent',
      }}
    >
      {/* Direction */}
      <td style={{ padding: '8px 12px', width: 36 }}>
        <span
          title={call.direction}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            borderRadius: 6,
            background: call.direction === 'inbound'
              ? 'rgba(14,165,233,0.12)'
              : 'rgba(168,85,247,0.12)',
            color: call.direction === 'inbound' ? '#0ea5e9' : '#a855f7',
          }}
        >
          {call.direction === 'inbound' ? (
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 10, height: 10 }}>
              <path d="M14 2L2 14M2 14h8M2 14V6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 10, height: 10 }}>
              <path d="M2 14L14 2M14 2H6M14 2v8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
      </td>
      {/* Caller */}
      <td style={{ padding: '8px 12px', fontSize: '0.8rem', color: '#cbd5e0', fontFamily: 'monospace' }}>
        {fmt(call.caller)}
      </td>
      {/* Arrow */}
      <td style={{ padding: '8px 4px', color: '#334155', fontSize: '0.75rem' }}>→</td>
      {/* Callee */}
      <td style={{ padding: '8px 12px', fontSize: '0.8rem', color: '#cbd5e0', fontFamily: 'monospace' }}>
        {fmt(call.callee)}
      </td>
      {/* Duration */}
      <td style={{ padding: '8px 12px', fontSize: '0.78rem', color: '#64748b', textAlign: 'right', whiteSpace: 'nowrap' }}>
        {call.duration > 0 ? fmtDuration(call.duration) : '—'}
      </td>
      {/* Result */}
      <td style={{ padding: '8px 12px', textAlign: 'center' }}>
        <span
          style={{
            fontSize: '0.65rem',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            color: resultColor,
            background: `${resultColor}14`,
            border: `1px solid ${resultColor}28`,
            borderRadius: 4,
            padding: '2px 7px',
          }}
        >
          {call.result}
        </span>
      </td>
      {/* Time */}
      <td style={{ padding: '8px 12px', fontSize: '0.72rem', color: '#475569', whiteSpace: 'nowrap', textAlign: 'right' }}>
        {timeStr}
      </td>
    </tr>
  );
}

interface CallHistoryPanelProps {
  did: string;
}

function CallHistoryPanel({ did }: CallHistoryPanelProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['did-calls', did],
    queryFn: () => fetchDIDCalls(did),
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 0', color: '#64748b', fontSize: '0.82rem' }}>
        <Spinner size="sm" />
        <span>Loading call history…</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div
        style={{
          padding: '10px 14px',
          borderRadius: 8,
          background: 'rgba(239,68,68,0.06)',
          border: '1px solid rgba(239,68,68,0.15)',
          color: '#f87171',
          fontSize: '0.8rem',
        }}
      >
        Unable to load call history.
      </div>
    );
  }

  const calls = data?.calls ?? [];

  if (calls.length === 0) {
    return (
      <div style={{ color: '#4a5568', fontSize: '0.82rem', padding: '12px 0', fontStyle: 'italic' }}>
        No recent calls found for this DID.
      </div>
    );
  }

  return (
    <div
      style={{
        borderRadius: 10,
        border: '1px solid rgba(255,255,255,0.05)',
        overflow: 'hidden',
        background: 'rgba(0,0,0,0.2)',
      }}
    >
      <div
        style={{
          fontSize: '0.65rem',
          fontWeight: 700,
          color: '#334155',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          padding: '10px 12px 8px',
          borderBottom: '1px solid rgba(255,255,255,0.04)',
        }}
      >
        Recent Calls ({calls.length})
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {calls.map((call, i) => (
            <CallHistoryRow key={call.id} call={call} isOdd={i % 2 === 1} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ExpandedDetailPanelProps {
  result: DIDResult;
}

function ExpandedDetailPanel({ result }: ExpandedDetailPanelProps) {
  const accent = PRODUCT_ACCENT[result.product];

  return (
    <div
      style={{
        padding: '20px 24px',
        background: 'rgba(0,0,0,0.18)',
        borderTop: `1px solid ${accent}20`,
        borderBottom: '1px solid rgba(255,255,255,0.04)',
      }}
    >
      {/* Product config */}
      <div
        style={{
          fontSize: '0.65rem',
          fontWeight: 700,
          color: '#334155',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          marginBottom: 10,
        }}
      >
        {PRODUCT_LABEL[result.product]} Configuration
      </div>
      <ProductDetail product={result.product} details={result.details} />

      {/* Call history */}
      <div
        style={{
          fontSize: '0.65rem',
          fontWeight: 700,
          color: '#334155',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          marginBottom: 10,
        }}
      >
        Call History
      </div>
      <CallHistoryPanel did={result.did} />
    </div>
  );
}

interface ResultRowProps {
  result: DIDResult;
  isExpanded: boolean;
  onToggle: () => void;
}

function ResultRow({ result, isExpanded, onToggle }: ResultRowProps) {
  const accent = PRODUCT_ACCENT[result.product];

  return (
    <>
      <tr
        onClick={onToggle}
        style={{
          cursor: 'pointer',
          transition: 'background 0.12s',
          background: isExpanded
            ? `linear-gradient(90deg, ${accent}08 0%, transparent 60%)`
            : 'transparent',
          borderLeft: isExpanded ? `2px solid ${accent}60` : '2px solid transparent',
        }}
        onMouseEnter={(e) => {
          if (!isExpanded) {
            (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.025)';
          }
        }}
        onMouseLeave={(e) => {
          if (!isExpanded) {
            (e.currentTarget as HTMLTableRowElement).style.background = 'transparent';
          }
        }}
      >
        {/* DID */}
        <td style={{ padding: '14px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Expand chevron */}
            <span
              style={{
                color: '#334155',
                flexShrink: 0,
                transition: 'transform 0.15s',
                transform: isExpanded ? 'rotate(90deg)' : 'none',
                lineHeight: 1,
              }}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 12, height: 12 }}>
                <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div>
              <div
                style={{
                  fontSize: '0.9rem',
                  fontWeight: 700,
                  color: '#e2e8f0',
                  fontVariantNumeric: 'tabular-nums',
                  letterSpacing: '-0.01em',
                }}
              >
                {fmt(result.did)}
              </div>
              <div style={{ fontSize: '0.68rem', color: '#475569', fontFamily: 'monospace', marginTop: 2 }}>
                {result.did}
              </div>
            </div>
          </div>
        </td>

        {/* Product */}
        <td style={{ padding: '14px 16px' }}>
          <Badge variant={PRODUCT_BADGE_VARIANT[result.product]}>
            {PRODUCT_LABEL[result.product]}
          </Badge>
        </td>

        {/* Customer */}
        <td style={{ padding: '14px 16px' }}>
          <Link
            to={`/admin/customers/${result.customer_id}`}
            onClick={(e) => e.stopPropagation()}
            style={{
              color: '#60a5fa',
              textDecoration: 'none',
              fontSize: '0.85rem',
              fontWeight: 500,
              transition: 'color 0.1s',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = '#93c5fd'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = '#60a5fa'; }}
          >
            {result.customer_name}
          </Link>
          <div style={{ fontSize: '0.68rem', color: '#334155', marginTop: 1 }}>
            ID {result.customer_id}
          </div>
        </td>

        {/* Status */}
        <td style={{ padding: '14px 16px' }}>
          <Badge variant={result.status === 'active' ? 'active' : result.status === 'suspended' ? 'suspended' : 'disabled'}>
            {result.status}
          </Badge>
        </td>

        {/* Details summary */}
        <td style={{ padding: '14px 20px 14px 16px' }}>
          <div style={{ fontSize: '0.78rem', color: '#64748b', fontFamily: 'monospace' }}>
            {getDetailSummary(result.product, result.details)}
          </div>
        </td>
      </tr>

      {/* Expanded panel rendered as a full-width row */}
      {isExpanded && (
        <tr>
          <td colSpan={5} style={{ padding: 0 }}>
            <ExpandedDetailPanel result={result} />
          </td>
        </tr>
      )}
    </>
  );
}

/** Returns a one-line summary of the most important product detail */
function getDetailSummary(product: DIDProduct, details: Record<string, string | number | boolean | null>): string {
  switch (product) {
    case 'rcf':
      return details['forward_to'] ? `Fwd → ${details['forward_to']}` : '—';
    case 'api':
      return details['voice_url'] ? String(details['voice_url']).slice(0, 48) : '—';
    case 'trunk':
      return details['trunk_name'] ? String(details['trunk_name']) : '—';
    case 'ucaas':
      return details['extension'] ? `Ext ${details['extension']}` : '—';
    default:
      return '—';
  }
}

// ─── Results table ────────────────────────────────────────────────────────────

interface DIDTableProps {
  results: DIDResult[];
  total: number;
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  expandedDID: string | null;
  onToggleExpand: (did: string) => void;
  isFetching: boolean;
  /** Short label shown in the header alongside the count, e.g. "results" or "DIDs" */
  countLabel: string;
}

function DIDTable({
  results,
  total,
  currentPage,
  totalPages,
  onPageChange,
  expandedDID,
  onToggleExpand,
  isFetching,
  countLabel,
}: DIDTableProps) {
  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 14,
        overflow: 'hidden',
      }}
    >
      {/* Table header with result count */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 20px',
          borderBottom: '1px solid rgba(255,255,255,0.05)',
          background: 'rgba(0,0,0,0.1)',
        }}
      >
        <span style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 600 }}>
          {total === 1 ? `1 ${countLabel.replace(/s$/, '')}` : `${total.toLocaleString()} ${countLabel}`}
          {isFetching && (
            <span style={{ marginLeft: 8, opacity: 0.6 }}>
              <Spinner size="xs" />
            </span>
          )}
        </span>
        <span style={{ fontSize: '0.7rem', color: '#334155' }}>
          Click a row to expand details
        </span>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
            {['DID', 'Product', 'Customer', 'Status', 'Details'].map((col) => (
              <th
                key={col}
                style={{
                  padding: '10px 20px',
                  textAlign: 'left',
                  fontSize: '0.6rem',
                  fontWeight: 700,
                  color: '#334155',
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                  whiteSpace: 'nowrap',
                  background: 'rgba(0,0,0,0.06)',
                }}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {results.map((result) => (
            <ResultRow
              key={result.did}
              result={result}
              isExpanded={expandedDID === result.did}
              onToggle={() => onToggleExpand(result.did)}
            />
          ))}
        </tbody>
      </table>

      <Pagination
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={onPageChange}
        isFetching={isFetching}
      />
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function DIDSearchPage() {
  const [inputValue, setInputValue] = useState('');
  // The committed search query. Empty string = browse-all mode.
  const [query, setQuery] = useState('');
  const [expandedDID, setExpandedDID] = useState<string | null>(null);
  // Separate page cursors for browse and search modes so switching back keeps
  // the user on the same browse page they left.
  const [browsePage, setBrowsePage] = useState(0);
  const [searchPage, setSearchPage] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isSearching = query.length >= 4;
  const currentPage = isSearching ? searchPage : browsePage;

  const handleInputChange = useCallback((value: string) => {
    setInputValue(value);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    const digits = value.replace(/\D/g, '');
    if (digits.length >= 4) {
      debounceRef.current = setTimeout(() => {
        setQuery(value.trim());
        setSearchPage(0);   // reset search pagination on new query
        setExpandedDID(null);
      }, 300);
    } else {
      setQuery('');
      setExpandedDID(null);
    }
  }, []);

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  // Browse-all query — always enabled; fetches the current browse page.
  const browseQuery = useQuery({
    queryKey: ['did-browse', browsePage],
    queryFn: () => fetchDIDs({ limit: PAGE_SIZE, offset: browsePage * PAGE_SIZE }),
    staleTime: 30_000,
    // Keep previous page data visible while the next page loads
    placeholderData: (prev) => prev,
  });

  // Search query — only enabled when the user has typed enough digits.
  const searchQueryResult = useQuery({
    queryKey: ['did-search', query, searchPage],
    queryFn: () => fetchDIDs({ q: query, limit: PAGE_SIZE, offset: searchPage * PAGE_SIZE }),
    enabled: isSearching,
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });

  // Pick the active data source based on mode
  const activeQuery = isSearching ? searchQueryResult : browseQuery;
  const { data, isLoading, isError, isFetching } = activeQuery;

  const results = data?.results ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function handlePageChange(page: number) {
    setExpandedDID(null);
    if (isSearching) {
      setSearchPage(page);
    } else {
      setBrowsePage(page);
    }
  }

  function handleToggleExpand(did: string) {
    setExpandedDID((prev) => (prev === did ? null : did));
  }

  function handleClearSearch() {
    setInputValue('');
    setQuery('');
    setSearchPage(0);
    setExpandedDID(null);
  }

  return (
    <div style={{ paddingTop: 8 }}>
      {/* ── Page Header ─────────────────────────────────────────── */}
      <div
        style={{
          marginBottom: 32,
          paddingTop: 8,
          paddingBottom: 28,
          borderBottom: '1px solid rgba(42,47,69,0.6)',
          textAlign: 'center',
        }}
      >
        {/* Icon badge */}
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 14,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'linear-gradient(135deg, rgba(59,130,246,0.2) 0%, rgba(59,130,246,0.1) 100%)',
            border: '1px solid rgba(59,130,246,0.3)',
            color: '#60a5fa',
            marginBottom: 14,
          }}
          aria-hidden="true"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} style={{ width: 24, height: 24 }}>
            <path d="m21 21-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0Z" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M2.25 6.338c0 12.03 9.716 21.75 21.75 21.75" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        <h1
          style={{
            fontSize: '1.5rem',
            fontWeight: 800,
            letterSpacing: '-0.02em',
            color: '#e2e8f0',
            lineHeight: 1.15,
            margin: '0 0 6px',
          }}
        >
          DID Lookup
        </h1>
        <p
          style={{
            fontSize: '0.85rem',
            color: '#718096',
            marginTop: 4,
            lineHeight: 1.6,
            maxWidth: 480,
            marginLeft: 'auto',
            marginRight: 'auto',
          }}
        >
          Search for any DID across all products and customers. View configuration, ownership, and call history.
        </p>
      </div>

      {/* ── Search Bar ──────────────────────────────────────────── */}
      <div style={{ position: 'relative', marginBottom: 24 }}>
        {/* Search icon */}
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 18,
            top: '50%',
            transform: 'translateY(-50%)',
            color: '#475569',
            display: 'flex',
            alignItems: 'center',
            pointerEvents: 'none',
            zIndex: 1,
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 20, height: 20 }}>
            <path d="m21 21-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0Z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>

        <input
          type="text"
          value={inputValue}
          onChange={(e) => handleInputChange(e.target.value)}
          placeholder="Search by DID, phone number, or digits..."
          autoFocus
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '16px 52px 16px 52px',
            fontSize: '1rem',
            fontWeight: 500,
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 14,
            color: '#f1f5f9',
            outline: 'none',
            transition: 'border-color 0.15s, box-shadow 0.15s, background 0.15s',
            boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
            fontFamily: 'inherit',
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = 'rgba(59,130,246,0.5)';
            e.currentTarget.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.12), 0 4px 24px rgba(0,0,0,0.3)';
            e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
            e.currentTarget.style.boxShadow = '0 4px 24px rgba(0,0,0,0.3)';
            e.currentTarget.style.background = 'rgba(255,255,255,0.03)';
          }}
        />

        {/* Right-side: spinner or clear button */}
        <span
          style={{
            position: 'absolute',
            right: 16,
            top: '50%',
            transform: 'translateY(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          {isFetching && isSearching && <Spinner size="sm" />}
          {inputValue && !(isFetching && isSearching) && (
            <button
              type="button"
              onClick={handleClearSearch}
              title="Clear search"
              style={{
                background: 'transparent',
                border: 'none',
                color: '#475569',
                cursor: 'pointer',
                padding: 4,
                borderRadius: 4,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'color 0.1s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#94a3b8'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#475569'; }}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </span>
      </div>

      {/* ── Results Area ─────────────────────────────────────────── */}

      {/* Initial load spinner — only shown on the very first browse fetch */}
      {!isSearching && isLoading && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            justifyContent: 'center',
            padding: '48px 0',
            color: '#64748b',
            fontSize: '0.875rem',
          }}
        >
          <Spinner size="md" />
          <span>Loading DIDs…</span>
        </div>
      )}

      {/* Search loading state */}
      {isSearching && isLoading && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            justifyContent: 'center',
            padding: '48px 0',
            color: '#64748b',
            fontSize: '0.875rem',
          }}
        >
          <Spinner size="md" />
          <span>Searching across all products…</span>
        </div>
      )}

      {/* Error state */}
      {isError && !isLoading && (
        <div
          style={{
            padding: '14px 18px',
            borderRadius: 10,
            background: 'rgba(239,68,68,0.06)',
            border: '1px solid rgba(239,68,68,0.18)',
            color: '#f87171',
            fontSize: '0.875rem',
          }}
        >
          {isSearching ? 'Search failed. Please try again.' : 'Failed to load DIDs. Please refresh the page.'}
        </div>
      )}

      {/* No results (search mode only — browse having zero DIDs is an infrastructure problem, not a UX state) */}
      {isSearching && !isLoading && !isError && results.length === 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '56px 16px',
            gap: 8,
            textAlign: 'center',
            background: 'linear-gradient(135deg, rgba(30,33,48,0.4) 0%, rgba(19,21,29,0.5) 100%)',
            border: '1px solid rgba(42,47,69,0.3)',
            borderRadius: 16,
          }}
        >
          <div style={{ fontSize: '1.4rem', opacity: 0.3 }}>∅</div>
          <p style={{ color: '#64748b', fontSize: '0.9rem', fontWeight: 500, margin: '0 0 4px' }}>
            No DID found matching &lsquo;{query}&rsquo;
          </p>
          <p style={{ color: '#334155', fontSize: '0.78rem', margin: 0 }}>
            Try a different number or check the formatting
          </p>
        </div>
      )}

      {/* Results table — shown in both browse and search modes once data is ready */}
      {!isLoading && !isError && results.length > 0 && (
        <DIDTable
          results={results}
          total={total}
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={handlePageChange}
          expandedDID={expandedDID}
          onToggleExpand={handleToggleExpand}
          isFetching={isFetching}
          countLabel={isSearching ? 'results' : 'DIDs'}
        />
      )}
    </div>
  );
}
