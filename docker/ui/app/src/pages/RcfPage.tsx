import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Spinner } from '../components/ui/Spinner';
import { Badge } from '../components/ui/Badge';
import { listRcf } from '../api/rcf';
import type { RcfEntry } from '../types/rcf';
import { RcfCard } from './RcfCard';
import { useAuth } from '../contexts/AuthContext';
import { IconRCF } from '../components/icons/ProductIcons';
import { AdminCustomerSelector } from '../components/AdminCustomerSelector';
import { fmt } from '../utils/format';
import { apiRequest } from '../api/client';
import { useToast } from '../components/ui/Toast';

// ─── API helpers ─────────────────────────────────────────────────────────────

async function updateRcfForwardTo(did: string, forward_to: string): Promise<RcfEntry> {
  return apiRequest('PUT', `/rcf/${encodeURIComponent(did)}`, { forward_to });
}

// ─── Types ────────────────────────────────────────────────────────────────────

type ViewMode = 'card' | 'table';
type SortField = 'did' | 'name' | 'forward_to' | 'customer' | 'status';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;
const TABLE_VIEW_THRESHOLD = 50;

// ─── Sort helpers ────────────────────────────────────────────────────────────

function sortEntries(entries: RcfEntry[], field: SortField, dir: SortDir): RcfEntry[] {
  const sorted = [...entries].sort((a, b) => {
    let aVal = '';
    let bVal = '';
    switch (field) {
      case 'did':      aVal = a.did;                    bVal = b.did;                    break;
      case 'name':     aVal = a.name ?? '';              bVal = b.name ?? '';             break;
      case 'forward_to': aVal = a.forward_to;           bVal = b.forward_to;             break;
      case 'customer': aVal = a.customer_name ?? '';     bVal = b.customer_name ?? '';   break;
      case 'status':   aVal = String(a.enabled);        bVal = String(b.enabled);        break;
    }
    const cmp = aVal.localeCompare(bVal, undefined, { numeric: true });
    return dir === 'asc' ? cmp : -cmp;
  });
  return sorted;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

interface SortHeaderProps {
  label: string;
  field: SortField;
  currentField: SortField;
  currentDir: SortDir;
  onSort: (field: SortField) => void;
}

function SortHeader({ label, field, currentField, currentDir, onSort }: SortHeaderProps) {
  const isActive = currentField === field;
  return (
    <th
      onClick={() => onSort(field)}
      style={{
        padding: '10px 16px',
        textAlign: 'left',
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
          <span style={{ color: '#22c55e', fontSize: '0.7rem' }}>
            {currentDir === 'asc' ? '↑' : '↓'}
          </span>
        ) : (
          <span style={{ color: '#2d3748', fontSize: '0.7rem' }}>↕</span>
        )}
      </span>
    </th>
  );
}

interface TableRowProps {
  entry: RcfEntry;
  isAdmin: boolean;
  isOdd: boolean;
  canEdit: boolean;
  pendingValue: string;
  onPendingChange: (did: string, value: string) => void;
}

function TableRow({ entry, isAdmin, isOdd, canEdit, pendingValue, onPendingChange }: TableRowProps) {
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();

  // Each row manages whether it is in inline-edit mode for forward_to
  const [editing, setEditing] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  const isDirty = pendingValue !== entry.forward_to && pendingValue !== '';

  const mutation = useMutation({
    mutationFn: (newValue: string) => updateRcfForwardTo(entry.did, newValue.trim()),
    onSuccess: (_data, newValue) => {
      void queryClient.invalidateQueries({ queryKey: ['rcf'] });
      onPendingChange(entry.did, newValue.trim());
      setEditing(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1800);
      toastOk(`Saved — calls to ${fmt(entry.did)} now ring ${fmt(newValue.trim())}`);
    },
    onError: (error: Error) => {
      toastErr(error.message ?? 'Failed to save');
    },
  });

  const handleSave = useCallback(() => {
    const trimmed = pendingValue.trim();
    if (!trimmed) { toastErr('Destination cannot be empty'); return; }
    mutation.mutate(trimmed);
  }, [pendingValue, mutation, toastErr]);

  const handleCancel = useCallback(() => {
    onPendingChange(entry.did, entry.forward_to);
    setEditing(false);
  }, [entry.did, entry.forward_to, onPendingChange]);

  return (
    <tr
      style={{
        background: savedFlash
          ? 'rgba(34,197,94,0.06)'
          : isOdd ? 'rgba(255,255,255,0.012)' : 'transparent',
        transition: 'background 0.3s',
        borderBottom: '1px solid rgba(255,255,255,0.03)',
      }}
      onMouseEnter={(e) => {
        if (!savedFlash)
          (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(34,197,94,0.04)';
      }}
      onMouseLeave={(e) => {
        if (!savedFlash)
          (e.currentTarget as HTMLTableRowElement).style.background = isOdd
            ? 'rgba(255,255,255,0.012)'
            : 'transparent';
      }}
    >
      {/* DID */}
      <td style={{ padding: '12px 16px' }}>
        <div>
          <div
            style={{
              fontSize: '0.875rem',
              fontWeight: 700,
              color: '#e2e8f0',
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: '-0.01em',
            }}
          >
            {fmt(entry.did)}
          </div>
          <div style={{ fontSize: '0.65rem', color: '#475569', fontFamily: 'monospace', marginTop: 2 }}>
            {entry.did}
          </div>
        </div>
      </td>

      {/* Name */}
      <td style={{ padding: '12px 16px' }}>
        <span style={{ fontSize: '0.82rem', color: entry.name ? '#cbd5e0' : '#334155', fontStyle: entry.name ? 'normal' : 'italic' }}>
          {entry.name ?? 'No label'}
        </span>
      </td>

      {/* Forward To — static for readonly, inline-editable for canEdit */}
      <td style={{ padding: '8px 16px' }}>
        {canEdit && editing ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="tel"
              value={pendingValue}
              autoFocus
              placeholder="+1XXXXXXXXXX"
              disabled={mutation.isPending}
              onChange={(e) => onPendingChange(entry.did, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); handleSave(); }
                if (e.key === 'Escape') handleCancel();
              }}
              style={{
                width: 150,
                fontSize: '0.82rem',
                padding: '5px 9px',
                borderRadius: 6,
                border: `1px solid ${isDirty ? '#3b82f6' : 'rgba(42,47,69,0.8)'}`,
                background: 'rgba(19,21,29,0.8)',
                color: '#e2e8f0',
                fontFamily: 'monospace',
                outline: 'none',
                boxShadow: isDirty ? '0 0 0 2px rgba(59,130,246,0.2)' : 'none',
                opacity: mutation.isPending ? 0.5 : 1,
                transition: 'border-color 0.15s, box-shadow 0.15s',
              }}
            />
            <button
              type="button"
              disabled={!isDirty || mutation.isPending}
              onMouseDown={(e) => { e.preventDefault(); handleSave(); }}
              style={{
                fontSize: '0.65rem',
                fontWeight: 600,
                padding: '4px 10px',
                borderRadius: 4,
                border: 'none',
                background: isDirty && !mutation.isPending ? '#22c55e' : 'rgba(34,197,94,0.3)',
                color: '#fff',
                cursor: isDirty && !mutation.isPending ? 'pointer' : 'not-allowed',
                flexShrink: 0,
                lineHeight: 1,
              }}
            >
              {mutation.isPending ? '…' : 'Save'}
            </button>
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); handleCancel(); }}
              style={{
                fontSize: '0.65rem',
                fontWeight: 500,
                padding: '4px 8px',
                borderRadius: 4,
                border: 'none',
                background: 'transparent',
                color: '#718096',
                cursor: 'pointer',
                flexShrink: 0,
                lineHeight: 1,
              }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <span
            onClick={() => { if (canEdit) setEditing(true); }}
            title={canEdit ? 'Click to edit' : undefined}
            style={{
              fontSize: '0.82rem',
              color: savedFlash ? '#4ade80' : '#22c55e',
              fontFamily: 'monospace',
              fontWeight: 600,
              cursor: canEdit ? 'pointer' : 'default',
              borderBottom: canEdit ? '1px dashed rgba(34,197,94,0.35)' : 'none',
              paddingBottom: canEdit ? 1 : 0,
              transition: 'color 0.3s',
            }}
          >
            {fmt(entry.forward_to)}
          </span>
        )}
      </td>

      {/* Status */}
      <td style={{ padding: '12px 16px' }}>
        <Badge variant={entry.enabled ? 'active' : 'disabled'}>
          {entry.enabled ? 'Active' : 'Disabled'}
        </Badge>
      </td>

      {/* Customer (admin only) */}
      {isAdmin && (
        <td style={{ padding: '12px 16px' }}>
          <span style={{ fontSize: '0.78rem', color: '#64748b' }}>
            {entry.customer_name ?? `ID ${entry.customer_id}`}
          </span>
        </td>
      )}
    </tr>
  );
}

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

  // Build page number buttons — show first, last, and a window around current
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
    border: active ? '1px solid #22c55e50' : '1px solid rgba(255,255,255,0.06)',
    background: active
      ? 'linear-gradient(135deg, rgba(34,197,94,0.18) 0%, rgba(34,197,94,0.08) 100%)'
      : 'rgba(255,255,255,0.02)',
    color: active ? '#22c55e' : disabled ? '#2d3748' : '#64748b',
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
      {/* Left: count info + page size */}
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

      {/* Right: page buttons */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {/* Prev */}
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
          )
        )}

        {/* Next */}
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

