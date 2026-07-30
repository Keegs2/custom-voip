import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Phone,
  RefreshCw,
  Search,
  X,
  MapPin,
  Users,
  CheckCircle,
  Clock,
  AlertCircle,
  ArrowRightLeft,
  Ban,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import { FormField } from '../../components/ui/FormField';
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
} from '../../api/didInventory';
import { listCustomers } from '../../api/customers';
import type { DidInventoryItem, DidStatus } from '../../types/didInventory';

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

// ─── Status badge helper ────────────────────────────────────────────────────────

interface StatusStyle {
  bg: string;
  color: string;
  border: string;
  label: string;
  icon: React.ReactNode;
}

function getStatusStyle(status: DidStatus): StatusStyle {
  switch (status) {
    case 'available':
      return {
        bg: 'rgba(59,130,246,0.12)',
        color: '#60a5fa',
        border: 'rgba(59,130,246,0.30)',
        label: 'Available',
        icon: <CheckCircle size={11} />,
      };
    case 'assigned':
      return {
        bg: 'rgba(34,197,94,0.12)',
        color: '#4ade80',
        border: 'rgba(34,197,94,0.30)',
        label: 'Assigned',
        icon: <CheckCircle size={11} />,
      };
    case 'reserved':
      return {
        bg: 'rgba(245,158,11,0.12)',
        color: '#fbbf24',
        border: 'rgba(245,158,11,0.30)',
        label: 'Reserved',
        icon: <Clock size={11} />,
      };
    case 'porting_in':
      return {
        bg: 'rgba(168,85,247,0.12)',
        color: '#c084fc',
        border: 'rgba(168,85,247,0.30)',
        label: 'Porting In',
        icon: <ArrowRightLeft size={11} />,
      };
    case 'porting_out':
      return {
        bg: 'rgba(168,85,247,0.12)',
        color: '#c084fc',
        border: 'rgba(168,85,247,0.30)',
        label: 'Porting Out',
        icon: <ArrowRightLeft size={11} />,
      };
    case 'suspended':
      return {
        bg: 'rgba(239,68,68,0.10)',
        color: '#f87171',
        border: 'rgba(239,68,68,0.28)',
        label: 'Suspended',
        icon: <Ban size={11} />,
      };
    default:
      return {
        bg: 'rgba(100,116,139,0.12)',
        color: '#94a3b8',
        border: 'rgba(100,116,139,0.25)',
        label: status,
        icon: <AlertCircle size={11} />,
      };
  }
}

function StatusBadge({ status }: { status: DidStatus }) {
  const s = getStatusStyle(status);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '3px 8px',
        borderRadius: 6,
        background: s.bg,
        color: s.color,
        border: `1px solid ${s.border}`,
        fontSize: '0.65rem',
        fontWeight: 700,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}
    >
      {s.icon}
      {s.label}
    </span>
  );
}

// ─── Product pill ───────────────────────────────────────────────────────────────

const PRODUCT_COLORS: Record<string, { bg: string; color: string; border: string }> = {
  rcf:   { bg: 'rgba(59,130,246,0.12)',  color: '#60a5fa',  border: 'rgba(59,130,246,0.28)' },
  api:   { bg: 'rgba(168,85,247,0.12)', color: '#c084fc',  border: 'rgba(168,85,247,0.28)' },
  trunk: { bg: 'rgba(245,158,11,0.12)', color: '#fbbf24',  border: 'rgba(245,158,11,0.28)' },
  ucaas: { bg: 'rgba(34,197,94,0.12)',  color: '#4ade80',  border: 'rgba(34,197,94,0.28)' },
};

function ProductPill({ type }: { type: string }) {
  const c = PRODUCT_COLORS[type] ?? {
    bg: 'rgba(100,116,139,0.12)',
    color: '#94a3b8',
    border: 'rgba(100,116,139,0.25)',
  };
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 7px',
        borderRadius: 5,
        background: c.bg,
        color: c.color,
        border: `1px solid ${c.border}`,
        fontSize: '0.62rem',
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}
    >
      {type.toUpperCase()}
    </span>
  );
}

// ─── Stat card ──────────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string;
  value: number | string;
  accent: string;
  icon: React.ReactNode;
  delay?: string;
}

