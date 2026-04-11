import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Spinner } from '../components/ui/Spinner';
import { Badge } from '../components/ui/Badge';
import { listTrunks, getTrunkIps, getTrunkDids, getTrunkStats } from '../api/trunks';
import type { Trunk, TrunkIp, TrunkDid } from '../types/trunk';
import { TrunkCard } from './TrunkCard';
import { PortalHeader } from './RcfPage';
import { useAuth } from '../contexts/AuthContext';
import { IconTrunk } from '../components/icons/ProductIcons';
import { AdminCustomerSelector } from '../components/AdminCustomerSelector';
import { fmt } from '../utils/format';

// ─── Types ────────────────────────────────────────────────────────────────────

type ViewMode = 'card' | 'table';
type SortField = 'trunk_name' | 'customer' | 'max_channels' | 'did_count' | 'ip_count' | 'status' | 'cps_limit';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;
const TABLE_VIEW_THRESHOLD = 20;

// Extended stats shape (mirrors what TrunkCard uses)
interface ExtendedTrunkStats {
  active_channels?: number;
  current_channels?: number;
  max_channels?: number;
  calls_today?: number;
  minutes_today?: number;
  cost_today?: number;
  channel_utilization?: string;
  last_hour?: {
    total_calls?: number;
    asr?: string;
    avg_duration_sec?: number;
  };
}

// ─── Sort helpers ─────────────────────────────────────────────────────────────

function sortTrunks(trunks: Trunk[], field: SortField, dir: SortDir): Trunk[] {
  return [...trunks].sort((a, b) => {
    let cmp = 0;
    switch (field) {
      case 'trunk_name':
        cmp = a.trunk_name.localeCompare(b.trunk_name, undefined, { numeric: true });
        break;
      case 'customer':
        cmp = (a.customer_name ?? '').localeCompare(b.customer_name ?? '', undefined, { numeric: true });
        break;
      case 'max_channels':
        cmp = (a.max_channels ?? 0) - (b.max_channels ?? 0);
        break;
      case 'did_count':
        cmp = (a.did_count ?? 0) - (b.did_count ?? 0);
        break;
      case 'ip_count':
        cmp = (a.ip_count ?? 0) - (b.ip_count ?? 0);
        break;
      case 'cps_limit':
        cmp = (a.cps_limit ?? 0) - (b.cps_limit ?? 0);
        break;
      case 'status':
        cmp = Number(b.enabled) - Number(a.enabled); // active first by default
        break;
    }
    return dir === 'asc' ? cmp : -cmp;
  });
}

// ─── SortHeader ──────────────────────────────────────────────────────────────

interface SortHeaderProps {
  label: string;
  field: SortField;
  currentField: SortField;
  currentDir: SortDir;
  onSort: (field: SortField) => void;
  align?: 'left' | 'right' | 'center';
}