export function RcfPage() {
  const { user, isAdmin } = useAuth();
  const [adminSelectedCustomer, setAdminSelectedCustomer] = useState<number | undefined>(undefined);

  // Non-admins: locked to their customer. Admins: use selector (undefined = all)
  const customerId = isAdmin ? adminSelectedCustomer : (user?.customer_id ?? undefined);

  // Pagination: server-side for large result sets
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);

  // Search: client-side filter on the current page's data
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // View and sort state
  const [viewMode, setViewMode] = useState<ViewMode | null>(null); // null = auto
  const [sortField, setSortField] = useState<SortField>('did');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // Reset to page 1 whenever the customer filter or search changes
  function handleSearchInput(value: string) {
    setSearchInput(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setSearchQuery(value.trim());
      setPage(1);
    }, 250);
  }

  useEffect(() => {
    return () => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current); };
  }, []);

  // When customer changes, reset pagination and search
  function handleCustomerSelect(id: number | undefined) {
    setAdminSelectedCustomer(id);
    setPage(1);
    setSearchInput('');
    setSearchQuery('');
  }

  const { data, isLoading, isError } = useQuery({
    queryKey: ['rcf', customerId, page, pageSize],
    queryFn: () => listRcf({ limit: pageSize, offset: (page - 1) * pageSize, customer_id: customerId }),
  });

  const [pendingEdits, setPendingEdits] = useState<Record<string, string>>({});

  const rawEntries: RcfEntry[] = useMemo(() => data?.items ?? [], [data]);
  const serverTotal: number = data?.total ?? 0;

  // Client-side search filter on the fetched page
  const filteredEntries = useMemo(() => {
    if (!searchQuery) return rawEntries;
    const q = searchQuery.toLowerCase();
    return rawEntries.filter(
      (e) =>
        e.did.includes(q) ||
        e.forward_to.toLowerCase().includes(q) ||
        (e.name ?? '').toLowerCase().includes(q) ||
        (e.customer_name ?? '').toLowerCase().includes(q),
    );
  }, [rawEntries, searchQuery]);

  // Sort the filtered results
  const sortedEntries = useMemo(
    () => sortEntries(filteredEntries, sortField, sortDir),
    [filteredEntries, sortField, sortDir],
  );

  // Derive role-based constraints
  const role = user?.role ?? 'user';
  // Admin and support (readonly) are always locked to the table view
  const isTableOnly = role === 'admin' || role === 'readonly';
  // Readonly users cannot edit forward_to
  const canEdit = role !== 'readonly';

  // Determine effective view mode (auto-switch based on total count)
  const effectiveViewMode: ViewMode = useMemo(() => {
    if (isTableOnly) return 'table';
    if (viewMode !== null) return viewMode;
    return serverTotal > TABLE_VIEW_THRESHOLD ? 'table' : 'card';
  }, [isTableOnly, viewMode, serverTotal]);

  // Total pages uses server total (pagination is server-side)
  const totalPages = Math.max(1, Math.ceil(serverTotal / pageSize));

  function handlePendingChange(did: string, value: string) {
    setPendingEdits((prev) => ({ ...prev, [did]: value }));
  }

  function resolveValue(entry: RcfEntry): string {
    return pendingEdits[entry.did] !== undefined
      ? pendingEdits[entry.did]
      : entry.forward_to;
  }

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  }

  return (
    <div>
      <PortalHeader
        icon={<IconRCF size={24} />}
        title={user?.customer_name ? `${user.customer_name}'s RCF Numbers` : 'RCF Numbers'}
        subtitle="Manage Remote Call Forwarding numbers. Changes take effect within seconds."
        badgeVariant="rcf"
      />

      <AdminCustomerSelector
        selectedCustomerId={adminSelectedCustomer}
        onSelect={handleCustomerSelect}
        accent="#22c55e"
        accountTypes={['rcf', 'hybrid']}
      />

      {/* ── Toolbar: Search + View Toggle + Sort ─────────────── */}
      {(!isLoading && !isError) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 20,
            flexWrap: 'wrap',
          }}
        >
          {/* Search input */}
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
              placeholder="Filter by DID, name, or destination…"
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
                e.currentTarget.style.borderColor = 'rgba(34,197,94,0.4)';
                e.currentTarget.style.boxShadow = '0 0 0 2px rgba(34,197,94,0.1)';
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

          {/* View mode toggle — hidden for admin/support who are locked to table */}
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
              {([
                { mode: 'card' as ViewMode, label: 'Cards', icon: (
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 14, height: 14 }}>
                    <rect x="1" y="1" width="6" height="6" rx="1.5" />
                    <rect x="9" y="1" width="6" height="6" rx="1.5" />
                    <rect x="1" y="9" width="6" height="6" rx="1.5" />
                    <rect x="9" y="9" width="6" height="6" rx="1.5" />
                  </svg>
                )},
                { mode: 'table' as ViewMode, label: 'Table', icon: (
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 14, height: 14 }}>
                    <path d="M1 4h14M1 8h14M1 12h14M5 1v14M11 1v14" strokeLinecap="round" />
                  </svg>
                )},
              ] as const).map(({ mode, label, icon }) => {
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
                        ? 'linear-gradient(135deg, rgba(34,197,94,0.18) 0%, rgba(34,197,94,0.08) 100%)'
                        : 'transparent',
                      color: isActive ? '#22c55e' : '#64748b',
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

      {/* ── Loading ─────────────────────────────────────────────── */}
      {isLoading && (
        <div className="flex items-center gap-2.5 text-[#718096] text-sm py-12">
          <Spinner size="sm" />
          <span>Loading your numbers…</span>
        </div>
      )}

      {/* ── Error ───────────────────────────────────────────────── */}
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
          Unable to load RCF numbers. Please try refreshing the page.
        </div>
      )}

      {/* ── Empty ───────────────────────────────────────────────── */}
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
            No RCF numbers found for your account.
          </p>
          <p style={{ color: '#4a5568', fontSize: '0.75rem' }}>
            Contact support to provision numbers.
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
            No numbers match &ldquo;{searchQuery}&rdquo;
          </p>
          <button
            type="button"
            onClick={() => { setSearchInput(''); setSearchQuery(''); }}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#22c55e',
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

      {/* ── Table View ──────────────────────────────────────────── */}
      {!isLoading && !isError && sortedEntries.length > 0 && effectiveViewMode === 'table' && (
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
                <SortHeader label="DID"         field="did"        currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                <SortHeader label="Name"        field="name"       currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                <SortHeader label="Forward To"  field="forward_to" currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                <SortHeader label="Status"      field="status"     currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                {isAdmin && (
                  <SortHeader label="Customer"  field="customer"   currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                )}
              </tr>
            </thead>
            <tbody>
              {sortedEntries.map((entry, i) => (
                <TableRow
                  key={entry.id}
                  entry={entry}
                  isAdmin={isAdmin}
                  isOdd={i % 2 === 1}
                  canEdit={canEdit}
                  pendingValue={resolveValue(entry)}
                  onPendingChange={handlePendingChange}
                />
              ))}
            </tbody>
          </table>

          {/* Pagination */}
          {serverTotal > pageSize && (
            <PaginationControls
              currentPage={page}
              totalPages={totalPages}
              pageSize={pageSize}
              totalItems={serverTotal}
              onPageChange={setPage}
              onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
            />
          )}
        </div>
      )}

      {/* ── Card View ───────────────────────────────────────────── */}
      {!isLoading && !isError && sortedEntries.length > 0 && effectiveViewMode === 'card' && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
            {sortedEntries.map((entry) => (
              <RcfCard
                key={entry.id}
                entry={entry}
                pendingValue={resolveValue(entry)}
                onPendingChange={handlePendingChange}
              />
            ))}
          </div>

          {/* Pagination below cards */}
          {serverTotal > pageSize && (
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
                totalItems={serverTotal}
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

// ─── PortalHeader (shared component) ─────────────────────────────────────────

interface PortalHeaderProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  badgeVariant?: 'rcf' | 'api' | 'trunk';
  userEmail?: string | null;
}

const ACCENT_BY_VARIANT: Record<string, string> = {
  rcf: '#22c55e',
  api: '#a855f7',
  trunk: '#f59e0b',
};

export function PortalHeader({ icon, title, subtitle, badgeVariant = 'rcf', userEmail }: PortalHeaderProps) {
  const accent = ACCENT_BY_VARIANT[badgeVariant] ?? '#3b82f6';

  return (
    <div
      style={{
        marginBottom: 36,
        paddingTop: 8,
        paddingBottom: 28,
        borderBottom: '1px solid rgba(42,47,69,0.6)',
        textAlign: 'center',
      }}
    >
      {/* Icon badge — centered */}
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 14,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: `linear-gradient(135deg, ${accent}20 0%, ${accent}10 100%)`,
          border: `1px solid ${accent}30`,
          color: accent,
          marginBottom: 14,
        }}
        aria-hidden="true"
      >
        {icon}
      </div>

      {/* Title */}
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
        {title}
      </h1>

      {/* User email — personal context */}
      {userEmail && (
        <div
          style={{
            fontSize: '0.78rem',
            color: accent,
            fontWeight: 600,
            letterSpacing: '0.01em',
            marginBottom: 6,
          }}
        >
          {userEmail}
        </div>
      )}

      <p
        style={{
          fontSize: '0.85rem',
          color: '#718096',
          marginTop: 2,
          lineHeight: 1.6,
          maxWidth: 480,
          marginLeft: 'auto',
          marginRight: 'auto',
        }}
      >
        {subtitle}
      </p>
    </div>
  );
}
