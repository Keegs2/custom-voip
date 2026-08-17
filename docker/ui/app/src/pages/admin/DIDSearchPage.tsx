/**
 * DIDSearchPage — cross-product DID inventory / number management
 * (/admin/platform/dids).
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` in index.css, plus the
 * admin `dlx-*` layer in styles/dl-admin.css, the platform `dlx2-*` layer in
 * styles/dl-platform.css, and the page-scoped `dlx4-*` layer in
 * styles/dl-platform-b.css). Renders INSIDE the PlatformManagementPage shell,
 * which owns the paper canvas (`dl-scope`) — this page contributes only the
 * section identity, the stat-tile strip, the tab control, and the inventory
 * panels. Status tags keep their semantics on paper (available=azure,
 * assigned=green, reserved=amber, suspended=red, porting=slate,
 * release_requested=sky — the distinct lifecycle state).
 *
 * All queries, mutations, filters, pagination, and the release-request
 * approve/deny flows are unchanged.
 *
 * React #310: every hook is called unconditionally at the top.
 */
import { useEffect, useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Phone,
  RefreshCw,
  Search,
  X,
  Users,
  CheckCircle,
  Clock,
  AlertCircle,
  ArrowRightLeft,
  Ban,
  Undo2,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/ToastContext';
import { fmt } from '../../utils/format';
import {
  listDidInventory,
  listAvailableDids,
  listMyDids,
  getDidStats,
  syncDidInventory,
  assignDid,
  unassignDid,
  requestDid,
  cancelDidRelease,
} from '../../api/didInventory';
import { listCustomers } from '../../api/customers';
import type { DidInventoryItem, DidStatus } from '../../types/didInventory';
import '../../styles/dl-admin.css';
import '../../styles/dl-platform.css';
import '../../styles/dl-platform-b.css';

// ─── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

const PRODUCT_TYPES = [
  { value: 'rcf', label: 'Remote Call Forwarding (RCF)' },
  { value: 'api', label: 'API Calling' },
  { value: 'trunk', label: 'SIP Trunk' },
  { value: 'ucaas', label: 'UCaaS' },
];

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
  'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
  'DC',
];

// Light-tuned accents for the stat-tile keylines (semantics preserved).
const ACCENT_AZURE = 'var(--rcf-azure)';
const ACCENT_GREEN = '#16a34a';
const ACCENT_AMBER = '#d97706';
const ACCENT_SKY = '#0284c7';

// ─── Status tag ─────────────────────────────────────────────────────────────────

interface StatusStyle {
  /** Tone modifier combined with the shared .dl-tag base. */
  toneClass: string;
  label: string;
  icon: React.ReactNode;
}

function getStatusStyle(status: DidStatus): StatusStyle {
  switch (status) {
    case 'available':
      return { toneClass: '', label: 'Available', icon: <CheckCircle size={11} /> };
    case 'assigned':
      return { toneClass: 'dlx4-tag-green', label: 'Assigned', icon: <CheckCircle size={11} /> };
    case 'reserved':
      return { toneClass: 'dlx4-tag-amber', label: 'Reserved', icon: <Clock size={11} /> };
    case 'porting_in':
      return { toneClass: 'dl-tag-slate', label: 'Porting In', icon: <ArrowRightLeft size={11} /> };
    case 'porting_out':
      return { toneClass: 'dl-tag-slate', label: 'Porting Out', icon: <ArrowRightLeft size={11} /> };
    case 'suspended':
      return { toneClass: 'dlx4-tag-red', label: 'Suspended', icon: <Ban size={11} /> };
    case 'release_requested':
      return { toneClass: 'dlx4-tag-sky', label: 'Release Requested', icon: <Undo2 size={11} /> };
    default:
      return { toneClass: 'dl-tag-slate', label: status, icon: <AlertCircle size={11} /> };
  }
}

function StatusBadge({ status }: { status: DidStatus }) {
  const s = getStatusStyle(status);
  return (
    <span className={`dl-tag dlx4-stag ${s.toneClass}`.trim()}>
      {s.icon}
      {s.label}
    </span>
  );
}

// ─── Product tag ────────────────────────────────────────────────────────────────

function ProductPill({ type }: { type: string }) {
  return <span className="dl-tag">{type.toUpperCase()}</span>;
}

// ─── Mono DID cell ──────────────────────────────────────────────────────────────

function DidCell({ did }: { did: string }) {
  return (
    <span
      className="dlx4-mono"
      style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--rcf-azure-deep)' }}
    >
      {fmt(did)}
    </span>
  );
}

// ─── Stat tile ──────────────────────────────────────────────────────────────────

