import { useState, useMemo, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Spinner } from '../components/ui/Spinner';
import { listRcf } from '../api/rcf';
import type { RcfEntry } from '../types/rcf';
import { useAuth } from '../contexts/AuthContext';
import { listCustomers } from '../api/customers';
import { fmt } from '../utils/format';
import {
  AZURE_DEEP, DEFAULT_PAGE_SIZE, INK, INK_DIM, INK_FAINT, INK_SOFT, RED,
} from './rcf/theme';
import { PaginationControls } from './rcf/PaginationControls';
import { CallActivityTab } from './rcf/CallActivityTab';
import { RowEditor } from './rcf/RowEditor';
import { DIDManagementTab } from './rcf/DidManagement';
import { extractNpa } from './rcf/didFormat';
import { CustomerDashboard } from './rcf/CustomerDashboard';

// ─── Types & constants ────────────────────────────────────────────────────────

type SortField = 'did' | 'name' | 'forward_to' | 'customer' | 'status';
type SortDir = 'asc' | 'desc';

// ─── Sort helpers ─────────────────────────────────────────────────────────────

function sortEntries(entries: RcfEntry[], field: SortField, dir: SortDir): RcfEntry[] {
  return [...entries].sort((a, b) => {
    let aVal = '';
    let bVal = '';
    switch (field) {
      case 'did':        aVal = a.did;                  bVal = b.did;                  break;
      case 'name':       aVal = a.name ?? '';            bVal = b.name ?? '';           break;
      case 'forward_to': aVal = a.forward_to;            bVal = b.forward_to;           break;
      case 'customer':   aVal = a.customer_name ?? '';   bVal = b.customer_name ?? '';  break;
      case 'status':     aVal = String(a.enabled);       bVal = String(b.enabled);      break;
    }
    const cmp = aVal.localeCompare(bVal, undefined, { numeric: true });
    return dir === 'asc' ? cmp : -cmp;
  });
}


// ─── StatusPill ───────────────────────────────────────────────────────────────

function StatusPill({ enabled }: { enabled: boolean }) {
  return (
    <span className={enabled ? 'rcf-pill rcf-pill-on' : 'rcf-pill rcf-pill-off'}>
      {enabled ? 'Active' : 'Disabled'}
    </span>
  );
}

// ─── SortHeader ───────────────────────────────────────────────────────────────

interface SortHeaderProps {
  label: string;
  field: SortField;
  currentField: SortField;
  currentDir: SortDir;
  onSort: (field: SortField) => void;
  /** Optional fixed column width (px) — presentation only, keeps Label from crowding */
  width?: number;
}

