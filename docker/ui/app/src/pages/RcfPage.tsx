/**
 * /rcf — call forwarding numbers. Three views, as separate components so
 * switching customer view or the previewed customer remounts instead of
 * changing hook order (React #310):
 *
 *  - a customer (tenant, or an admin previewing one in "View as Customer"):
 *    the numbers manager for that account (CustomerNumbersPage), keyed by id;
 *  - an admin in customer view with no preview picked yet: PreviewPrompt;
 *  - admin / support: the Administrative Call Forwarding Console below.
 *
 * The console wears the account dashboard's look so the app reads as one:
 * the granite DashboardHeader with the "Viewing" scope dropdown in it,
 * card-styled panels, the dashboard numbers table, the brand blue family.
 *
 *   ┌ Granite header (one row): Remote call forwarding [Staff]                       ┐
 *   │ Administrative Call Forwarding Console              [Viewing ▾] [Open dashboard] │
 *   │ Viewing All customers                                                            │
 *   [ Numbers | Call activity | DID management ]          42 FORWARDS | 40 | 2 PAUSED
 *     (segmented tab rail; the view's figures on the same row, right)
 *   ┌ Numbers card: title · search · area code (one row) · table (sortable, heads sticky,
 *   │ rows → RowEditor) · paging pinned in the footer — ends at the bottom of the screen ┐
 *
 * Layout (docker/ui/CLAUDE.md §20): the Numbers card is bounded to the first
 * screen (useViewportFit) and scrolls inside, so search, sort, paging and an
 * open editor stay on screen at 100 rows; Call activity caps its call log and
 * DID management its tables (each "Show all" opens inside a capped scroll).
 *
 * Scope (admins) lives in the URL: `?customer=all` or `?customer=<id>`;
 * absent = nothing chosen yet (nothing loads). The dashboard and its links
 * deep-link here with the scope pre-selected.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { LayoutDashboard } from 'lucide-react';
import { useViewportFit } from '../components/layout/kit';
import { listRcf } from '../api/rcf';
import type { RcfEntry } from '../types/rcf';
import { useAuth } from '../contexts/AuthContext';
import { fmt } from '../utils/format';
import { DEFAULT_PAGE_SIZE } from './rcf/theme';
import { PaginationControls } from './rcf/PaginationControls';
import { CallActivityTab } from './rcf/CallActivityTab';
import { RowEditor } from './rcf/RowEditor';
import { DIDManagementTab } from './rcf/DidManagement';
import { extractNpa } from './rcf/didFormat';
import { CustomerNumbersPage } from './rcf/CustomerNumbersPage';
import { PreviewPrompt } from './dashboard/PreviewPrompt';
import { DashboardHeader, type HeaderAction } from './dashboard/DashboardHeader';
import { AdminScopeSelect, type AdminScopeValue } from './dashboard/AdminScopeSelect';
import { Card, CardState } from './dashboard/Card';
import { hasCallForwarding, useAdminCustomers } from './dashboard/adminData';
import { dashboardHref } from './dashboard/adminLinks';
import { RCF_LIST_CAP } from './dashboard/accountData';
import '../styles/rcf-dashboard.css';
import '../styles/account-dashboard.css';

// ─── Types & helpers ──────────────────────────────────────────────────────────

type SortField = 'did' | 'name' | 'forward_to' | 'customer' | 'status';
type SortDir = 'asc' | 'desc';
type ConsoleTab = 'numbers' | 'activity' | 'dids';

function sortEntries(entries: readonly RcfEntry[], field: SortField, dir: SortDir): RcfEntry[] {
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

/** `?customer=` → console scope: absent = not chosen yet, 'all', or an id. */
function parseConsoleScope(raw: string | null): AdminScopeValue {
  if (raw === null || raw === '') return null;
  if (raw === 'all') return 'all';
  if (!/^\d{1,9}$/.test(raw)) return null;
  const id = Number(raw);
  return id > 0 ? id : null;
}

// ─── Route entry ──────────────────────────────────────────────────────────────