function DidStatCard({ label, value, accent, icon, delay = '0s' }: StatCardProps) {
  return (
    <div
      className="animate-fade-in-up glass-surface glass-hover"
      style={{
        animationDelay: delay,
        flex: 1,
        minWidth: 0,
        borderRadius: 14,
        padding: '16px 18px',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: `${accent}18`,
          border: `1px solid ${accent}30`,
          color: accent,
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div>
        <div
          style={{
            fontSize: '1.4rem',
            fontWeight: 800,
            color: '#e2e8f0',
            letterSpacing: '-0.03em',
            lineHeight: 1,
            marginBottom: 3,
          }}
        >
          {typeof value === 'number' ? value.toLocaleString() : value}
        </div>
        <div style={{ fontSize: '0.7rem', color: '#64748b', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          {label}
        </div>
      </div>
    </div>
  );
}

// ─── Glass container ────────────────────────────────────────────────────────────

function GlassPanel({
  children,
  style,
  className,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}) {
  return (
    <div
      className={className ? `glass-surface ${className}` : 'glass-surface'}
      style={{
        borderRadius: 16,
        overflow: 'hidden',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ─── Table primitives ───────────────────────────────────────────────────────────

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      style={{
        padding: '10px 14px',
        fontSize: '0.62rem',
        fontWeight: 700,
        color: '#475569',
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        textAlign: right ? 'right' : 'left',
        borderBottom: '1px solid rgba(42,47,69,0.6)',
        background: 'rgba(0,0,0,0.15)',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  muted,
  right,
}: {
  children: React.ReactNode;
  muted?: boolean;
  right?: boolean;
}) {
  return (
    <td
      style={{
        padding: '11px 14px',
        fontSize: '0.8rem',
        color: muted ? '#64748b' : '#e2e8f0',
        borderBottom: '1px solid rgba(42,47,69,0.35)',
        textAlign: right ? 'right' : 'left',
        verticalAlign: 'middle',
      }}
    >
      {children}
    </td>
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
        padding: '14px 16px',
        borderBottom: '1px solid rgba(42,47,69,0.45)',
        background: 'rgba(0,0,0,0.08)',
        alignItems: 'center',
      }}
    >
      {/* Search */}
      <div style={{ position: 'relative', flex: '1 1 220px', minWidth: 180 }}>
        <Search
          size={14}
          style={{
            position: 'absolute',
            left: 10,
            top: '50%',
            transform: 'translateY(-50%)',
            color: '#475569',
            pointerEvents: 'none',
          }}
        />
        <input
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={placeholder}
          className="form-control"
          style={{
            width: '100%',
            padding: '6px 10px 6px 30px',
            borderRadius: 8,
            fontSize: '0.78rem',
            boxSizing: 'border-box',
          }}
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            style={{
              position: 'absolute',
              right: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              color: '#475569',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <X size={12} />
          </button>
        )}
      </div>

      {/* State filter */}
      <select
        value={stateFilter}
        onChange={(e) => onStateChange(e.target.value)}
        style={{
          padding: '6px 28px 6px 10px',
          background: 'rgba(30,33,48,0.8)',
          border: '1px solid rgba(42,47,69,0.8)',
          borderRadius: 8,
          color: stateFilter ? '#e2e8f0' : '#475569',
          fontSize: '0.78rem',
          outline: 'none',
          cursor: 'pointer',
          minWidth: 100,
          appearance: 'none',
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23475569' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'calc(100% - 8px) center',
        }}
      >
        <option value="">All States</option>
        {US_STATES.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>

      {/* Status filter */}
      {!hideStatus && (
        <select
          value={statusFilter}
          onChange={(e) => onStatusChange(e.target.value as DidStatus | '')}
          style={{
            padding: '6px 28px 6px 10px',
            background: 'rgba(30,33,48,0.8)',
            border: '1px solid rgba(42,47,69,0.8)',
            borderRadius: 8,
            color: statusFilter ? '#e2e8f0' : '#475569',
            fontSize: '0.78rem',
            outline: 'none',
            cursor: 'pointer',
            minWidth: 130,
            appearance: 'none',
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23475569' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
            backgroundRepeat: 'no-repeat',
            backgroundPosition: 'calc(100% - 8px) center',
          }}
        >
          <option value="">All Statuses</option>
          <option value="available">Available</option>
          <option value="assigned">Assigned</option>
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

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Assign ${fmt(did.did)}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={assignMutation.isPending}
            disabled={!customerId || assignMutation.isPending}
            onClick={() => assignMutation.mutate()}
          >
            Assign Number
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* DID info row */}
        <div
          style={{
            padding: '10px 14px',
            background: 'rgba(59,130,246,0.06)',
            border: '1px solid rgba(59,130,246,0.18)',
            borderRadius: 10,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <Phone size={14} color="#60a5fa" />
          <div>
            <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#e2e8f0', letterSpacing: '0.02em' }}>
              {fmt(did.did)}
            </div>
            {(did.city || did.state) && (
              <div style={{ fontSize: '0.72rem', color: '#64748b', marginTop: 2 }}>
                {[did.city, did.state].filter(Boolean).join(', ')}
                {did.rate_center && ` · ${did.rate_center}`}
              </div>
            )}
          </div>
        </div>

        {/* Customer selector */}
        <FormField
          as="select"
          label="Customer"
          required
          value={customerId}
          onChange={(e) => setCustomerId((e.target as HTMLSelectElement).value)}
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
        </FormField>

        {/* Product type selector */}
        <FormField
          as="select"
          label="Product Type"
          required
          value={productType}
          onChange={(e) => setProductType((e.target as HTMLSelectElement).value)}
        >
          {PRODUCT_TYPES.map((pt) => (
            <option key={pt.value} value={pt.value}>
              {pt.label}
            </option>
          ))}
        </FormField>

        {/* Notes */}
        <FormField
          as="textarea"
          label="Notes (optional)"
          value={notes}
          onChange={(e) => setNotes((e.target as HTMLTextAreaElement).value)}
          placeholder="Internal note about this assignment…"
        />
      </div>
    </Modal>
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

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Unassign Number"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={unassignMutation.isPending}
            onClick={() => unassignMutation.mutate()}
          >
            Unassign
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ fontSize: '0.85rem', color: '#94a3b8', lineHeight: 1.6 }}>
          This will remove <strong style={{ color: '#e2e8f0' }}>{fmt(did.did)}</strong> from{' '}
          <strong style={{ color: '#e2e8f0' }}>{did.customer_name ?? 'this customer'}</strong> and
          return it to the available pool. This action takes effect immediately.
        </p>
        <div
          style={{
            padding: '10px 14px',
            background: 'rgba(239,68,68,0.07)',
            border: '1px solid rgba(239,68,68,0.20)',
            borderRadius: 8,
            fontSize: '0.75rem',
            color: '#f87171',
            lineHeight: 1.55,
          }}
        >
          Any active routing rules for this number will stop working immediately.
        </div>
      </div>
    </Modal>
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Stats bar */}
      <div
        className="animate-fade-in-up"
        style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}
      >
        <DidStatCard
          label="Total Numbers"
          value={statsLoading ? '—' : (statsData?.total ?? 0)}
          accent="#3b82f6"
          icon={<Phone size={17} />}
          delay="0.05s"
        />
        <DidStatCard
          label="Available"
          value={statsLoading ? '—' : (statsData?.available ?? 0)}
          accent="#60a5fa"
          icon={<CheckCircle size={17} />}
          delay="0.10s"
        />
        <DidStatCard
          label="Assigned"
          value={statsLoading ? '—' : (statsData?.assigned ?? 0)}
          accent="#4ade80"
          icon={<Users size={17} />}
          delay="0.15s"
        />
        <DidStatCard
          label="Reserved"
          value={statsLoading ? '—' : (statsData?.reserved ?? 0)}
          accent="#fbbf24"
          icon={<Clock size={17} />}
          delay="0.20s"
        />
      </div>

      {/* Table */}
      <GlassPanel className="animate-fade-in-up" style={{ animationDelay: '0.25s' }}>
        {/* Table toolbar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 16px',
            borderBottom: '1px solid rgba(42,47,69,0.45)',
          }}
        >
          <div style={{ fontSize: '0.78rem', color: '#64748b' }}>
            {isFetching ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Spinner size="xs" /> Loading…
              </span>
            ) : (
              <span>
                <strong style={{ color: '#94a3b8' }}>{total.toLocaleString()}</strong> numbers
                {(search || statusFilter || stateFilter) && ' (filtered)'}
              </span>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={13} />}
            loading={syncMutation.isPending}
            onClick={() => syncMutation.mutate()}
          >
            Sync from Bandwidth
          </Button>
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
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <Th>DID</Th>
                <Th>City</Th>
                <Th>State</Th>
                <Th>Status</Th>
                <Th>Product</Th>
                <Th>Customer</Th>
                <Th right>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: 48, color: '#475569' }}>
                    <Spinner size="sm" />
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: 48, color: '#475569', fontSize: '0.82rem' }}>
                    No numbers found
                    {(search || statusFilter || stateFilter) && ' matching those filters'}
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr
                    key={item.id}
                    style={{ transition: 'background 0.1s' }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.025)';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLTableRowElement).style.background = '';
                    }}
                  >
                    <Td>
                      <span style={{ fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace', fontSize: '0.82rem', color: '#93c5fd', letterSpacing: '0.03em' }}>
                        {fmt(item.did)}
                      </span>
                    </Td>
                    <Td muted>{item.city ?? '—'}</Td>
                    <Td muted>{item.state ?? '—'}</Td>
                    <Td>
                      <StatusBadge status={item.status} />
                    </Td>
                    <Td>
                      {item.product_type ? (
                        <ProductPill type={item.product_type} />
                      ) : (
                        <span style={{ color: '#334155', fontSize: '0.75rem' }}>—</span>
                      )}
                    </Td>
                    <Td>
                      {item.customer_name ? (
                        <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>
                          {item.customer_name}
                        </span>
                      ) : (
                        <span style={{ color: '#334155', fontSize: '0.75rem' }}>—</span>
                      )}
                    </Td>
                    <Td right>
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                        {item.status === 'available' && (
                          <Button
                            size="xs"
                            variant="primary"
                            onClick={() => setAssignTarget(item)}
                          >
                            Assign
                          </Button>
                        )}
                        {item.status === 'assigned' && (
                          <Button
                            size="xs"
                            variant="danger"
                            onClick={() => setUnassignTarget(item)}
                          >
                            Unassign
                          </Button>
                        )}
                      </div>
                    </Td>
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
              padding: '12px 16px',
              borderTop: '1px solid rgba(42,47,69,0.45)',
              background: 'rgba(0,0,0,0.08)',
            }}
          >
            <span style={{ fontSize: '0.72rem', color: '#475569' }}>
              Showing {Math.min(offset + PAGE_SIZE, total).toLocaleString()} of{' '}
              {total.toLocaleString()}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button
                size="xs"
                variant="ghost"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </GlassPanel>

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <GlassPanel className="animate-fade-in-up">
        {/* Toolbar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 16px',
            borderBottom: '1px solid rgba(42,47,69,0.45)',
          }}
        >
          <div style={{ fontSize: '0.78rem', color: '#64748b' }}>
            <strong style={{ color: '#94a3b8' }}>{items.length.toLocaleString()}</strong>{' '}
            available numbers
          </div>
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

        {/* Number grid / table */}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <Th>DID</Th>
                <Th>City</Th>
                <Th>State</Th>
                <Th>LATA</Th>
                <Th>Rate Center</Th>
                <Th right>Action</Th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: 48, color: '#475569' }}>
                    <Spinner size="sm" />
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: 48, color: '#475569', fontSize: '0.82rem' }}>
                    No available numbers
                    {(search || stateFilter) && ' matching those filters'}
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr
                    key={item.id}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.025)';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLTableRowElement).style.background = '';
                    }}
                  >
                    <Td>
                      <span style={{ fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace', fontSize: '0.82rem', color: '#93c5fd', letterSpacing: '0.03em' }}>
                        {fmt(item.did)}
                      </span>
                    </Td>
                    <Td muted>{item.city ?? '—'}</Td>
                    <Td muted>{item.state ?? '—'}</Td>
                    <Td muted>{item.lata ?? '—'}</Td>
                    <Td muted>{item.rate_center ?? '—'}</Td>
                    <Td right>
                      {isAdmin ? (
                        <Button
                          size="xs"
                          variant="primary"
                          onClick={() => setAssignTarget(item)}
                        >
                          Assign
                        </Button>
                      ) : (
                        <Button
                          size="xs"
                          variant="primary"
                          loading={requestMutation.isPending}
                          onClick={() => requestMutation.mutate(item.did)}
                        >
                          Request
                        </Button>
                      )}
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </GlassPanel>

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <GlassPanel className="animate-fade-in-up">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 16px',
            borderBottom: '1px solid rgba(42,47,69,0.45)',
          }}
        >
          <div style={{ fontSize: '0.78rem', color: '#64748b' }}>
            {isFetching ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Spinner size="xs" /> Loading…
              </span>
            ) : (
              <span>
                <strong style={{ color: '#94a3b8' }}>{items.length.toLocaleString()}</strong> assigned numbers
                {(search || stateFilter) && ' (filtered)'}
              </span>
            )}
          </div>
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
          <div style={{ textAlign: 'center', padding: 48, color: '#475569' }}>
            <Spinner size="sm" />
          </div>
        ) : customerGroups.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 48, color: '#475569', fontSize: '0.82rem' }}>
            No assigned numbers found
          </div>
        ) : (
          <div style={{ padding: '0 0 8px' }}>
            {customerGroups.map(([customerName, dids]) => (
              <div key={customerName}>
                {/* Customer group header */}
                <div
                  style={{
                    padding: '10px 16px 8px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    borderBottom: '1px solid rgba(42,47,69,0.35)',
                    background: 'rgba(0,0,0,0.12)',
                  }}
                >
                  <Users size={13} color="#3b82f6" />
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#93c5fd', letterSpacing: '0.02em' }}>
                    {customerName}
                  </span>
                  <span
                    style={{
                      marginLeft: 4,
                      fontSize: '0.62rem',
                      fontWeight: 700,
                      color: '#475569',
                      background: 'rgba(59,130,246,0.10)',
                      border: '1px solid rgba(59,130,246,0.18)',
                      padding: '1px 7px',
                      borderRadius: 4,
                    }}
                  >
                    {dids.length}
                  </span>
                </div>

                {/* DIDs in this group */}
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <Th>DID</Th>
                      <Th>City / State</Th>
                      <Th>Product</Th>
                      <Th>Assigned</Th>
                      <Th>Notes</Th>
                      <Th right>Actions</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {dids.map((item) => (
                      <tr
                        key={item.id}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.025)';
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLTableRowElement).style.background = '';
                        }}
                      >
                        <Td>
                          <span style={{ fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace', fontSize: '0.82rem', color: '#93c5fd', letterSpacing: '0.03em' }}>
                            {fmt(item.did)}
                          </span>
                        </Td>
                        <Td muted>
                          {[item.city, item.state].filter(Boolean).join(', ') || '—'}
                        </Td>
                        <Td>
                          {item.product_type ? (
                            <ProductPill type={item.product_type} />
                          ) : (
                            <span style={{ color: '#334155' }}>—</span>
                          )}
                        </Td>
                        <Td muted>
                          {item.assigned_at
                            ? new Date(item.assigned_at).toLocaleDateString()
                            : '—'}
                        </Td>
                        <Td muted>
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
                        </Td>
                        <Td right>
                          <Button
                            size="xs"
                            variant="danger"
                            onClick={() => setUnassignTarget(item)}
                          >
                            Unassign
                          </Button>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </GlassPanel>

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <GlassPanel className="animate-fade-in-up">
        <div
          style={{
            padding: '14px 16px',
            borderBottom: '1px solid rgba(42,47,69,0.45)',
          }}
        >
          <span style={{ fontSize: '0.78rem', color: '#64748b' }}>
            <strong style={{ color: '#94a3b8' }}>{items.length}</strong> numbers assigned to your account
          </span>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <Th>DID</Th>
                <Th>City</Th>
                <Th>State</Th>
                <Th>Product</Th>
                <Th>Status</Th>
                <Th>Assigned</Th>
                <Th>Notes</Th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: 48, color: '#475569' }}>
                    <Spinner size="sm" />
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: 48, color: '#475569', fontSize: '0.82rem' }}>
                    No numbers are currently assigned to your account
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr
                    key={item.id}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.025)';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLTableRowElement).style.background = '';
                    }}
                  >
                    <Td>
                      <span style={{ fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace', fontSize: '0.82rem', color: '#93c5fd', letterSpacing: '0.03em' }}>
                        {fmt(item.did)}
                      </span>
                    </Td>
                    <Td muted>{item.city ?? '—'}</Td>
                    <Td muted>{item.state ?? '—'}</Td>
                    <Td>
                      {item.product_type ? (
                        <ProductPill type={item.product_type} />
                      ) : (
                        <span style={{ color: '#334155' }}>—</span>
                      )}
                    </Td>
                    <Td>
                      <StatusBadge status={item.status} />
                    </Td>
                    <Td muted>
                      {item.assigned_at
                        ? new Date(item.assigned_at).toLocaleDateString()
                        : '—'}
                    </Td>
                    <Td muted>
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
                    </Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </GlassPanel>
    </div>
  );
}