function SortHeader({ label, field, currentField, currentDir, onSort, width }: SortHeaderProps) {
  const isActive = currentField === field;
  return (
    <th
      onClick={() => onSort(field)}
      aria-sort={isActive ? (currentDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`rcf-th rcf-th-sort${isActive ? ' rcf-th-active' : ''}`}
      style={width !== undefined ? { width } : undefined}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        {label}
        <span style={{ fontSize: '0.72rem', lineHeight: 1, opacity: isActive ? 1 : 0.45 }}>
          {isActive ? (currentDir === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </span>
    </th>
  );
}


// ─── NumberRow — collapsed row + expanded configuration panel ─────────────────

interface NumberRowProps {
  entry: RcfEntry;
  isAdmin: boolean;
  canEdit: boolean;
  expanded: boolean;
  onToggle: () => void;
  onCollapse: () => void;
}

function NumberRow({ entry, isAdmin, canEdit, expanded, onToggle, onCollapse }: NumberRowProps) {
  const colSpan = isAdmin ? 6 : 5;

  return (
    <>
      <tr
        className={`rcf-row rcf-nrow${expanded ? ' rcf-nrow-open' : ''}`}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
          if (e.key === 'Escape' && expanded) { e.preventDefault(); onCollapse(); }
        }}
      >
        {/* Chevron affordance */}
        <td style={{ padding: '15px 4px 15px 18px', width: 34 }}>
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke={expanded ? AZURE_DEEP : INK_FAINT}
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`rcf-chev${expanded ? ' rcf-chev-open' : ''}`}
            style={{ width: 13, height: 13 }}
          >
            <path d="M6 3l5 5-5 5" />
          </svg>
        </td>

        {/* Number — muted when disabled so state reads before the pill */}
        <td style={{ padding: '15px 16px', whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: '0.92rem', fontWeight: 600, color: entry.enabled ? INK : INK_SOFT, fontVariantNumeric: 'tabular-nums', lineHeight: 1.3 }}>
            {fmt(entry.did)}
          </span>
        </td>

        {/* Forwards to — azure means "this forward is live"; disabled goes quiet */}
        <td style={{ padding: '15px 16px', whiteSpace: 'nowrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
            <svg viewBox="0 0 16 10" fill="none" style={{ width: 14, height: 9, flexShrink: 0, opacity: 0.55 }} aria-hidden="true">
              <line x1="1" y1="5" x2="13" y2="5" stroke={INK_DIM} strokeWidth={1.5} strokeLinecap="round" />
              <path d="M10 2l3 3-3 3" stroke={INK_DIM} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span style={{ fontSize: '0.92rem', fontWeight: 600, color: entry.enabled ? AZURE_DEEP : INK_DIM, fontVariantNumeric: 'tabular-nums', lineHeight: 1.3 }}>
              {fmt(entry.forward_to)}
            </span>
          </span>
        </td>

        {/* Label */}
        <td style={{ padding: '15px 16px' }}>
          <span
            style={{
              display: 'block',
              maxWidth: 280,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: '0.85rem',
              color: entry.name ? INK_SOFT : '#a7b3c8',
              fontStyle: entry.name ? 'normal' : 'italic',
            }}
          >
            {entry.name ?? 'No label'}
          </span>
        </td>

        {/* Status */}
        <td style={{ padding: '15px 16px' }}>
          <StatusPill enabled={entry.enabled} />
        </td>

        {/* Customer (admin only) */}
        {isAdmin && (
          <td style={{ padding: '15px 16px' }}>
            <span
              style={{
                fontSize: '0.74rem',
                fontWeight: 600,
                color: INK_DIM,
                background: 'rgba(47,125,246,0.06)',
                border: '1px solid rgba(47,125,246,0.16)',
                borderRadius: 6,
                padding: '2px 9px',
                whiteSpace: 'nowrap',
              }}
            >
              {entry.customer_name ?? `ID ${entry.customer_id}`}
            </span>
          </td>
        )}
      </tr>

      {/* Expanded configuration panel — animated one-shot, inside table flow */}
      {expanded && (
        <tr>
          <td colSpan={colSpan} style={{ padding: 0, borderTop: 'none' }}>
            <div className="rcf-xwrap">
              <div>
                <RowEditor entry={entry} isAdmin={isAdmin} canEdit={canEdit} onClose={onCollapse} />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Page header ──────────────────────────────────────────────────────────────

interface RcfPageHeaderProps {
  title: string;
  subtitle: string;
  /** Secondary scope context shown as the last breadcrumb segment
      (admin: the selected customer / "All Customers"). */
  context?: string | null;
  /** False before an admin picks a scope — no figures to show yet. */
  showMetrics: boolean;
  /** Total forwards on the account (server total). */
  total: number;
  /** Enabled / disabled counts from the loaded entries. */
  active: number;
  disabled: number;
  /** False while the entries query is still loading or errored. */
  loaded: boolean;
}

/**
 * Quiet console header — set directly on the paper canvas, no framing card.
 * A small product breadcrumb, a calm Archivo title, a one-line description,
 * and the key figures as inline metrics separated by hairline rules. A single
 * 1px rule closes the zone. The only accent is the small azure tick on the
 * breadcrumb. Uses only data already loaded by the page.
 */
function RcfPageHeader({ title, subtitle, context, showMetrics, total, active, disabled, loaded }: RcfPageHeaderProps) {
  return (
    <header className="rcf-header fx-load">
      <div className="rcf-header-id">
        <div className="rcf-crumb">
          <span>Remote Call Forwarding</span>
          <span className="rcf-crumb-sep" aria-hidden="true">/</span>
          <span>Granite CRAG</span>
          {context && (
            <>
              <span className="rcf-crumb-sep" aria-hidden="true">/</span>
              <span className="rcf-crumb-context">{context}</span>
            </>
          )}
        </div>
        <h1 className="rcf-title">{title}</h1>
        <p className="rcf-sub">{subtitle}</p>
      </div>

      {showMetrics && (
        <div className="rcf-metrics">
          <div className="rcf-metric">
            <div className="rcf-metric-value">{loaded ? total.toLocaleString() : '—'}</div>
            <div className="rcf-metric-label">Forwards</div>
          </div>
          <div className="rcf-metric">
            <div className="rcf-metric-value">{loaded ? active.toLocaleString() : '—'}</div>
            <div className="rcf-metric-label">Enabled</div>
          </div>
          {loaded && disabled > 0 && (
            <div className="rcf-metric">
              <div className="rcf-metric-value">{disabled.toLocaleString()}</div>
              <div className="rcf-metric-label">Disabled</div>
            </div>
          )}
        </div>
      )}
    </header>
  );
}

// ─── Empty states ─────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div
      className="rcf-panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '80px 24px',
        gap: 16,
        textAlign: 'center',
      }}
    >
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: 14,
          background: '#e4eeff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 4,
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke={AZURE_DEEP} strokeWidth={1.6} style={{ width: 30, height: 30 }}>
          <path d="M3 5a2 2 0 0 1 2-2h3.28a1 1 0 0 1 .948.684l1.498 4.493a1 1 0 0 1-.502 1.21l-2.257 1.13a11.042 11.042 0 0 0 5.516 5.516l1.13-2.257a1 1 0 0 1 1.21-.502l4.493 1.498a1 1 0 0 1 .684.949V19a2 2 0 0 1-2 2h-1C9.716 21 3 14.284 3 6V5z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div>
        <p style={{ color: INK, fontSize: '1rem', fontWeight: 700, margin: '0 0 6px' }}>
          No numbers configured yet
        </p>
        <p style={{ color: INK_DIM, fontSize: '0.82rem', margin: 0, lineHeight: 1.6 }}>
          Contact support to provision Remote Call Forwarding numbers for your account.
        </p>
      </div>
    </div>
  );
}

function SearchEmptyState({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <div
      className="rcf-panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '60px 24px',
        gap: 12,
        textAlign: 'center',
      }}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        style={{ width: 36, height: 36, color: '#b6c2d4', marginBottom: 4 }}
      >
        <path d="m21 21-5.197-5.197M15.803 15.803A7.5 7.5 0 1 0 4.197 4.197a7.5 7.5 0 0 0 11.606 11.606Z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <p style={{ color: INK_SOFT, fontSize: '0.9rem', fontWeight: 500, margin: 0 }}>
        No numbers match &ldquo;{query}&rdquo;
      </p>
      <button
        type="button"
        onClick={onClear}
        style={{
          background: 'transparent',
          border: 'none',
          color: AZURE_DEEP,
          fontSize: '0.8rem',
          cursor: 'pointer',
          textDecoration: 'underline',
          fontFamily: 'inherit',
          padding: 0,
        }}
      >
        Clear filter
      </button>
    </div>
  );
}