export function RcfPage() {
  const { isAdmin, isActualAdmin, isSupport, customerViewMode, effectiveCustomer } = useAuth();
  if (!isAdmin && effectiveCustomer) {
    return (
      <CustomerNumbersPage
        key={effectiveCustomer.id}
        customer={effectiveCustomer}
        staff={isActualAdmin || isSupport}
      />
    );
  }
  if (isActualAdmin && customerViewMode) return <PreviewPrompt />;
  return <RcfConsole />;
}

// ─── Console shell (header + scope + tabs) ────────────────────────────────────

function RcfConsole() {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const { user, isAdmin, isSupport } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<ConsoleTab>('numbers');
  const customers = useAdminCustomers(isAdmin);

  const adminScope = isAdmin ? parseConsoleScope(params.get('customer')) : null;
  const scopeReady = !isAdmin || adminScope !== null;
  const adminCustomerId = typeof adminScope === 'number' ? adminScope : undefined;
  // customer_id for every scoped query: the admin's pick (undefined = All
  // customers) or, for support, the platform (support has no account).
  const customerId = isAdmin ? adminCustomerId : (user?.customer_id ?? undefined);

  const scopeCustomers = useMemo(
    () => (customers.data ?? []).filter((c) => hasCallForwarding(c.account_type) && c.account_type !== 'ucaas'),
    [customers.data],
  );

  const selectScope = useCallback(
    (next: number | 'all') => {
      setParams((prev) => {
        const p = new URLSearchParams(prev);
        p.set('customer', String(next));
        return p;
      });
    },
    [setParams],
  );

  // Figures beside the tab rail come from the Numbers body (it owns the query).
  const [figures, setFigures] = useState<ConsoleFigures | null>(null);

  // ── Derived (after all hooks) ──
  const customerName =
    adminCustomerId !== undefined
      ? (customers.data?.find((c) => c.id === adminCustomerId)?.name ?? `Customer #${adminCustomerId}`)
      : null;
  const context = !isAdmin ? 'Every customer' : adminScope === 'all' ? 'All customers' : customerName;

  const secondary: HeaderAction | null =
    isAdmin && scopeReady
      ? {
          label: 'Open dashboard',
          icon: <LayoutDashboard size={14} strokeWidth={2.2} aria-hidden="true" />,
          onClick: () => navigate(dashboardHref(adminScope)),
        }
      : null;

  const scopeKey = adminScope === null ? 'none' : String(adminScope);

  return (
    <div className="rcf-scope ad-scope rcfc">
      <div className="ad-shell">
        <DashboardHeader
          name="Administrative Call Forwarding Console"
          status={null}
          since={null}
          kicker="Remote call forwarding"
          tag={isAdmin ? 'Staff' : isSupport ? 'Support' : null}
          meta={
            context ? (
              <span className="rcfc-context">
                Viewing <strong>{context}</strong>
              </span>
            ) : (
              <span>Pick a customer, or All customers, to see their numbers.</span>
            )
          }
          scope={
            isAdmin ? (
              <AdminScopeSelect
                value={adminScope}
                onChange={selectScope}
                customers={scopeCustomers}
                loading={customers.isLoading}
                error={customers.isError}
              />
            ) : undefined
          }
          secondary={secondary}
        />

        {!scopeReady ? (
          <ScopePrompt message="Select a customer to view their call forwarding numbers" />
        ) : (
          <>
            {/* The tab rail and the view's figures share one row, so the
                granite band above stays one row (identity | picker). */}
            <div className="rcfc-railrow">
              <ConsoleTabs active={activeTab} onChange={setActiveTab} />
              <HeaderFigures figures={figures} />
            </div>

            {/* Numbers stays mounted (hidden) so its figures feed the rail
                on every tab; keyed per scope so search/sort/paging reset. */}
            <div hidden={activeTab !== 'numbers'} role="tabpanel" id="rcfc-panel-numbers" aria-labelledby="rcfc-tab-numbers">
              <NumbersPanel
                key={`numbers-${scopeKey}`}
                customerId={customerId}
                showCustomer={isAdmin && adminScope === 'all'}
                isAdmin={isAdmin}
                canEdit={(user?.role ?? 'user') !== 'readonly' && (user?.role ?? 'user') !== 'support'}
                onFigures={setFigures}
              />
            </div>

            {activeTab === 'activity' && (
              <div role="tabpanel" id="rcfc-panel-activity" aria-labelledby="rcfc-tab-activity">
                {/* Keyed per scope so a DID / range picked under one customer
                    never carries over to the next. */}
                <CallActivityTab key={`activity-${scopeKey}`} customerId={customerId} />
              </div>
            )}

            {activeTab === 'dids' && (
              <div role="tabpanel" id="rcfc-panel-dids" aria-labelledby="rcfc-tab-dids">
                {/* Inventory actions are per account — "All customers" asks for one. */}
                {isAdmin && adminScope === 'all' ? (
                  <ScopePrompt message="Select a single customer to manage their DIDs" />
                ) : (
                  <DIDManagementTab
                    key={`dids-${scopeKey}`}
                    customerId={customerId}
                    filterToCustomer={isAdmin ? adminCustomerId : undefined}
                    onShowNumbers={() => setActiveTab('numbers')}
                  />
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── View figures (beside the tab rail) ───────────────────────────────────────

interface ConsoleFigures {
  total: number;
  forwarding: number;
  paused: number;
  /** GET /rcf hit its 100-row cap. */
  capped: boolean;
}

/** Figure over label, hairline-divided — the kit's header-stats look, beside the tab rail. */
function HeaderFigures({ figures }: { figures: ConsoleFigures | null }) {
  const items: { label: string; value: string; title?: string }[] = [
    {
      label: 'Forwards',
      value: figures ? `${figures.total.toLocaleString()}${figures.capped ? '+' : ''}` : '—',
      title: figures?.capped ? 'The list shows the first 100' : undefined,
    },
    { label: 'Forwarding', value: figures ? figures.forwarding.toLocaleString() : '—' },
    { label: 'Paused', value: figures ? figures.paused.toLocaleString() : '—' },
  ];
  return (
    <dl className="rcfc-figures" aria-label="Numbers in this view">
      {items.map((f) => (
        <div key={f.label} title={f.title}>
          <dt>{f.label}</dt>
          <dd>{f.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ─── Scope prompt ─────────────────────────────────────────────────────────────

function ScopePrompt({ message }: { message: string }) {
  return (
    <section className="ad-card ad-prompt ad-rise" style={{ '--i': 1 } as CSSProperties} role="status">
      <span className="ad-prompt-icon rcfc-prompt-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} width={22} height={22}>
          <circle cx="12" cy="8" r="3.5" />
          <path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" strokeLinecap="round" />
        </svg>
      </span>
      <h2 className="ad-prompt-title">{message}</h2>
      <p className="ad-quiet">
        Use the <strong>Viewing</strong> menu in the header to choose a customer, or All customers.
      </p>
    </section>
  );
}

// ─── Tabs — a segmented rail, same family as the dashboard's chips ───────────

const TABS: { id: ConsoleTab; label: string; icon: ReactNode }[] = [
  {
    id: 'numbers',
    label: 'Numbers',
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
        <rect x="2" y="2" width="5" height="5" rx="1.5" />
        <rect x="9" y="2" width="5" height="5" rx="1.5" />
        <rect x="2" y="9" width="5" height="5" rx="1.5" />
        <rect x="9" y="9" width="5" height="5" rx="1.5" />
      </svg>
    ),
  },
  {
    id: 'activity',
    label: 'Call activity',
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
        <path d="M2 12 L4 8 L6 10 L9 5 L11 7 L14 3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'dids',
    label: 'DID management',
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
        <rect x="2" y="2" width="12" height="12" rx="2" />
        <path d="M5 8h6M8 5v6" strokeLinecap="round" />
      </svg>
    ),
  },
];

function ConsoleTabs({ active, onChange }: { active: ConsoleTab; onChange: (tab: ConsoleTab) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div className="rcfc-tabs-scroll ad-rise" style={{ '--i': 1 } as CSSProperties}>
      <div className="rcfc-tabs" role="tablist" aria-label="Console sections">
        {TABS.map((tab, i) => {
          const isActive = active === tab.id;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              id={`rcfc-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`rcfc-panel-${tab.id}`}
              tabIndex={isActive ? 0 : -1}
              className={isActive ? 'rcfc-tab rcfc-tab-active' : 'rcfc-tab'}
              onClick={() => onChange(tab.id)}
              onKeyDown={(e) => {
                // Arrow keys move between tabs (WAI-ARIA tabs pattern).
                if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                e.preventDefault();
                const next = (i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
                onChange(TABS[next].id);
                refs.current[next]?.focus();
              }}
            >
              {tab.icon}
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Numbers panel ────────────────────────────────────────────────────────────

interface NumbersPanelProps {
  customerId: number | undefined;
  /** All customers: add the Customer column. */
  showCustomer: boolean;
  isAdmin: boolean;
  canEdit: boolean;
  onFigures: (figures: ConsoleFigures | null) => void;
}

function NumbersPanel({ customerId, showCustomer, isAdmin, canEdit, onFigures }: NumbersPanelProps) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sortField, setSortField] = useState<SortField>('did');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [npaFilter, setNpaFilter] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  // The card ends at the bottom of the first screen (--lk-md-top on the
  // wrapper, rcf-dashboard.css `.rcfc-fit`); its table scrolls inside.
  const fitRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useViewportFit(fitRef);

  // GET /rcf ignores limit/offset and returns at most 100 rows, so the list
  // is fetched once per scope and paged here in the browser.
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['rcf', customerId ?? 'all', 'console'],
    queryFn: () => listRcf({ customer_id: customerId }),
  });

  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  const rawEntries = useMemo(() => data?.items ?? [], [data]);

  const filteredEntries = useMemo(() => {
    let result = rawEntries;
    if (npaFilter.length === 3) result = result.filter((e) => extractNpa(e.did) === npaFilter);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const qDigits = q.replace(/\D/g, '');
      result = result.filter(
        (e) =>
          e.did.includes(q) ||
          (qDigits.length >= 2 && (e.did.replace(/\D/g, '').includes(qDigits) || e.forward_to.replace(/\D/g, '').includes(qDigits))) ||
          e.forward_to.toLowerCase().includes(q) ||
          (e.name ?? '').toLowerCase().includes(q) ||
          (e.customer_name ?? '').toLowerCase().includes(q),
      );
    }
    return result;
  }, [rawEntries, searchQuery, npaFilter]);

  const sortedEntries = useMemo(() => sortEntries(filteredEntries, sortField, sortDir), [filteredEntries, sortField, sortDir]);

  useEffect(() => {
    if (!data) {
      onFigures(null);
      return;
    }
    const forwarding = data.items.filter((e) => e.enabled).length;
    onFigures({
      total: data.items.length,
      forwarding,
      paused: data.items.length - forwarding,
      capped: data.items.length >= RCF_LIST_CAP,
    });
  }, [data, onFigures]);

  // ── Derived (after all hooks) ──
  const totalPages = Math.max(1, Math.ceil(sortedEntries.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = sortedEntries.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const filtersActive = searchQuery !== '' || npaFilter.length === 3;
  const colCount = showCustomer ? 6 : 5; // incl. the chevron column

  /** A new page / filter starts at the top of the list. */
  function toTop() {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }

  function handleSearchInput(value: string) {
    setSearchInput(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setSearchQuery(value.trim());
      setPage(1);
      setExpandedId(null);
      toTop();
    }, 250);
  }

  function clearFilters() {
    setSearchInput('');
    setSearchQuery('');
    setNpaFilter('');
    setPage(1);
    toTop();
  }

  function handleSort(field: SortField) {
    if (sortField === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortField(field);
      setSortDir('asc');
    }
  }

  const sortProps = { currentField: sortField, currentDir: sortDir, onSort: handleSort };

  const footer =
    sortedEntries.length > 0 ? (
      <div className="ad-foot-split rcfc-foot">
        <span className="ad-faint">
          {filtersActive
            ? `${sortedEntries.length.toLocaleString()} of ${rawEntries.length.toLocaleString()} match`
            : `${rawEntries.length.toLocaleString()} ${rawEntries.length === 1 ? 'number' : 'numbers'}`}
          {rawEntries.length >= RCF_LIST_CAP && ' · the list shows the newest 100'}
        </span>
        {sortedEntries.length > pageSize || pageSize !== DEFAULT_PAGE_SIZE ? (
          <PaginationControls
            currentPage={currentPage}
            totalPages={totalPages}
            pageSize={pageSize}
            totalItems={sortedEntries.length}
            onPageChange={(p) => {
              setPage(p);
              setExpandedId(null);
              toTop();
            }}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
              setExpandedId(null);
              toTop();
            }}
          />
        ) : null}
      </div>
    ) : undefined;

  const toolbar =
    data && rawEntries.length > 0 ? (
      <div className="rcfc-toolbar">
        <label className="ad-search">
          <span className="ad-visually-hidden">Search numbers</span>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path d="m19 19-4.35-4.35M15 9A6 6 0 1 1 3 9a6 6 0 0 1 12 0Z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <input
            type="search"
            value={searchInput}
            onChange={(e) => handleSearchInput(e.target.value)}
            placeholder={showCustomer ? 'Search number, label, destination or customer' : 'Search number, label or destination'}
          />
        </label>
        <label className="rcfc-npa">
          <span>Area code</span>
          <input
            type="text"
            value={npaFilter}
            onChange={(e) => {
              setNpaFilter(e.target.value.replace(/\D/g, '').slice(0, 3));
              setPage(1);
              setExpandedId(null);
              toTop();
            }}
            placeholder="617"
            maxLength={3}
            inputMode="numeric"
            className={npaFilter.length === 3 ? 'rcfc-npa-on' : undefined}
          />
        </label>
        {filtersActive && (
          <button type="button" className="ad-linkbtn" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>
    ) : undefined;

  return (
    <div ref={fitRef} className="rcfc-fit">
      <Card
        id="rcfc-numbers"
        title="Numbers"
        count={data ? rawEntries.length : null}
        sub={canEdit ? 'Select a number to change where it rings.' : 'Select a number to see its settings.'}
        className="rcfc-card"
        order={2}
        action={toolbar}
        footer={footer}
      >
        {isLoading ? (
          <CardState kind="loading">Loading numbers…</CardState>
        ) : isError ? (
          <CardState kind="error" onRetry={() => void refetch()}>We couldn’t load the numbers.</CardState>
        ) : rawEntries.length === 0 ? (
          <div className="ad-empty">
            <p className="ad-empty-title">No call forwarding numbers here yet</p>
            <p className="ad-empty-sub">Numbers appear once they’re assigned to the account in the number inventory.</p>
          </div>
        ) : sortedEntries.length === 0 ? (
          <div className="ad-empty">
            <p className="ad-empty-title">{searchQuery ? `No numbers match “${searchQuery}”` : 'No numbers in this area code'}</p>
            <button type="button" className="ad-btn ad-btn-quiet" onClick={clearFilters}>
              Clear search and filters
            </button>
          </div>
        ) : (
          <div ref={scrollRef} className="ad-tablewrap rcfc-tablewrap">
            <table className={`ad-table rcfc-table${showCustomer ? ' rcfc-table-cust' : ''}`}>
              <thead>
                <tr>
                  <SortHeader label="Number" field="did" {...sortProps} />
                  <SortHeader label="Forwards to" field="forward_to" {...sortProps} />
                  <SortHeader label="Label" field="name" className="rcfc-col-label" {...sortProps} />
                  <SortHeader label="Status" field="status" {...sortProps} />
                  {showCustomer && <SortHeader label="Customer" field="customer" {...sortProps} />}
                  <th scope="col" className="ad-col-chev"><span className="ad-visually-hidden">Details</span></th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((entry) => (
                  <NumberRow
                    key={entry.id}
                    entry={entry}
                    showCustomer={showCustomer}
                    isAdmin={isAdmin}
                    canEdit={canEdit}
                    colCount={colCount}
                    expanded={expandedId === entry.id}
                    onToggle={() => setExpandedId((cur) => (cur === entry.id ? null : entry.id))}
                    onCollapse={() => setExpandedId(null)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── Sortable header — a real button, so it's keyboard reachable ─────────────

interface SortHeaderProps {
  label: string;
  field: SortField;
  currentField: SortField;
  currentDir: SortDir;
  onSort: (field: SortField) => void;
  className?: string;
}

function SortHeader({ label, field, currentField, currentDir, onSort, className }: SortHeaderProps) {
  const isActive = currentField === field;
  return (
    <th
      scope="col"
      className={className}
      aria-sort={isActive ? (currentDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button type="button" className={`rcfc-sort${isActive ? ' rcfc-sort-active' : ''}`} onClick={() => onSort(field)}>
        {label}
        <span aria-hidden="true" className="rcfc-sort-glyph">
          {isActive ? (currentDir === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </button>
    </th>
  );
}

// ─── One number row + its inline RowEditor ────────────────────────────────────

interface NumberRowProps {
  entry: RcfEntry;
  showCustomer: boolean;
  isAdmin: boolean;
  canEdit: boolean;
  colCount: number;
  expanded: boolean;
  onToggle: () => void;
  onCollapse: () => void;
}

function NumberRow({ entry, showCustomer, isAdmin, canEdit, colCount, expanded, onToggle, onCollapse }: NumberRowProps) {
  // ALL hooks unconditionally at the top (React #310).
  const editorRef = useRef<HTMLTableRowElement>(null);
  // An opened editor brings itself into view inside the card's scroll.
  useEffect(() => {
    if (expanded) editorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [expanded]);

  const editorId = `rcfc-editor-${entry.id}`;
  return (
    <>
      <tr
        className={`ad-row${expanded ? ' ad-row-open' : ''}${entry.enabled ? '' : ' rcfc-row-off'}`}
        tabIndex={0}
        aria-expanded={expanded}
        aria-controls={expanded ? editorId : undefined}
        aria-label={`${fmt(entry.did)}${entry.name ? `, ${entry.name}` : ''}, ${entry.enabled ? 'forwarding' : 'paused'} to ${fmt(
          entry.forward_to,
        )}${showCustomer && entry.customer_name ? `, ${entry.customer_name}` : ''}. ${canEdit ? 'Edit' : 'View'} settings`}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          } else if (e.key === 'Escape' && expanded) {
            e.preventDefault();
            onCollapse();
          }
        }}
      >
        <td>
          <span className="ad-num">{fmt(entry.did)}</span>
        </td>
        <td>
          <span className="ad-stack">
            <span className="ad-num ad-num-dest">{fmt(entry.forward_to)}</span>
            <span className="ad-faint">
              {`Rings ${entry.ring_timeout}s`}
            </span>
          </span>
        </td>
        <td className="rcfc-col-label">
          <span className={`rcfc-label${entry.name ? '' : ' ad-faint ad-italic'}`}>{entry.name ?? 'No label'}</span>
        </td>
        <td>
          <span className={`ad-status ad-status-${entry.enabled ? 'on' : 'off'}`}>
            <span className="ad-dot" aria-hidden="true" />
            {entry.enabled ? 'Forwarding' : 'Paused'}
          </span>
        </td>
        {showCustomer && (
          <td>
            <span className="ad-cust ad-ellipsis rcfc-cust">{entry.customer_name ?? `#${entry.customer_id}`}</span>
          </td>
        )}
        <td className="ad-col-chev">
          <svg className="ad-chev" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </td>
      </tr>
      {expanded && (
        <tr ref={editorRef} className="ad-editor-row">
          <td colSpan={colCount} id={editorId}>
            <div className="ad-editor rcf-xwrap">
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