// ─── Tab bar ────────────────────────────────────────────────────────────────────

interface Tab {
  id: string;
  label: string;
  icon: React.ReactNode;
}

interface InternalTabBarProps {
  tabs: Tab[];
  activeId: string;
  onChange: (id: string) => void;
}

function InternalTabBar({ tabs, activeId, onChange }: InternalTabBarProps) {
  return (
    <div
      className="glass-surface"
      style={{
        display: 'flex',
        gap: 2,
        borderRadius: 12,
        padding: 4,
        width: 'fit-content',
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '7px 14px',
              borderRadius: 9,
              border: 'none',
              background: isActive
                ? 'rgba(59,130,246,0.15)'
                : 'transparent',
              color: isActive ? '#60a5fa' : '#64748b',
              fontSize: '0.78rem',
              fontWeight: isActive ? 700 : 500,
              cursor: 'pointer',
              transition: 'background 0.15s, color 0.15s',
              whiteSpace: 'nowrap',
              outline: 'none',
              boxShadow: isActive
                ? 'inset 0 0 0 1px rgba(59,130,246,0.25)'
                : 'none',
            }}
          >
            <span style={{ opacity: isActive ? 1 : 0.6, display: 'flex', alignItems: 'center' }}>
              {tab.icon}
            </span>
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────────

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
    <div style={{ minHeight: '100vh' }}>
      <div
        style={{
          maxWidth: 1280,
          margin: '0 auto',
          padding: '40px 24px 80px',
        }}
      >
        {/* ── Page Header ── */}
        <div
          className="animate-fade-in-up"
          style={{ marginBottom: 32 }}
        >
          {/* Logo + title row */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              marginBottom: 8,
            }}
          >
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'linear-gradient(135deg, rgba(59,130,246,0.22) 0%, rgba(59,130,246,0.08) 100%)',
                border: '1px solid rgba(59,130,246,0.30)',
                boxShadow: '0 0 20px rgba(59,130,246,0.15)',
                flexShrink: 0,
                color: '#60a5fa',
              }}
            >
              <Phone size={20} strokeWidth={1.75} />
            </div>

            <div>
              <h1
                style={{
                  fontSize: '1.5rem',
                  fontWeight: 800,
                  color: '#e2e8f0',
                  letterSpacing: '-0.03em',
                  lineHeight: 1.1,
                }}
              >
                Number Management
              </h1>
              <p style={{ fontSize: '0.78rem', color: '#64748b', marginTop: 3 }}>
                {isAdmin
                  ? 'Full DID lifecycle management — inventory, assignments, and Bandwidth sync'
                  : 'Browse available numbers and manage your assigned DIDs'}
              </p>
            </div>
          </div>

          {/* CRAG branding strip */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginTop: 12,
              marginBottom: 24,
            }}
          >
            <div
              style={{
                width: 24,
                height: 1,
                background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.5))',
              }}
            />
            <span
              style={{
                fontSize: '0.6rem',
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: '#3b82f6',
                opacity: 0.65,
              }}
            >
              Granite CRAG · Telecom Number Management
            </span>
            <div
              style={{
                flex: 1,
                height: 1,
                background: 'linear-gradient(90deg, rgba(59,130,246,0.5), transparent)',
              }}
            />
          </div>

          {/* Location marker pill */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '3px 10px',
              borderRadius: 20,
              background: 'rgba(59,130,246,0.08)',
              border: '1px solid rgba(59,130,246,0.18)',
            }}
          >
            <MapPin size={11} color="#3b82f6" />
            <span style={{ fontSize: '0.65rem', fontWeight: 600, color: '#64748b' }}>
              US DID Inventory · Bandwidth-powered
            </span>
          </div>
        </div>

        {/* ── Tab navigation ── */}
        <div
          className="animate-fade-in-up"
          style={{ marginBottom: 24, animationDelay: '0.08s' }}
        >
          <InternalTabBar
            tabs={tabs}
            activeId={activeTab}
            onChange={setActiveTab}
          />
        </div>

        {/* ── Tab content ── */}
        <div className="animate-fade-in-up" style={{ animationDelay: '0.12s' }}>
          {activeTab === 'inventory' && isAdmin && <InventoryTab />}
          {activeTab === 'available' && <AvailableTab isAdmin={isAdmin} />}
          {activeTab === 'assignments' && isAdmin && <AssignmentsTab />}
          {activeTab === 'my-numbers' && !isAdmin && <MyNumbersTab />}
        </div>
      </div>
    </div>
  );
}