// ─── Tab types ────────────────────────────────────────────────────────────────

type DashboardTab = 'numbers' | 'activity' | 'dids';

/**
 * Admin console scope — what the admin has chosen to look at.
 *   null      → nothing selected yet (the page opens empty; no data loads)
 *   'all'     → every customer's RCF numbers
 *   number    → one customer account id
 * Tenants never use this: they are always scoped to their own account.
 */
type AdminScope = null | 'all' | number;

// ─── ScopePrompt — the admin console's quiet pre-selection state ─────────────

function ScopePrompt({ message }: { message: string }) {
  return (
    <div className="rcf-panel rcf-scope-prompt fx-load fx-load-d2" role="status">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" strokeLinecap="round" />
      </svg>
      <p className="rcf-scope-prompt-title">{message}</p>
      <p className="rcf-scope-prompt-sub">Use the <strong>Viewing</strong> menu above to choose a customer, or All Customers.</p>
    </div>
  );
}

// ─── TabBar ───────────────────────────────────────────────────────────────────

interface TabBarProps {
  active: DashboardTab;
  onChange: (tab: DashboardTab) => void;
}

function TabBar({ active, onChange }: TabBarProps) {
  const tabs: { id: DashboardTab; label: string; icon: React.ReactNode }[] = [
    {
      id: 'numbers',
      label: 'Numbers',
      icon: (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 13, height: 13 }}>
          <rect x="2" y="2" width="5" height="5" rx="1.5" />
          <rect x="9" y="2" width="5" height="5" rx="1.5" />
          <rect x="2" y="9" width="5" height="5" rx="1.5" />
          <rect x="9" y="9" width="5" height="5" rx="1.5" />
        </svg>
      ),
    },
    {
      id: 'activity',
      label: 'Call Activity',
      icon: (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 13, height: 13 }}>
          <path d="M2 12 L4 8 L6 10 L9 5 L11 7 L14 3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ),
    },
    {
      id: 'dids',
      label: 'DID Management',
      icon: (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 13, height: 13 }}>
          <rect x="2" y="2" width="12" height="12" rx="2" />
          <path d="M5 8h6M8 5v6" strokeLinecap="round" />
        </svg>
      ),
    },
  ];

  return (
    <div className="rcf-tabs fx-load fx-load-d1" role="tablist">
      {tabs.map((tab) => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(tab.id)}
            className={isActive ? 'rcf-tab rcf-tab-active' : 'rcf-tab'}
          >
            <span
              style={{
                display: 'inline-flex',
                color: isActive ? 'var(--rcf-azure-deep)' : 'inherit',
                transition: 'color 0.15s ease',
              }}
            >
              {tab.icon}
            </span>
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}


// ─── Main Page ────────────────────────────────────────────────────────────────

/** `<select>` value → AdminScope ('' = placeholder, 'all', or a customer id). */
function parseScope(value: string): AdminScope {
  if (value === '') return null;
  if (value === 'all') return 'all';
  const id = Number(value);
  return Number.isInteger(id) ? id : null;
}

/**
 * /rcf entry point. Admins (not in "View as Customer") get the
 * Administrative Call Forwarding Console; a customer user — or an admin
 * previewing customer view, who then carries their own customer_id — gets
 * the full-page customer dashboard. Anyone else (e.g. support, which has no
 * customer of its own) keeps the console exactly as before.
 *
 * The two views are separate components so toggling customer view swaps
 * whole subtrees instead of changing this component's hook order (#310).
 */
export function RcfPage() {
  const { user, isAdmin } = useAuth();
  const dashboardCustomerId = !isAdmin ? (user?.customer_id ?? null) : null;
  if (dashboardCustomerId !== null) {
    return <CustomerDashboard key={dashboardCustomerId} customerId={dashboardCustomerId} />;
  }
  return <RcfConsole />;
}

function RcfConsole() {
  // ── All hooks unconditionally at top (React rules-of-hooks) ──────────────────
  const { user, isAdmin } = useAuth();

  // Tab state
  const [activeTab, setActiveTab] = useState<DashboardTab>('numbers');

  // Admin scope — starts EMPTY (null): nothing loads until the admin picks
  // "All Customers" or one account. Tenants are always ready (own account).
  const [adminScope, setAdminScope] = useState<AdminScope>(null);
  const scopeReady = !isAdmin || adminScope !== null;
  const adminCustomerId = typeof adminScope === 'number' ? adminScope : undefined;
  // customer_id filter for every scoped query: the admin's pick (undefined =
  // All Customers) or the tenant's own account.
  const customerId = isAdmin ? adminCustomerId : (user?.customer_id ?? undefined);

  // Customer list for the admin scope selector + the header title. Same query
  // key as other admin pages so React Query dedupes it. Only runs for admins.
  const { data: adminCustomersData } = useQuery({
    queryKey: ['customers-dropdown'],
    queryFn: () => listCustomers({ limit: 500 }),
    enabled: isAdmin,
    staleTime: 60_000,
  });
  const scopeCustomers = useMemo(
    () => (adminCustomersData?.items ?? []).filter((c) => ['rcf', 'hybrid'].includes(c.account_type)),
    [adminCustomersData],
  );
  const adminSelectedCustomerName = useMemo(() => {
    if (!isAdmin || adminCustomerId === undefined) return null;
    return adminCustomersData?.items.find((c) => c.id === adminCustomerId)?.name ?? null;
  }, [isAdmin, adminCustomerId, adminCustomersData]);

  // Numbers tab state
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sortField, setSortField] = useState<SortField>('did');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [npaFilter, setNpaFilter] = useState('');
  // Expandable-row state — one row open at a time
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Numbers query — gated on scope: an admin opening the page must NOT pull
  // every customer's numbers before choosing what to look at.
  const { data, isLoading, isError } = useQuery({
    queryKey: ['rcf', customerId ?? 'all', page, pageSize],
    queryFn: () => listRcf({ limit: pageSize, offset: (page - 1) * pageSize, customer_id: customerId }),
    enabled: scopeReady,
  });

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  // Derived Numbers tab values
  const rawEntries: RcfEntry[] = useMemo(() => data?.items ?? [], [data]);
  const serverTotal: number = data?.total ?? 0;

  const filteredEntries = useMemo(() => {
    let result = rawEntries;
    if (npaFilter.length === 3) {
      result = result.filter((e) => extractNpa(e.did) === npaFilter);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (e) =>
          e.did.includes(q) ||
          e.forward_to.toLowerCase().includes(q) ||
          (e.name ?? '').toLowerCase().includes(q) ||
          (e.customer_name ?? '').toLowerCase().includes(q),
      );
    }
    return result;
  }, [rawEntries, searchQuery, npaFilter]);

  const sortedEntries = useMemo(
    () => sortEntries(filteredEntries, sortField, sortDir),
    [filteredEntries, sortField, sortDir],
  );

  const role = user?.role ?? 'user';
  // readonly (customer view-only) and support (platform read-only) never edit.
  const canEdit = role !== 'readonly' && role !== 'support';
  const totalPages = Math.max(1, Math.ceil(serverTotal / pageSize));
  const activeCount = useMemo(() => rawEntries.filter((e) => e.enabled).length, [rawEntries]);
  const disabledCount = useMemo(() => rawEntries.filter((e) => !e.enabled).length, [rawEntries]);

  // ── Handlers ──────────────────────────────────────────────────────────────────

  function handleSearchInput(value: string) {
    setSearchInput(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setSearchQuery(value.trim());
      setPage(1);
    }, 250);
  }

  function handleScopeSelect(scope: AdminScope) {
    setAdminScope(scope);
    setPage(1);
    setSearchInput('');
    setSearchQuery('');
    setNpaFilter('');
    setExpandedId(null);
  }

  function handlePageChange(p: number) {
    setPage(p);
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

  // Header: admins get a FIXED console title with the scope as breadcrumb
  // context; tenants keep their account name (unchanged behavior).
  const pageTitle = isAdmin
    ? 'Administrative Call Forwarding Console'
    : (user?.customer_name ?? 'Call Forwarding Console');
  const headerContext = !isAdmin
    ? null
    : adminScope === 'all'
      ? 'All Customers'
      : adminCustomerId !== undefined
        ? (adminSelectedCustomerName ?? `Customer ${adminCustomerId}`)
        : null;
  const pageSubtitle = isAdmin && !scopeReady
    ? 'Select a customer to manage their forwarding destinations and monitor call health.'
    : 'Manage forwarding destinations and monitor call health across your numbers.';

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="rcf-scope">
      <div className="rcf-shell">
        {/* Quiet console header — breadcrumb, title, inline metrics, closing rule */}
        <RcfPageHeader
          title={pageTitle}
          subtitle={pageSubtitle}
          context={headerContext}
          showMetrics={scopeReady}
          total={serverTotal}
          active={activeCount}
          disabled={disabledCount}
          loaded={!isLoading && !isError}
        />

        {/* Admin customer scope — light select mirroring AdminCustomerSelector */}
        {isAdmin && (
          <div className="rcf-scopebar fx-load fx-load-d1">
            <span className="rcf-scopebar-label">Viewing</span>
            <select
              className="rcf-input"
              style={{ minWidth: 260, fontSize: '0.84rem' }}
              aria-label="Customer scope"
              value={adminScope === null ? '' : String(adminScope)}
              onChange={(e) => handleScopeSelect(parseScope(e.target.value))}
            >
              <option value="" disabled>Select a customer…</option>
              <option value="all">All Customers</option>
              {scopeCustomers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.account_type.toUpperCase()})
                </option>
              ))}
            </select>
            {adminScope !== null && (
              <button
                type="button"
                onClick={() => handleScopeSelect(null)}
                style={{
                  fontSize: '0.72rem',
                  color: INK_DIM,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  padding: 0,
                  fontFamily: 'inherit',
                }}
              >
                Clear
              </button>
            )}
          </div>
        )}

        {/* ── Admin pre-selection: nothing loads, nothing renders ── */}
        {!scopeReady && <ScopePrompt message="Select a customer to view their call forwarding numbers" />}

        {/* ── Tab navigation ──────────────────────────────────── */}
        {scopeReady && <TabBar active={activeTab} onChange={setActiveTab} />}

        {/* ── Numbers Tab ─────────────────────────────────────── */}
        {scopeReady && activeTab === 'numbers' && (
          <>
            {/* Toolbar: Search + NPA filter + count */}
            {!isLoading && !isError && (
              <div className="fx-load fx-load-d2" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
                {/* Search bar */}
                <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 200 }}>
                  <span
                    aria-hidden="true"
                    style={{
                      position: 'absolute',
                      left: 13,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      color: '#9aa9c0',
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
                    className="rcf-input"
                    value={searchInput}
                    onChange={(e) => handleSearchInput(e.target.value)}
                    placeholder="Filter by DID, name, or destination…"
                    style={{ width: '100%', padding: '9px 36px' }}
                  />
                  {searchInput && (
                    <button
                      type="button"
                      onClick={() => { setSearchInput(''); setSearchQuery(''); }}
                      style={{
                        position: 'absolute',
                        right: 10,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        background: 'rgba(47,125,246,0.08)',
                        border: '1px solid rgba(47,125,246,0.2)',
                        borderRadius: 5,
                        color: AZURE_DEEP,
                        cursor: 'pointer',
                        padding: '2px 5px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} style={{ width: 10, height: 10 }}>
                        <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                      </svg>
                    </button>
                  )}
                </div>

                {/* NPA (area code) filter */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <label style={{ fontSize: '0.68rem', fontWeight: 700, color: INK_DIM, whiteSpace: 'nowrap', letterSpacing: '0.06em' }}>
                    NPA
                  </label>
                  <input
                    type="text"
                    className="rcf-input rcf-input-mono"
                    value={npaFilter}
                    onChange={(e) => {
                      const v = e.target.value.replace(/\D/g, '').slice(0, 3);
                      setNpaFilter(v);
                      setPage(1);
                    }}
                    placeholder="617"
                    maxLength={3}
                    inputMode="numeric"
                    title="Filter by area code (NPA)"
                    style={{
                      width: 58,
                      textAlign: 'center',
                      letterSpacing: '0.08em',
                      color: npaFilter.length === 3 ? AZURE_DEEP : undefined,
                      borderColor: npaFilter.length === 3 ? 'rgba(47,125,246,0.55)' : undefined,
                    }}
                  />
                  {npaFilter && (
                    <button
                      type="button"
                      onClick={() => { setNpaFilter(''); setPage(1); }}
                      style={{
                        background: 'rgba(47,125,246,0.07)',
                        border: '1px solid rgba(47,125,246,0.18)',
                        borderRadius: 5,
                        color: AZURE_DEEP,
                        cursor: 'pointer',
                        padding: '3px 5px',
                        display: 'flex',
                        alignItems: 'center',
                      }}
                      title="Clear NPA filter"
                    >
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} style={{ width: 9, height: 9 }}>
                        <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                      </svg>
                    </button>
                  )}
                </div>

                {/* Count pill (shows filtered subset when a filter is active) */}
                {serverTotal > 0 && (searchQuery || npaFilter.length === 3) && filteredEntries.length !== rawEntries.length && (
                  <div
                    style={{
                      fontSize: '0.72rem',
                      fontWeight: 600,
                      color: AZURE_DEEP,
                      background: 'rgba(47,125,246,0.08)',
                      border: '1px solid rgba(47,125,246,0.22)',
                      borderRadius: 20,
                      padding: '5px 13px',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                      letterSpacing: '0.02em',
                    }}
                  >
                    {`${filteredEntries.length} of ${serverTotal} shown`}
                  </div>
                )}
              </div>
            )}

            {/* Loading */}
            {isLoading && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: INK_DIM, fontSize: '0.875rem', padding: '48px 0', justifyContent: 'center' }}>
                <Spinner size="sm" />
                <span>Loading your numbers…</span>
              </div>
            )}

            {/* Error */}
            {isError && (
              <div style={{ padding: '16px 20px', borderRadius: 12, background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.22)', color: RED, fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: 10 }}>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 16, height: 16, flexShrink: 0 }}>
                  <circle cx="8" cy="8" r="7" />
                  <path d="M8 5v3.5M8 10.5v.5" strokeLinecap="round" />
                </svg>
                Unable to load RCF numbers. Please try refreshing the page.
              </div>
            )}

            {/* Empty (no numbers at all) */}
            {!isLoading && !isError && rawEntries.length === 0 && <EmptyState />}

            {/* Search empty state */}
            {!isLoading && !isError && rawEntries.length > 0 && sortedEntries.length === 0 && searchQuery && (
              <SearchEmptyState query={searchQuery} onClear={() => { setSearchInput(''); setSearchQuery(''); }} />
            )}

            {/* Expandable-row number table — both admin and customer views */}
            {!isLoading && !isError && sortedEntries.length > 0 && (
              <div className="rcf-panel fx-load fx-load-d3">
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: isAdmin ? 760 : 640 }}>
                    <thead>
                      <tr>
                        <th className="rcf-th" style={{ width: 34, padding: '11px 4px 11px 18px' }} aria-label="Expand" />
                        <SortHeader label="Number"      field="did"        width={190} currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                        <SortHeader label="Forwards To" field="forward_to" width={230} currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                        <SortHeader label="Label"       field="name"                   currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                        <SortHeader label="Status"      field="status"     width={120} currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                        {isAdmin && (
                          <SortHeader label="Customer" field="customer" currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedEntries.map((entry) => (
                        <NumberRow
                          key={entry.id}
                          entry={entry}
                          isAdmin={isAdmin}
                          canEdit={canEdit}
                          expanded={expandedId === entry.id}
                          onToggle={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                          onCollapse={() => setExpandedId(null)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
                {serverTotal > pageSize && (
                  <PaginationControls
                    currentPage={page}
                    totalPages={totalPages}
                    pageSize={pageSize}
                    totalItems={serverTotal}
                    onPageChange={handlePageChange}
                    onPageSizeChange={(size) => { setPageSize(size); handlePageChange(1); }}
                  />
                )}
              </div>
            )}
          </>
        )}

        {/* ── Call Activity Tab ────────────────────────────────── */}
        {/* Keyed per scope so a DID / range picked under one customer
            never carries over to the next. */}
        {scopeReady && activeTab === 'activity' && (
          <CallActivityTab key={`activity-${customerId ?? 'all'}`} customerId={customerId} />
        )}

        {/* ── DID Management Tab ───────────────────────────────── */}
        {/* Inventory actions are per account — "All Customers" asks for one. */}
        {scopeReady && activeTab === 'dids' && (
          isAdmin && adminScope === 'all' ? (
            <ScopePrompt message="Select a single customer to manage their DIDs" />
          ) : (
            <DIDManagementTab
              customerId={customerId}
              filterToCustomer={isAdmin ? adminCustomerId : undefined}
              onShowNumbers={() => setActiveTab('numbers')}
            />
          )
        )}
      </div>
    </div>
  );
}