interface StatTileProps {
  label: string;
  value: number | string;
  accent: string;
  icon: React.ReactNode;
}

function DidStatTile({ label, value, accent, icon }: StatTileProps) {
  return (
    <div className="dl-tile" style={{ boxShadow: `inset 3px 0 0 0 ${accent}` }}>
      <div className="dl-tile-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: accent, display: 'inline-flex' }}>{icon}</span>
        {label}
      </div>
      <div className="dl-tile-value">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  );
}

// ─── Daylight modal (local — the shared Modal is dark-glass) ────────────────────

interface DaylightModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

function DaylightModal({ open, onClose, title, children, footer }: DaylightModalProps) {
  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Prevent body scroll while modal is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  if (!open) return null;

  return (
    <div className="dlx4-modal-backdrop" role="dialog" aria-modal="true">
      <div
        style={{ position: 'absolute', inset: 0 }}
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="dlx4-modal">
        <div className="dlx4-modal-head">
          <h2 className="dlx4-modal-title">{title}</h2>
          <button
            type="button"
            className="dlx4-modal-close"
            onClick={onClose}
            aria-label="Close modal"
          >
            <X size={14} />
          </button>
        </div>
        <div className="dlx4-modal-body">{children}</div>
        {footer && <div className="dlx4-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ─── Filter bar ─────────────────────────────────────────────────────────────────

interface FilterBarProps {
  search: string;
  onSearchChange: (v: string) => void;
  statusFilter: DidStatus | '';
  onStatusChange: (v: DidStatus | '') => void;
  stateFilter: string;
  onStateChange: (v: string) => void;
  placeholder?: string;
  hideStatus?: boolean;
}

function FilterBar({
  search,
  onSearchChange,
  statusFilter,
  onStatusChange,
  stateFilter,
  onStateChange,
  placeholder = 'Search DID, city, rate center…',
  hideStatus = false,
}: FilterBarProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 10,
        padding: '12px 20px',
        borderBottom: '1px solid var(--rcf-line)',
        background: 'var(--rcf-tint)',
        alignItems: 'center',
      }}
    >
      {/* Search */}
      <div className="dlx-searchwrap">
        <Search size={14} />
        <input
          type="text"
          className="dl-input"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={placeholder}
          style={{ width: '100%', paddingLeft: 34 }}
        />
        {search && (
          <button
            type="button"
            className="dlx-search-clear"
            onClick={() => onSearchChange('')}
            aria-label="Clear search"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {/* State filter */}
      <select
        className="dl-input"
        value={stateFilter}
        onChange={(e) => onStateChange(e.target.value)}
        style={{ minWidth: 110 }}
      >
        <option value="">All States</option>
        {US_STATES.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>

      {/* Status filter */}
      {!hideStatus && (
        <select
          className="dl-input"
          value={statusFilter}
          onChange={(e) => onStatusChange(e.target.value as DidStatus | '')}
          style={{ minWidth: 150 }}
        >
          <option value="">All Statuses</option>
          <option value="available">Available</option>
          <option value="assigned">Assigned</option>
          <option value="release_requested">Release Requested</option>
          <option value="reserved">Reserved</option>
          <option value="porting_in">Porting In</option>
          <option value="porting_out">Porting Out</option>
          <option value="suspended">Suspended</option>
        </select>
      )}
    </div>
  );
}

// ─── Assign Modal ───────────────────────────────────────────────────────────────

interface AssignModalProps {
  did: DidInventoryItem | null;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

function AssignModal({ did, open, onClose, onSuccess }: AssignModalProps) {
  // ALL hooks unconditionally at the top — no exceptions (React #310 prevention)
  const [customerId, setCustomerId] = useState('');
  const [productType, setProductType] = useState('rcf');
  const [notes, setNotes] = useState('');
  const { toastOk, toastErr } = useToast();
  const queryClient = useQueryClient();

  const { data: customersData, isLoading: customersLoading } = useQuery({
    queryKey: ['customers-dropdown'],
    queryFn: () => listCustomers({ limit: 500 }),
    enabled: open,
  });

  const assignMutation = useMutation({
    mutationFn: () =>
      assignDid(did!.did, {
        customer_id: Number(customerId),
        product_type: productType,
        notes: notes.trim() || undefined,
      }),
    onSuccess: () => {
      toastOk(`${fmt(did!.did)} assigned successfully`);
      void queryClient.invalidateQueries({ queryKey: ['did-inventory'] });
      void queryClient.invalidateQueries({ queryKey: ['did-stats'] });
      void queryClient.invalidateQueries({ queryKey: ['did-available'] });
      setCustomerId('');
      setProductType('rcf');
      setNotes('');
      onSuccess();
      onClose();
    },
    onError: (err: Error) => {
      toastErr(err.message ?? 'Failed to assign number');
    },
  });

  // Guard AFTER all hooks
  if (!did) return null;

  const customers = customersData?.items ?? [];
  const pending = assignMutation.isPending;

  return (
    <DaylightModal
      open={open}
      onClose={onClose}
      title={`Assign ${fmt(did.did)}`}
      footer={
        <>
          <button type="button" className="dl-btn dl-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="dl-btn dl-btn-primary"
            disabled={!customerId || pending}
            onClick={() => assignMutation.mutate()}
          >
            {pending ? 'Assigning…' : 'Assign Number'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* DID info row */}
        <div className="dlx-well" style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Phone size={15} style={{ color: 'var(--rcf-azure-deep)', flexShrink: 0 }} />
          <div>
            <div
              className="dlx4-mono"
              style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--rcf-ink)' }}
            >
              {fmt(did.did)}
            </div>
            {(did.city || did.state) && (
              <div style={{ fontSize: '0.72rem', color: 'var(--rcf-ink-dim)', marginTop: 2 }}>
                {[did.city, did.state].filter(Boolean).join(', ')}
                {did.rate_center && ` · ${did.rate_center}`}
              </div>
            )}
          </div>
        </div>

        {/* Customer selector */}
        <div>
          <label className="dl-flabel">Customer</label>
          <select
            className="dl-input"
            style={{ width: '100%' }}
            required
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            disabled={customersLoading}
          >
            <option value="">
              {customersLoading ? 'Loading customers…' : 'Select a customer'}
            </option>
            {customers.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {/* Product type selector */}
        <div>
          <label className="dl-flabel">Product Type</label>
          <select
            className="dl-input"
            style={{ width: '100%' }}
            required
            value={productType}
            onChange={(e) => setProductType(e.target.value)}
          >
            {PRODUCT_TYPES.map((pt) => (
              <option key={pt.value} value={pt.value}>
                {pt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Notes */}
        <div>
          <label className="dl-flabel">Notes (optional)</label>
          <textarea
            className="dl-input"
            style={{ width: '100%', minHeight: 72, resize: 'vertical' }}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Internal note about this assignment…"
          />
        </div>
      </div>
    </DaylightModal>
  );
}

// ─── Unassign Confirm Modal ─────────────────────────────────────────────────────

interface UnassignModalProps {
  did: DidInventoryItem | null;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

function UnassignModal({ did, open, onClose, onSuccess }: UnassignModalProps) {
  // Hooks always first
  const { toastOk, toastErr } = useToast();
  const queryClient = useQueryClient();

  const unassignMutation = useMutation({
    mutationFn: () => unassignDid(did!.did),
    onSuccess: () => {
      toastOk(`${fmt(did!.did)} unassigned`);
      void queryClient.invalidateQueries({ queryKey: ['did-inventory'] });
      void queryClient.invalidateQueries({ queryKey: ['did-stats'] });
      void queryClient.invalidateQueries({ queryKey: ['did-available'] });
      onSuccess();
      onClose();
    },
    onError: (err: Error) => {
      toastErr(err.message ?? 'Failed to unassign number');
    },
  });

  // Guard after hooks
  if (!did) return null;

  const pending = unassignMutation.isPending;

  return (
    <DaylightModal
      open={open}
      onClose={onClose}
      title="Unassign Number"
      footer={
        <>
          <button type="button" className="dl-btn dl-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="dl-btn dl-btn-danger"
            disabled={pending}
            onClick={() => unassignMutation.mutate()}
          >
            {pending ? 'Unassigning…' : 'Unassign'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ fontSize: '0.85rem', color: 'var(--rcf-ink-soft)', lineHeight: 1.6, margin: 0 }}>
          This will remove <strong style={{ color: 'var(--rcf-ink)' }}>{fmt(did.did)}</strong> from{' '}
          <strong style={{ color: 'var(--rcf-ink)' }}>{did.customer_name ?? 'this customer'}</strong> and
          return it to the available pool. This action takes effect immediately.
        </p>
        <div className="dl-banner dl-banner-err" style={{ fontSize: '0.75rem' }}>
          Any active routing rules for this number will stop working immediately.
        </div>
      </div>
    </DaylightModal>
  );
}

// ─── Deny Release Confirm Modal ─────────────────────────────────────────────────
// Admin DENY of a customer release request — cancel-release puts the DID back to
// 'assigned'. Approval reuses UnassignModal (unassign accepts 'release_requested').

interface DenyReleaseModalProps {
  did: DidInventoryItem | null;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

function DenyReleaseModal({ did, open, onClose, onSuccess }: DenyReleaseModalProps) {
  // Hooks always first
  const { toastOk, toastErr } = useToast();
  const queryClient = useQueryClient();

  const denyMutation = useMutation({
    mutationFn: () => cancelDidRelease(did!.did),
    onSuccess: () => {
      toastOk(`Release request denied — ${fmt(did!.did)} stays assigned`);
      void queryClient.invalidateQueries({ queryKey: ['did-inventory'] });
      void queryClient.invalidateQueries({ queryKey: ['did-stats'] });
      void queryClient.invalidateQueries({ queryKey: ['did-my'] });
      onSuccess();
      onClose();
    },
    onError: (err: Error) => {
      toastErr(err.message ?? 'Failed to deny release request');
    },
  });

  // Guard after hooks
  if (!did) return null;

  const pending = denyMutation.isPending;

  return (
    <DaylightModal
      open={open}
      onClose={onClose}
      title="Deny Release Request"
      footer={
        <>
          <button type="button" className="dl-btn dl-btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="dl-btn dl-btn-primary"
            disabled={pending}
            onClick={() => denyMutation.mutate()}
          >
            {pending ? 'Denying…' : 'Deny Request'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ fontSize: '0.85rem', color: 'var(--rcf-ink-soft)', lineHeight: 1.6, margin: 0 }}>
          This will dismiss the pending release request for{' '}
          <strong style={{ color: 'var(--rcf-ink)' }}>{fmt(did.did)}</strong>. The number stays
          assigned to <strong style={{ color: 'var(--rcf-ink)' }}>{did.customer_name ?? 'its customer'}</strong>{' '}
          and routing is unaffected.
        </p>
        <div className="dl-note" role="note">
          The customer can submit a new release request at any time.
        </div>
      </div>
    </DaylightModal>
  );
}

// ─── Tab: Inventory ─────────────────────────────────────────────────────────────

function InventoryTab() {
  // All hooks unconditionally first
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<DidStatus | ''>('');
  const [stateFilter, setStateFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const [assignTarget, setAssignTarget] = useState<DidInventoryItem | null>(null);
  const [unassignTarget, setUnassignTarget] = useState<DidInventoryItem | null>(null);
  const [denyTarget, setDenyTarget] = useState<DidInventoryItem | null>(null);
  const { toastOk, toastErr } = useToast();
  const queryClient = useQueryClient();

  const { data: statsData, isLoading: statsLoading } = useQuery({
    queryKey: ['did-stats'],
    queryFn: getDidStats,
  });

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['did-inventory', { search, statusFilter, stateFilter, offset }],
    queryFn: () =>
      listDidInventory({
        search: search || undefined,
        status: statusFilter || undefined,
        state: stateFilter || undefined,
        limit: PAGE_SIZE,
        offset,
      }),
    placeholderData: (prev) => prev,
  });

  const syncMutation = useMutation({
    mutationFn: syncDidInventory,
    onSuccess: (result) => {
      toastOk(`Sync complete — ${result.synced} numbers updated`);
      void queryClient.invalidateQueries({ queryKey: ['did-inventory'] });
      void queryClient.invalidateQueries({ queryKey: ['did-stats'] });
      void queryClient.invalidateQueries({ queryKey: ['did-available'] });
    },
    onError: (err: Error) => {
      toastErr(err.message ?? 'Sync failed');
    },
  });

  const handleSearchChange = useCallback((v: string) => {
    setSearch(v);
    setOffset(0);
  }, []);

  const handleStatusChange = useCallback((v: DidStatus | '') => {
    setStatusFilter(v);
    setOffset(0);
  }, []);

  const handleStateChange = useCallback((v: string) => {
    setStateFilter(v);
    setOffset(0);
  }, []);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const filtered = Boolean(search || statusFilter || stateFilter);

  return (
    <div className="dl-stack">
      {/* Stats strip */}
      <div className="dlx4-tiles">
        <DidStatTile
          label="Total Numbers"
          value={statsLoading ? '—' : (statsData?.total ?? 0)}
          accent={ACCENT_AZURE}
          icon={<Phone size={12} />}
        />
        <DidStatTile
          label="Available"
          value={statsLoading ? '—' : (statsData?.available ?? 0)}
          accent={ACCENT_AZURE}
          icon={<CheckCircle size={12} />}
        />
        <DidStatTile
          label="Assigned"
          value={statsLoading ? '—' : (statsData?.assigned ?? 0)}
          accent={ACCENT_GREEN}
          icon={<Users size={12} />}
        />
        <DidStatTile
          label="Reserved"
          value={statsLoading ? '—' : (statsData?.reserved ?? 0)}
          accent={ACCENT_AMBER}
          icon={<Clock size={12} />}
        />
        <DidStatTile
          label="Release Requests"
          value={statsLoading ? '—' : (statsData?.by_status?.release_requested ?? 0)}
          accent={ACCENT_SKY}
          icon={<Undo2 size={12} />}
        />
      </div>

      {/* Inventory panel */}
      <section className="dl-panel">
        <div className="dl-panel-head">
          <h2 className="dl-panel-title">DID Inventory</h2>
          {isFetching ? (
            <span
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.74rem', color: 'var(--rcf-ink-dim)' }}
            >
              <Spinner size="xs" /> Loading…
            </span>
          ) : (
            <span className="dl-count">
              {total.toLocaleString()} numbers{filtered ? ' (filtered)' : ''}
            </span>
          )}
          <button
            type="button"
            className="dl-btn dl-btn-ghost dlx-btn-sm"
            style={{ marginLeft: 'auto' }}
            disabled={syncMutation.isPending}
            onClick={() => syncMutation.mutate()}
          >
            <RefreshCw size={13} />
            {syncMutation.isPending ? 'Syncing…' : 'Sync from Bandwidth'}
          </button>
        </div>

        <FilterBar
          search={search}
          onSearchChange={handleSearchChange}
          statusFilter={statusFilter}
          onStatusChange={handleStatusChange}
          stateFilter={stateFilter}
          onStateChange={handleStateChange}
        />

        {/* Table */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
            <thead>
              <tr>
                <th className="dl-th">DID</th>
                <th className="dl-th">City</th>
                <th className="dl-th">State</th>
                <th className="dl-th">Status</th>
                <th className="dl-th">Product</th>
                <th className="dl-th">Customer</th>
                <th className="dl-th" style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: 48 }}>
                    <Spinner size="sm" />
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: 48, color: 'var(--rcf-ink-dim)', fontSize: '0.82rem' }}>
                    No numbers found
                    {filtered && ' matching those filters'}
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr key={item.id} className="dl-row">
                    <td className="dlx-td"><DidCell did={item.did} /></td>
                    <td className="dlx-td" style={{ color: 'var(--rcf-ink-dim)' }}>{item.city ?? '—'}</td>
                    <td className="dlx-td" style={{ color: 'var(--rcf-ink-dim)' }}>{item.state ?? '—'}</td>
                    <td className="dlx-td"><StatusBadge status={item.status} /></td>
                    <td className="dlx-td">
                      {item.product_type ? (
                        <ProductPill type={item.product_type} />
                      ) : (
                        <span style={{ color: 'var(--rcf-ink-dim)', fontSize: '0.75rem' }}>—</span>
                      )}
                    </td>
                    <td className="dlx-td">
                      {item.customer_name ? (
                        <span style={{ fontSize: '0.8rem', color: 'var(--rcf-ink-soft)' }}>
                          {item.customer_name}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--rcf-ink-dim)', fontSize: '0.75rem' }}>—</span>
                      )}
                    </td>
                    <td className="dlx-td" style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                        {item.status === 'available' && (
                          <button
                            type="button"
                            className="dl-btn dl-btn-primary dlx-btn-sm"
                            onClick={() => setAssignTarget(item)}
                          >
                            Assign
                          </button>
                        )}
                        {item.status === 'assigned' && (
                          <button
                            type="button"
                            className="dl-btn dl-btn-danger dlx-btn-sm"
                            onClick={() => setUnassignTarget(item)}
                          >
                            Unassign
                          </button>
                        )}
                        {item.status === 'release_requested' && (
                          <>
                            <button
                              type="button"
                              className="dl-btn dl-btn-primary dlx-btn-sm"
                              onClick={() => setUnassignTarget(item)}
                            >
                              Approve Release
                            </button>
                            <button
                              type="button"
                              className="dl-btn dl-btn-ghost dlx-btn-sm"
                              onClick={() => setDenyTarget(item)}
                            >
                              Deny
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 20px',
              borderTop: '1px solid var(--rcf-line)',
              background: 'var(--rcf-tint)',
            }}
          >
            <span style={{ fontSize: '0.74rem', color: 'var(--rcf-ink-dim)', fontVariantNumeric: 'tabular-nums' }}>
              Showing {Math.min(offset + PAGE_SIZE, total).toLocaleString()} of{' '}
              {total.toLocaleString()}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="dlx4-pgbtn"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </button>
              <button
                type="button"
                className="dlx4-pgbtn"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Modals */}
      <AssignModal
        did={assignTarget}
        open={assignTarget !== null}
        onClose={() => setAssignTarget(null)}
        onSuccess={() => setAssignTarget(null)}
      />
      <UnassignModal
        did={unassignTarget}
        open={unassignTarget !== null}
        onClose={() => setUnassignTarget(null)}
        onSuccess={() => setUnassignTarget(null)}
      />
      <DenyReleaseModal
        did={denyTarget}
        open={denyTarget !== null}
        onClose={() => setDenyTarget(null)}
        onSuccess={() => setDenyTarget(null)}
      />
    </div>
  );
}

// ─── Tab: Available Numbers ─────────────────────────────────────────────────────

interface AvailableTabProps {
  isAdmin: boolean;
}

function AvailableTab({ isAdmin }: AvailableTabProps) {
  // All hooks unconditionally first
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [assignTarget, setAssignTarget] = useState<DidInventoryItem | null>(null);
  const { toastOk, toastErr } = useToast();
  const queryClient = useQueryClient();

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['did-available', { search, stateFilter }],
    queryFn: () =>
      listAvailableDids({
        search: search || undefined,
        state: stateFilter || undefined,
        limit: 100,
      }),
    placeholderData: (prev) => prev,
  });

  const requestMutation = useMutation({
    mutationFn: (did: string) => requestDid(did),
    onSuccess: (_data, did) => {
      toastOk(`${fmt(did)} has been requested`);
      void queryClient.invalidateQueries({ queryKey: ['did-available'] });
      void queryClient.invalidateQueries({ queryKey: ['did-my'] });
    },
    onError: (err: Error) => {
      toastErr(err.message ?? 'Request failed');
    },
  });

  const handleSearchChange = useCallback((v: string) => setSearch(v), []);
  const handleStateChange = useCallback((v: string) => setStateFilter(v), []);

  return (
    <div className="dl-stack">
      <section className="dl-panel">
        <div className="dl-panel-head">
          <h2 className="dl-panel-title">Available Numbers</h2>
          <span className="dl-count">{items.length.toLocaleString()} available</span>
        </div>

        <FilterBar
          search={search}
          onSearchChange={handleSearchChange}
          statusFilter=""
          onStatusChange={() => undefined}
          stateFilter={stateFilter}
          onStateChange={handleStateChange}
          placeholder="Search area code, city, rate center…"
          hideStatus
        />

        {/* Number table */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 680 }}>
            <thead>
              <tr>
                <th className="dl-th">DID</th>
                <th className="dl-th">City</th>
                <th className="dl-th">State</th>
                <th className="dl-th">LATA</th>
                <th className="dl-th">Rate Center</th>
                <th className="dl-th" style={{ textAlign: 'right' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: 48 }}>
                    <Spinner size="sm" />
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: 48, color: 'var(--rcf-ink-dim)', fontSize: '0.82rem' }}>
                    No available numbers
                    {(search || stateFilter) && ' matching those filters'}
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr key={item.id} className="dl-row">
                    <td className="dlx-td"><DidCell did={item.did} /></td>
                    <td className="dlx-td" style={{ color: 'var(--rcf-ink-dim)' }}>{item.city ?? '—'}</td>
                    <td className="dlx-td" style={{ color: 'var(--rcf-ink-dim)' }}>{item.state ?? '—'}</td>
                    <td className="dlx-td" style={{ color: 'var(--rcf-ink-dim)' }}>{item.lata ?? '—'}</td>
                    <td className="dlx-td" style={{ color: 'var(--rcf-ink-dim)' }}>{item.rate_center ?? '—'}</td>
                    <td className="dlx-td" style={{ textAlign: 'right' }}>
                      {isAdmin ? (
                        <button
                          type="button"
                          className="dl-btn dl-btn-primary dlx-btn-sm"
                          onClick={() => setAssignTarget(item)}
                        >
                          Assign
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="dl-btn dl-btn-primary dlx-btn-sm"
                          disabled={requestMutation.isPending}
                          onClick={() => requestMutation.mutate(item.did)}
                        >
                          {requestMutation.isPending ? 'Requesting…' : 'Request'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Assign modal — admin only */}
      {isAdmin && (
        <AssignModal
          did={assignTarget}
          open={assignTarget !== null}
          onClose={() => setAssignTarget(null)}
          onSuccess={() => setAssignTarget(null)}
        />
      )}
    </div>
  );
}

// ─── Tab: Assignments (admin) ───────────────────────────────────────────────────

function AssignmentsTab() {
  // All hooks unconditionally first
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [unassignTarget, setUnassignTarget] = useState<DidInventoryItem | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['did-inventory', { search, stateFilter, statusFilter: 'assigned', offset: 0 }],
    queryFn: () =>
      listDidInventory({
        status: 'assigned',
        search: search || undefined,
        state: stateFilter || undefined,
        limit: 200,
        offset: 0,
      }),
    placeholderData: (prev) => prev,
  });

  const handleSearchChange = useCallback((v: string) => setSearch(v), []);
  const handleStateChange = useCallback((v: string) => setStateFilter(v), []);

  const items = data?.items ?? [];

  // Group items by customer for display
  const byCustomer = items.reduce<Record<string, DidInventoryItem[]>>((acc, item) => {
    const key = item.customer_name ?? `Customer #${item.customer_id ?? '?'}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});

  const customerGroups = Object.entries(byCustomer).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="dl-stack">
      <section className="dl-panel">
        <div className="dl-panel-head">
          <h2 className="dl-panel-title">Assignments</h2>
          {isFetching ? (
            <span
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.74rem', color: 'var(--rcf-ink-dim)' }}
            >
              <Spinner size="xs" /> Loading…
            </span>
          ) : (
            <span className="dl-count">
              {items.length.toLocaleString()} assigned{(search || stateFilter) ? ' (filtered)' : ''}
            </span>
          )}
        </div>

        <FilterBar
          search={search}
          onSearchChange={handleSearchChange}
          statusFilter="assigned"
          onStatusChange={() => undefined}
          stateFilter={stateFilter}
          onStateChange={handleStateChange}
          placeholder="Search DID, customer, city…"
          hideStatus
        />

        {isLoading ? (
          <div style={{ textAlign: 'center', padding: 48 }}>
            <Spinner size="sm" />
          </div>
        ) : customerGroups.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 48, color: 'var(--rcf-ink-dim)', fontSize: '0.82rem' }}>
            No assigned numbers found
          </div>
        ) : (
          <div style={{ paddingBottom: 4 }}>
            {customerGroups.map(([customerName, dids]) => (
              <div key={customerName}>
                {/* Customer group header */}
                <div className="dlx4-grouphead">
                  <Users size={13} style={{ color: 'var(--rcf-azure-deep)' }} />
                  <span
                    style={{
                      fontSize: '0.78rem',
                      fontWeight: 700,
                      color: 'var(--rcf-ink)',
                      letterSpacing: '-0.01em',
                    }}
                  >
                    {customerName}
                  </span>
                  <span className="dl-count">{dids.length}</span>
                </div>

                {/* DIDs in this group */}
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th className="dl-th">DID</th>
                      <th className="dl-th">City / State</th>
                      <th className="dl-th">Product</th>
                      <th className="dl-th">Assigned</th>
                      <th className="dl-th">Notes</th>
                      <th className="dl-th" style={{ textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dids.map((item) => (
                      <tr key={item.id} className="dl-row">
                        <td className="dlx-td"><DidCell did={item.did} /></td>
                        <td className="dlx-td" style={{ color: 'var(--rcf-ink-dim)' }}>
                          {[item.city, item.state].filter(Boolean).join(', ') || '—'}
                        </td>
                        <td className="dlx-td">
                          {item.product_type ? (
                            <ProductPill type={item.product_type} />
                          ) : (
                            <span style={{ color: 'var(--rcf-ink-dim)' }}>—</span>
                          )}
                        </td>
                        <td className="dlx-td" style={{ color: 'var(--rcf-ink-dim)' }}>
                          {item.assigned_at
                            ? new Date(item.assigned_at).toLocaleDateString()
                            : '—'}
                        </td>
                        <td className="dlx-td" style={{ color: 'var(--rcf-ink-dim)' }}>
                          <span
                            style={{
                              maxWidth: 180,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              display: 'block',
                            }}
                          >
                            {item.notes ?? '—'}
                          </span>
                        </td>
                        <td className="dlx-td" style={{ textAlign: 'right' }}>
                          <button
                            type="button"
                            className="dl-btn dl-btn-danger dlx-btn-sm"
                            onClick={() => setUnassignTarget(item)}
                          >
                            Unassign
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </section>

      <UnassignModal
        did={unassignTarget}
        open={unassignTarget !== null}
        onClose={() => setUnassignTarget(null)}
        onSuccess={() => {
          setUnassignTarget(null);
          void queryClient.invalidateQueries({ queryKey: ['did-inventory'] });
        }}
      />
    </div>
  );
}

// ─── Tab: My Numbers (customer) ─────────────────────────────────────────────────

function MyNumbersTab() {
  // Hooks first
  const { data: items = [], isLoading } = useQuery({
    queryKey: ['did-my'],
    queryFn: listMyDids,
  });

  return (
    <div className="dl-stack">
      <section className="dl-panel">
        <div className="dl-panel-head">
          <h2 className="dl-panel-title">My Numbers</h2>
          <span className="dl-count">{items.length} assigned to your account</span>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
            <thead>
              <tr>
                <th className="dl-th">DID</th>
                <th className="dl-th">City</th>
                <th className="dl-th">State</th>
                <th className="dl-th">Product</th>
                <th className="dl-th">Status</th>
                <th className="dl-th">Assigned</th>
                <th className="dl-th">Notes</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: 48 }}>
                    <Spinner size="sm" />
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: 48, color: 'var(--rcf-ink-dim)', fontSize: '0.82rem' }}>
                    No numbers are currently assigned to your account
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr key={item.id} className="dl-row">
                    <td className="dlx-td"><DidCell did={item.did} /></td>
                    <td className="dlx-td" style={{ color: 'var(--rcf-ink-dim)' }}>{item.city ?? '—'}</td>
                    <td className="dlx-td" style={{ color: 'var(--rcf-ink-dim)' }}>{item.state ?? '—'}</td>
                    <td className="dlx-td">
                      {item.product_type ? (
                        <ProductPill type={item.product_type} />
                      ) : (
                        <span style={{ color: 'var(--rcf-ink-dim)' }}>—</span>
                      )}
                    </td>
                    <td className="dlx-td"><StatusBadge status={item.status} /></td>
                    <td className="dlx-td" style={{ color: 'var(--rcf-ink-dim)' }}>
                      {item.assigned_at
                        ? new Date(item.assigned_at).toLocaleDateString()
                        : '—'}
                    </td>
                    <td className="dlx-td" style={{ color: 'var(--rcf-ink-dim)' }}>
                      <span
                        style={{
                          maxWidth: 200,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          display: 'block',
                        }}
                      >
                        {item.notes ?? '—'}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────────

interface Tab {
  id: string;
  label: string;
  icon: React.ReactNode;
}

export function DIDSearchPage() {
  // All hooks unconditionally at the very top
  const { isAdmin } = useAuth();
  const [activeTab, setActiveTab] = useState<string>(() =>
    isAdmin ? 'inventory' : 'available',
  );

  const adminTabs: Tab[] = [
    { id: 'inventory',   label: 'Inventory',         icon: <Phone size={13} /> },
    { id: 'available',   label: 'Available Numbers',  icon: <CheckCircle size={13} /> },
    { id: 'assignments', label: 'Assignments',        icon: <Users size={13} /> },
  ];

  const customerTabs: Tab[] = [
    { id: 'available',  label: 'Available Numbers', icon: <CheckCircle size={13} /> },
    { id: 'my-numbers', label: 'My Numbers',        icon: <Phone size={13} /> },
  ];

  const tabs = isAdmin ? adminTabs : customerTabs;

  return (
    <div className="dl-stack">
      {/* ── Section identity ── */}
      <div>
        <h2
          style={{
            fontFamily: '"Archivo", "IBM Plex Sans", sans-serif',
            fontSize: '0.95rem',
            fontWeight: 700,
            letterSpacing: '-0.01em',
            color: 'var(--rcf-ink)',
            margin: 0,
          }}
        >
          Number Management
        </h2>
        <p style={{ fontSize: '0.78rem', color: 'var(--rcf-ink-dim)', margin: '3px 0 0' }}>
          {isAdmin
            ? 'Full DID lifecycle management — inventory, assignments, and Bandwidth sync.'
            : 'Browse available numbers and manage your assigned DIDs.'}
        </p>
      </div>

      {/* ── Tab navigation ── */}
      <div className="dlx-seg" role="tablist" aria-label="Number management views" style={{ alignSelf: 'flex-start' }}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? 'dlx-seg-btn dlx-seg-btn-active' : 'dlx-seg-btn'}
            onClick={() => setActiveTab(tab.id)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Tab content ── */}
      {activeTab === 'inventory' && isAdmin && <InventoryTab />}
      {activeTab === 'available' && <AvailableTab isAdmin={isAdmin} />}
      {activeTab === 'assignments' && isAdmin && <AssignmentsTab />}
      {activeTab === 'my-numbers' && !isAdmin && <MyNumbersTab />}
    </div>
  );
}