function SortHeader({ label, field, currentField, currentDir, onSort, align = 'left' }: SortHeaderProps) {
  const isActive = currentField === field;
  return (
    <th
      onClick={() => onSort(field)}
      style={{
        padding: '10px 16px',
        textAlign: align,
        fontSize: '0.6rem',
        fontWeight: 700,
        color: isActive ? '#94a3b8' : '#334155',
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        whiteSpace: 'nowrap',
        background: 'rgba(0,0,0,0.06)',
        cursor: 'pointer',
        userSelect: 'none',
        transition: 'color 0.1s',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {label}
        {isActive ? (
          <span style={{ color: '#f59e0b', fontSize: '0.7rem' }}>
            {currentDir === 'asc' ? '↑' : '↓'}
          </span>
        ) : (
          <span style={{ color: '#2d3748', fontSize: '0.7rem' }}>↕</span>
        )}
      </span>
    </th>
  );
}

// ─── Expandable table row drawer ──────────────────────────────────────────────

interface TrunkRowDrawerProps {
  trunkId: number;
  colSpan: number;
}

function TrunkRowDrawer({ trunkId, colSpan }: TrunkRowDrawerProps) {
  const statsQuery = useQuery<ExtendedTrunkStats>({
    queryKey: ['trunk-stats', trunkId],
    queryFn: () => getTrunkStats(trunkId) as Promise<ExtendedTrunkStats>,
    staleTime: 3_000,
    refetchInterval: 5_000,
  });

  const ipsQuery = useQuery<TrunkIp[]>({
    queryKey: ['trunk-ips', trunkId],
    queryFn: () => getTrunkIps(trunkId),
    staleTime: 60_000,
  });

  const didsQuery = useQuery<TrunkDid[]>({
    queryKey: ['trunk-dids', trunkId],
    queryFn: () => getTrunkDids(trunkId),
    staleTime: 60_000,
  });

  const stats = statsQuery.data;
  const currentChannels = stats?.current_channels ?? stats?.active_channels ?? 0;
  const maxChannels = stats?.max_channels ?? 0;
  const utilPct = maxChannels > 0 ? Math.min(100, Math.round((currentChannels / maxChannels) * 100)) : 0;
  const utilBarColor = utilPct >= 80 ? '#ef4444' : utilPct >= 50 ? '#f59e0b' : '#22c55e';
  const lastHour = stats?.last_hour;

  return (
    <tr>
      <td
        colSpan={colSpan}
        style={{
          background: 'rgba(15,17,23,0.5)',
          borderBottom: '1px solid rgba(42,47,69,0.5)',
          padding: '0',
        }}
      >
        <div
          style={{
            padding: '16px 24px 20px',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 20,
          }}
        >
          {/* Live channel utilization */}
          <div>
            <div
              style={{
                fontSize: '0.6rem',
                fontWeight: 700,
                color: '#475569',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                marginBottom: 8,
              }}
            >
              Live Channels
            </div>
            {statsQuery.isLoading ? (
              <div className="flex items-center gap-1.5 text-[#718096] text-xs">
                <Spinner size="xs" /> Loading…
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginBottom: 6 }}>
                  <span
                    style={{
                      fontSize: '1.4rem',
                      fontWeight: 700,
                      color: '#e2e8f0',
                      fontVariantNumeric: 'tabular-nums',
                      lineHeight: 1,
                    }}
                  >
                    {currentChannels}
                  </span>
                  <span style={{ fontSize: '0.82rem', color: '#718096' }}>/ {maxChannels}</span>
                </div>
                <div
                  style={{
                    width: '100%',
                    height: 4,
                    borderRadius: 4,
                    background: 'rgba(42,47,69,0.8)',
                    overflow: 'hidden',
                    marginBottom: 4,
                  }}
                  role="progressbar"
                  aria-valuenow={utilPct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`Channel utilization: ${utilPct}%`}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${utilPct}%`,
                      borderRadius: 4,
                      backgroundColor: utilBarColor,
                      transition: 'width 0.3s',
                    }}
                  />
                </div>
                <span style={{ fontSize: '0.65rem', color: '#718096' }}>
                  {stats?.channel_utilization ?? `${utilPct}%`} utilization
                </span>
                {lastHour && (
                  <div style={{ marginTop: 8, display: 'flex', gap: 16 }}>
                    {lastHour.total_calls != null && (
                      <div>
                        <span style={{ fontSize: '0.65rem', color: '#475569', display: 'block' }}>Last hour calls</span>
                        <span style={{ fontSize: '0.88rem', fontWeight: 600, color: '#cbd5e0' }}>
                          {lastHour.total_calls.toLocaleString()}
                        </span>
                      </div>
                    )}
                    {lastHour.asr && (
                      <div>
                        <span style={{ fontSize: '0.65rem', color: '#475569', display: 'block' }}>ASR</span>
                        <span style={{ fontSize: '0.88rem', fontWeight: 600, color: '#cbd5e0' }}>{lastHour.asr}</span>
                      </div>
                    )}
                    {lastHour.avg_duration_sec != null && (
                      <div>
                        <span style={{ fontSize: '0.65rem', color: '#475569', display: 'block' }}>Avg dur.</span>
                        <span style={{ fontSize: '0.88rem', fontWeight: 600, color: '#cbd5e0' }}>
                          {lastHour.avg_duration_sec.toFixed(1)}s
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Auth IPs */}
          <div>
            <div
              style={{
                fontSize: '0.6rem',
                fontWeight: 700,
                color: '#475569',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                marginBottom: 8,
              }}
            >
              Authorized IPs
            </div>
            {ipsQuery.isLoading ? (
              <div className="flex items-center gap-1.5 text-[#718096] text-xs">
                <Spinner size="xs" /> Loading…
              </div>
            ) : ipsQuery.data && ipsQuery.data.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {ipsQuery.data.map((ip) => (
                  <div
                    key={ip.id}
                    style={{
                      display: 'inline-flex',
                      flexDirection: 'column',
                      background: 'rgba(30,33,48,0.8)',
                      border: '1px solid rgba(42,47,69,0.6)',
                      borderRadius: 6,
                      padding: '4px 10px',
                    }}
                  >
                    <span
                      style={{
                        fontSize: '0.75rem',
                        fontFamily: 'monospace',
                        fontWeight: 600,
                        color: '#e2e8f0',
                      }}
                    >
                      {ip.ip_address}
                    </span>
                    {ip.description && (
                      <span style={{ fontSize: '0.62rem', color: '#718096' }}>{ip.description}</span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p style={{ fontSize: '0.78rem', color: '#475569', fontStyle: 'italic' }}>No IPs configured</p>
            )}
          </div>

          {/* DIDs */}
          <div>
            <div
              style={{
                fontSize: '0.6rem',
                fontWeight: 700,
                color: '#475569',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                marginBottom: 8,
              }}
            >
              Assigned DIDs
            </div>
            {didsQuery.isLoading ? (
              <div className="flex items-center gap-1.5 text-[#718096] text-xs">
                <Spinner size="xs" /> Loading…
              </div>
            ) : didsQuery.data && didsQuery.data.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {didsQuery.data.map((d) => (
                  <span
                    key={d.id}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      fontSize: '0.72rem',
                      fontFamily: 'monospace',
                      fontWeight: 600,
                      background: 'rgba(30,33,48,0.8)',
                      color: '#e2e8f0',
                      border: '1px solid rgba(42,47,69,0.6)',
                      padding: '4px 8px',
                      borderRadius: 6,
                    }}
                  >
                    {fmt(d.did)}
                  </span>
                ))}
              </div>
            ) : (
              <p style={{ fontSize: '0.78rem', color: '#475569', fontStyle: 'italic' }}>No DIDs assigned</p>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}

// ─── Table row ────────────────────────────────────────────────────────────────

interface TrunkTableRowProps {
  trunk: Trunk;
  isAdmin: boolean;
  isOdd: boolean;
  expandedId: number | null;
  onToggleExpand: (id: number) => void;
  colSpan: number;
}

function TrunkTableRow({
  trunk,
  isAdmin,
  isOdd,
  expandedId,
  onToggleExpand,
  colSpan,
}: TrunkTableRowProps) {
  const isExpanded = expandedId === trunk.id;

  return (
    <>
      <tr
        style={{
          background: isExpanded
            ? 'rgba(245,158,11,0.06)'
            : isOdd
            ? 'rgba(255,255,255,0.012)'
            : 'transparent',
          borderBottom: isExpanded ? 'none' : '1px solid rgba(255,255,255,0.03)',
          transition: 'background 0.15s',
          cursor: 'pointer',
        }}
        onClick={() => onToggleExpand(trunk.id)}
        onMouseEnter={(e) => {
          if (!isExpanded)
            (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(245,158,11,0.04)';
        }}
        onMouseLeave={(e) => {
          if (!isExpanded)
            (e.currentTarget as HTMLTableRowElement).style.background = isOdd
              ? 'rgba(255,255,255,0.012)'
              : 'transparent';
        }}
      >
        {/* Trunk Name */}
        <td style={{ padding: '12px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Expand chevron */}
            <span
              aria-hidden="true"
              style={{
                color: '#f59e0b',
                opacity: isExpanded ? 0.9 : 0.35,
                fontSize: '0.65rem',
                transition: 'opacity 0.15s, transform 0.15s',
                transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                display: 'inline-block',
                flexShrink: 0,
              }}
            >
              ▶
            </span>
            <div>
              <div
                style={{
                  fontSize: '0.875rem',
                  fontWeight: 700,
                  color: '#e2e8f0',
                  letterSpacing: '-0.01em',
                }}
              >
                {trunk.trunk_name}
              </div>
              <div
                style={{
                  fontSize: '0.65rem',
                  color: '#475569',
                  fontFamily: 'monospace',
                  marginTop: 2,
                }}
              >
                {trunk.auth_type} auth
                {trunk.tech_prefix && (
                  <span style={{ marginLeft: 6 }}>· prefix: {trunk.tech_prefix}</span>
                )}
              </div>
            </div>
          </div>
        </td>

        {/* Customer (admin only) */}
        {isAdmin && (
          <td style={{ padding: '12px 16px' }}>
            <span style={{ fontSize: '0.78rem', color: '#64748b' }}>
              {trunk.customer_name ?? `ID ${trunk.customer_id}`}
            </span>
          </td>
        )}

        {/* Max Channels */}
        <td style={{ padding: '12px 16px', textAlign: 'center' }}>
          <span
            style={{
              fontSize: '0.9rem',
              fontWeight: 700,
              color: '#e2e8f0',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {trunk.max_channels ?? '--'}
          </span>
          {trunk.package_name && (
            <div style={{ fontSize: '0.6rem', color: '#475569', marginTop: 2 }}>{trunk.package_name}</div>
          )}
        </td>

        {/* DIDs */}
        <td style={{ padding: '12px 16px', textAlign: 'center' }}>
          <span
            style={{
              fontSize: '0.9rem',
              fontWeight: 600,
              color: trunk.did_count ? '#e2e8f0' : '#334155',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {trunk.did_count ?? 0}
          </span>
        </td>

        {/* Auth IPs */}
        <td style={{ padding: '12px 16px', textAlign: 'center' }}>
          <span
            style={{
              fontSize: '0.9rem',
              fontWeight: 600,
              color: trunk.ip_count ? '#e2e8f0' : '#334155',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {trunk.ip_count ?? 0}
          </span>
        </td>

        {/* CPS Limit */}
        <td style={{ padding: '12px 16px', textAlign: 'center' }}>
          <span
            style={{
              fontSize: '0.9rem',
              fontWeight: 600,
              color: trunk.cps_limit != null ? '#e2e8f0' : '#334155',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {trunk.cps_limit != null ? trunk.cps_limit : '--'}
          </span>
        </td>

        {/* Status */}
        <td style={{ padding: '12px 16px' }}>
          <Badge variant={trunk.enabled ? 'active' : 'disabled'}>
            {trunk.enabled ? 'Active' : 'Disabled'}
          </Badge>
        </td>
      </tr>

      {/* Expandable drawer row */}
      {isExpanded && <TrunkRowDrawer trunkId={trunk.id} colSpan={colSpan} />}
    </>
  );
}

// ─── Pagination ───────────────────────────────────────────────────────────────

interface PaginationControlsProps {
  currentPage: number;
  totalPages: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

function PaginationControls({
  currentPage,
  totalPages,
  pageSize,
  totalItems,
  onPageChange,
  onPageSizeChange,
}: PaginationControlsProps) {
  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, totalItems);

  const pageNumbers: (number | 'ellipsis')[] = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pageNumbers.push(i);
  } else {
    pageNumbers.push(1);
    if (currentPage > 3) pageNumbers.push('ellipsis');
    const rangeStart = Math.max(2, currentPage - 1);
    const rangeEnd = Math.min(totalPages - 1, currentPage + 1);
    for (let i = rangeStart; i <= rangeEnd; i++) pageNumbers.push(i);
    if (currentPage < totalPages - 2) pageNumbers.push('ellipsis');
    pageNumbers.push(totalPages);
  }

  const btnStyle = (active: boolean, disabled: boolean): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 32,
    height: 32,
    padding: '0 8px',
    borderRadius: 6,
    fontSize: '0.78rem',
    fontWeight: active ? 700 : 500,
    cursor: disabled ? 'not-allowed' : 'pointer',
    border: active ? '1px solid rgba(245,158,11,0.4)' : '1px solid rgba(255,255,255,0.06)',
    background: active
      ? 'linear-gradient(135deg, rgba(245,158,11,0.18) 0%, rgba(245,158,11,0.08) 100%)'
      : 'rgba(255,255,255,0.02)',
    color: active ? '#f59e0b' : disabled ? '#2d3748' : '#64748b',
    opacity: disabled ? 0.4 : 1,
    transition: 'background 0.1s, color 0.1s, border-color 0.1s',
    userSelect: 'none',
    fontFamily: 'inherit',
  });

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 12,
        padding: '14px 16px',
        borderTop: '1px solid rgba(255,255,255,0.05)',
        background: 'rgba(0,0,0,0.06)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
          Showing <strong style={{ color: '#94a3b8' }}>{start}–{end}</strong> of{' '}
          <strong style={{ color: '#94a3b8' }}>{totalItems}</strong>
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: '0.72rem', color: '#475569' }}>Per page:</span>
          <select
            value={pageSize}
            onChange={(e) => { onPageSizeChange(Number(e.target.value)); onPageChange(1); }}
            style={{
              fontSize: '0.75rem',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 6,
              color: '#94a3b8',
              padding: '4px 8px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              outline: 'none',
            }}
          >
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <button
          type="button"
          disabled={currentPage === 1}
          onClick={() => onPageChange(currentPage - 1)}
          style={btnStyle(false, currentPage === 1)}
          aria-label="Previous page"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 12, height: 12 }}>
            <path d="M10 12L6 8l4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {pageNumbers.map((p, i) =>
          p === 'ellipsis' ? (
            <span key={`ell-${i}`} style={{ color: '#334155', padding: '0 4px', fontSize: '0.78rem' }}>…</span>
          ) : (
            <button
              key={p}
              type="button"
              onClick={() => onPageChange(p)}
              style={btnStyle(currentPage === p, false)}
            >
              {p}
            </button>
          ),
        )}

        <button
          type="button"
          disabled={currentPage === totalPages}
          onClick={() => onPageChange(currentPage + 1)}
          style={btnStyle(false, currentPage === totalPages)}
          aria-label="Next page"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 12, height: 12 }}>
            <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function TrunksPage() {
  const { user, isAdmin } = useAuth();
  const [adminSelectedCustomer, setAdminSelectedCustomer] = useState<number | undefined>(undefined);

  // Non-admins: locked to their customer. Admins: use selector (undefined = all)
  const customerId = isAdmin ? adminSelectedCustomer : (user?.customer_id ?? undefined);

  // Pagination (client-side — full list fetched at once like the original)
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);

  // Search
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // View and sort state
  const [viewMode, setViewMode] = useState<ViewMode | null>(null); // null = auto
  const [sortField, setSortField] = useState<SortField>('trunk_name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // Expanded row in table view
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Role-based view enforcement — same pattern as RCF page
  const role = user?.role ?? 'user';
  const isTableOnly = role === 'admin' || role === 'readonly';

  const { data, isLoading, isError } = useQuery({
    queryKey: ['trunks', customerId],
    queryFn: () => listTrunks({ limit: 200, customer_id: customerId }),
  });

  const rawEntries: Trunk[] = useMemo(() => data?.items ?? [], [data]);
  const serverTotal = rawEntries.length;

  // Search filter
  const filteredEntries = useMemo(() => {
    if (!searchQuery) return rawEntries;
    const q = searchQuery.toLowerCase();
    return rawEntries.filter(
      (t) =>
        t.trunk_name.toLowerCase().includes(q) ||
        (t.customer_name ?? '').toLowerCase().includes(q) ||
        (t.package_name ?? '').toLowerCase().includes(q) ||
        (t.auth_type ?? '').toLowerCase().includes(q),
    );
  }, [rawEntries, searchQuery]);

  // Sort
  const sortedEntries = useMemo(
    () => sortTrunks(filteredEntries, sortField, sortDir),
    [filteredEntries, sortField, sortDir],
  );

  // Client-side pagination slice
  const totalPages = Math.max(1, Math.ceil(sortedEntries.length / pageSize));
  const pagedEntries = useMemo(() => {
    const start = (page - 1) * pageSize;
    return sortedEntries.slice(start, start + pageSize);
  }, [sortedEntries, page, pageSize]);

  // Effective view mode
  const effectiveViewMode: ViewMode = useMemo(() => {
    if (isTableOnly) return 'table';
    if (viewMode !== null) return viewMode;
    return serverTotal > TABLE_VIEW_THRESHOLD ? 'table' : 'card';
  }, [isTableOnly, viewMode, serverTotal]);

  // Number of columns (drives the drawer colSpan)
  const colSpan = isAdmin ? 7 : 6;

  const handleSearchInput = useCallback((value: string) => {
    setSearchInput(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setSearchQuery(value.trim());
      setPage(1);
    }, 250);
  }, []);

  useEffect(() => {
    return () => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current); };
  }, []);

  function handleCustomerSelect(id: number | undefined) {
    setAdminSelectedCustomer(id);
    setPage(1);
    setSearchInput('');
    setSearchQuery('');
    setExpandedId(null);
  }

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  }

  function handleToggleExpand(id: number) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  return (
    <div>
      <PortalHeader
        icon={<IconTrunk size={24} />}
        title={user?.customer_name ? `${user.customer_name}'s SIP Trunks` : 'SIP Trunks'}
        subtitle="Monitor your trunk performance and capacity. Contact support to adjust channel limits or authorized IPs."
        badgeVariant="trunk"
        userEmail={user?.email}
      />

      <AdminCustomerSelector
        selectedCustomerId={adminSelectedCustomer}
        onSelect={handleCustomerSelect}
        accent="#f59e0b"
        accountTypes={['trunk', 'hybrid']}
      />

      {/* ── Toolbar: Search + View Toggle ────────────────────────── */}
      {!isLoading && !isError && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 20,
            flexWrap: 'wrap',
          }}
        >
          {/* Search */}
          <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 180 }}>
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: 12,
                top: '50%',
                transform: 'translateY(-50%)',
                color: '#475569',
                display: 'flex',
                alignItems: 'center',
                pointerEvents: 'none',
              }}
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
                <path d="m19 19-4.35-4.35M15 9A6 6 0 1 1 3 9a6 6 0 0 1 12 0Z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <input
              type="text"
              value={searchInput}
              onChange={(e) => handleSearchInput(e.target.value)}
              placeholder="Filter by trunk name, customer, package…"
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '8px 12px 8px 34px',
                fontSize: '0.82rem',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: 9,
                color: '#e2e8f0',
                outline: 'none',
                fontFamily: 'inherit',
                transition: 'border-color 0.15s, box-shadow 0.15s',
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = 'rgba(245,158,11,0.4)';
                e.currentTarget.style.boxShadow = '0 0 0 2px rgba(245,158,11,0.1)';
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => { setSearchInput(''); setSearchQuery(''); }}
                style={{
                  position: 'absolute',
                  right: 8,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'transparent',
                  border: 'none',
                  color: '#475569',
                  cursor: 'pointer',
                  padding: 2,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} style={{ width: 12, height: 12 }}>
                  <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>

          {/* Result count pill */}
          {serverTotal > 0 && (
            <span
              style={{
                fontSize: '0.72rem',
                color: '#64748b',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: 6,
                padding: '4px 10px',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              {searchQuery && filteredEntries.length !== rawEntries.length
                ? `${filteredEntries.length} of ${serverTotal} total`
                : `${serverTotal} total`}
            </span>
          )}

          {/* View toggle — hidden for admin/support who are locked to table */}
          {!isTableOnly && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: 8,
                padding: 3,
                flexShrink: 0,
              }}
            >
              {(
                [
                  {
                    mode: 'card' as ViewMode,
                    label: 'Cards',
                    icon: (
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 14, height: 14 }}>
                        <rect x="1" y="1" width="6" height="6" rx="1.5" />
                        <rect x="9" y="1" width="6" height="6" rx="1.5" />
                        <rect x="1" y="9" width="6" height="6" rx="1.5" />
                        <rect x="9" y="9" width="6" height="6" rx="1.5" />
                      </svg>
                    ),
                  },
                  {
                    mode: 'table' as ViewMode,
                    label: 'Table',
                    icon: (
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 14, height: 14 }}>
                        <path d="M1 4h14M1 8h14M1 12h14M5 1v14M11 1v14" strokeLinecap="round" />
                      </svg>
                    ),
                  },
                ] as const
              ).map(({ mode, label, icon }) => {
                const isActive = effectiveViewMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setViewMode(mode)}
                    title={label}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '5px 10px',
                      borderRadius: 6,
                      fontSize: '0.72rem',
                      fontWeight: isActive ? 600 : 500,
                      cursor: 'pointer',
                      border: 'none',
                      background: isActive
                        ? 'linear-gradient(135deg, rgba(245,158,11,0.18) 0%, rgba(245,158,11,0.08) 100%)'
                        : 'transparent',
                      color: isActive ? '#f59e0b' : '#64748b',
                      transition: 'background 0.12s, color 0.12s',
                      whiteSpace: 'nowrap',
                      fontFamily: 'inherit',
                    }}
                  >
                    {icon}
                    {label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Loading ──────────────────────────────────────────────── */}
      {isLoading && (
        <div className="flex items-center gap-2.5 text-[#718096] text-sm py-12">
          <Spinner size="sm" />
          <span>Loading your SIP trunks…</span>
        </div>
      )}

      {/* ── Error ────────────────────────────────────────────────── */}
      {isError && (
        <div
          style={{
            padding: '12px 16px',
            borderRadius: 10,
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.2)',
            color: '#f87171',
            fontSize: '0.875rem',
            marginTop: 8,
          }}
        >
          Unable to load SIP trunks. Please try refreshing the page.
        </div>
      )}

      {/* ── Empty ────────────────────────────────────────────────── */}
      {!isLoading && !isError && rawEntries.length === 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '64px 16px',
            gap: 8,
            textAlign: 'center',
            background: 'linear-gradient(135deg, rgba(30,33,48,0.6) 0%, rgba(19,21,29,0.7) 100%)',
            border: '1px solid rgba(42,47,69,0.4)',
            borderRadius: 16,
          }}
        >
          <p style={{ color: '#718096', fontSize: '0.875rem', fontWeight: 500 }}>
            No SIP trunks found for your account.
          </p>
          <p style={{ color: '#4a5568', fontSize: '0.75rem' }}>
            Contact support to provision SIP trunks.
          </p>
        </div>
      )}

      {/* ── Search empty state ───────────────────────────────────── */}
      {!isLoading && !isError && rawEntries.length > 0 && sortedEntries.length === 0 && searchQuery && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '48px 16px',
            gap: 8,
            textAlign: 'center',
            background: 'rgba(30,33,48,0.4)',
            border: '1px solid rgba(42,47,69,0.3)',
            borderRadius: 14,
          }}
        >
          <p style={{ color: '#64748b', fontSize: '0.875rem', fontWeight: 500 }}>
            No trunks match &ldquo;{searchQuery}&rdquo;
          </p>
          <button
            type="button"
            onClick={() => { setSearchInput(''); setSearchQuery(''); }}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#f59e0b',
              fontSize: '0.78rem',
              cursor: 'pointer',
              textDecoration: 'underline',
              fontFamily: 'inherit',
            }}
          >
            Clear filter
          </button>
        </div>
      )}

      {/* ── Table View ───────────────────────────────────────────── */}
      {!isLoading && !isError && pagedEntries.length > 0 && effectiveViewMode === 'table' && (
        <div
          style={{
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: 14,
            overflow: 'hidden',
          }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                <SortHeader
                  label="Trunk Name"
                  field="trunk_name"
                  currentField={sortField}
                  currentDir={sortDir}
                  onSort={handleSort}
                />
                {isAdmin && (
                  <SortHeader
                    label="Customer"
                    field="customer"
                    currentField={sortField}
                    currentDir={sortDir}
                    onSort={handleSort}
                  />
                )}
                <SortHeader
                  label="Max Channels"
                  field="max_channels"
                  currentField={sortField}
                  currentDir={sortDir}
                  onSort={handleSort}
                  align="center"
                />
                <SortHeader
                  label="DIDs"
                  field="did_count"
                  currentField={sortField}
                  currentDir={sortDir}
                  onSort={handleSort}
                  align="center"
                />
                <SortHeader
                  label="Auth IPs"
                  field="ip_count"
                  currentField={sortField}
                  currentDir={sortDir}
                  onSort={handleSort}
                  align="center"
                />
                <SortHeader
                  label="CPS Limit"
                  field="cps_limit"
                  currentField={sortField}
                  currentDir={sortDir}
                  onSort={handleSort}
                  align="center"
                />
                <SortHeader
                  label="Status"
                  field="status"
                  currentField={sortField}
                  currentDir={sortDir}
                  onSort={handleSort}
                />
              </tr>
            </thead>
            <tbody>
              {pagedEntries.map((trunk, i) => (
                <TrunkTableRow
                  key={trunk.id}
                  trunk={trunk}
                  isAdmin={isAdmin}
                  isOdd={i % 2 === 1}
                  expandedId={expandedId}
                  onToggleExpand={handleToggleExpand}
                  colSpan={colSpan}
                />
              ))}
            </tbody>
          </table>

          {sortedEntries.length > pageSize && (
            <PaginationControls
              currentPage={page}
              totalPages={totalPages}
              pageSize={pageSize}
              totalItems={sortedEntries.length}
              onPageChange={setPage}
              onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
            />
          )}
        </div>
      )}

      {/* ── Card View ────────────────────────────────────────────── */}
      {!isLoading && !isError && pagedEntries.length > 0 && effectiveViewMode === 'card' && (
        <>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            {pagedEntries.map((trunk) => (
              <TrunkCard key={trunk.id} trunk={trunk} />
            ))}
          </div>

          {sortedEntries.length > pageSize && (
            <div
              style={{
                marginTop: 24,
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: 12,
                overflow: 'hidden',
              }}
            >
              <PaginationControls
                currentPage={page}
                totalPages={totalPages}
                pageSize={pageSize}
                totalItems={sortedEntries.length}
                onPageChange={setPage}
                onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
