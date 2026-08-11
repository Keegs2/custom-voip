/**
 * TrunksAdminPage — full trunk CRUD across all customers (/admin/trunks):
 * create / edit / delete trunks, and per-trunk authorized-IP + DID management
 * in the expandable row detail.
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` in index.css, plus the
 * page-scoped `dlx-*` primitives in styles/dl-admin.css). Renders INSIDE the
 * AdminPage shell, which owns the paper canvas (`dl-scope`) — this page
 * contributes the toolbar, the create panel, and the trunks table.
 * Destructive actions keep the red treatment + confirm() flows.
 *
 * Behavior contract: the Capacity + Authorized-IPs state, validation, and
 * payload building still come from the SHARED `useTrunkCapacity()` /
 * `useTrunkAuthIps()` controllers in TrunkCapacityFields.tsx (also used by
 * CustomerTrunkSection) — only the presentation is re-rendered here in the
 * daylight language, so the create payload is byte-identical.
 *
 * React #310: every hook in every component below is called unconditionally
 * at the top of its function, before any early return.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { apiRequest } from '../../api/client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import {
  listTrunks,
  createTrunk,
  updateTrunk,
  deleteTrunk,
  getTrunkIps,
  addTrunkIp,
  deleteTrunkIp,
  getTrunkDids,
  addTrunkDid,
  deleteTrunkDid,
} from '../../api/trunks';
import { listCustomers } from '../../api/customers';
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/ToastContext';
import { normalizeNumberInput } from '../../utils/phone';
import {
  useTrunkCapacity,
  useTrunkAuthIps,
  formatTierOption,
  type TrunkCapacityController,
  type TrunkAuthIpsController,
  type CapacityMode,
} from './TrunkCapacityFields';
import type { Trunk, TrunkAuthType, TrunkIp, TrunkDid } from '../../types/trunk';
import '../../styles/dl-admin.css';

// ─── Constants ───────────────────────────────────────────────────────────────

const SIP_SERVER = '34.74.71.32:5060';
const COL_COUNT = 10;
const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';

// ─── Types ───────────────────────────────────────────────────────────────────

interface CreateFormState {
  customer_id: string;
  trunk_name: string;
  auth_type: TrunkAuthType;
}

const INITIAL_CREATE: CreateFormState = {
  customer_id: '',
  trunk_name: '',
  auth_type: 'ip',
};

interface EditFormState {
  trunk_name: string;
  max_channels: string;
  cps_limit: string;
  enabled: boolean;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function AuthTypeTag({ type }: { type: TrunkAuthType }) {
  if (type === 'ip') return <span className="dl-tag">IP</span>;
  if (type === 'credentials') return <span className="dl-tag dl-tag-slate">Creds</span>;
  return <span className="dl-tag">Both</span>;
}

function EnabledPill({ enabled }: { enabled: boolean }) {
  return (
    <span className={enabled ? 'dl-pill dl-pill-on' : 'dl-pill dl-pill-off'}>
      {enabled ? 'Enabled' : 'Disabled'}
    </span>
  );
}

/** Vertical label + control field group. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <span className="dl-flabel">{label}</span>
      {children}
    </div>
  );
}

// ─── IP Management Section ────────────────────────────────────────────────────

function IpSection({ trunk }: { trunk: Trunk }) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [newIp, setNewIp] = useState('');
  const [newIpDesc, setNewIpDesc] = useState('');

  const { data: ips, isLoading } = useQuery<TrunkIp[]>({
    queryKey: ['trunk-ips', trunk.id],
    queryFn: () => getTrunkIps(trunk.id),
  });

  const addMutation = useMutation({
    mutationFn: () => addTrunkIp(trunk.id, newIp.trim(), newIpDesc.trim() || undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trunk-ips', trunk.id] });
      qc.invalidateQueries({ queryKey: ['trunks'] });
      setNewIp('');
      setNewIpDesc('');
      toastOk('IP address added');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (ipId: number) => deleteTrunkIp(trunk.id, ipId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trunk-ips', trunk.id] });
      qc.invalidateQueries({ queryKey: ['trunks'] });
      toastOk('IP address removed');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleAddIp(e: React.FormEvent) {
    e.preventDefault();
    if (!newIp.trim()) { toastErr('IP address is required'); return; }
    addMutation.mutate();
  }

  return (
    <div>
      <h4 className="dl-section-title">Authorized PBX IPs</h4>

      {isLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--rcf-ink-dim)', fontSize: '0.8rem', marginBottom: 12 }}>
          <Spinner size="xs" /> Loading IPs…
        </div>
      )}

      {ips && ips.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {ips.map((ip) => (
            <div
              key={ip.id}
              className="dl-item"
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px' }}
            >
              <span style={{ fontFamily: MONO, fontSize: '0.8rem', fontWeight: 600, color: 'var(--rcf-ink)', flex: 1 }}>
                {ip.ip_address}
              </span>
              {ip.description && (
                <span style={{ fontSize: '0.74rem', color: 'var(--rcf-ink-dim)' }}>{ip.description}</span>
              )}
              <button
                type="button"
                className="dlx-xbtn"
                onClick={() => {
                  if (!confirm(`Remove IP ${ip.ip_address}?`)) return;
                  deleteMutation.mutate(ip.id);
                }}
                disabled={deleteMutation.isPending}
                title="Remove IP"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {ips && ips.length === 0 && !isLoading && (
        <div style={{ fontSize: '0.78rem', color: 'var(--rcf-ink-dim)', marginBottom: 12 }}>
          No IPs configured.
        </div>
      )}

      <form onSubmit={handleAddIp} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: '0 0 160px' }}>
          <Field label="IP Address">
            <input
              className="dl-input dl-input-mono"
              value={newIp}
              onChange={(e) => setNewIp(e.target.value)}
              placeholder="192.168.1.1"
              style={{ width: '100%' }}
            />
          </Field>
        </div>
        <div style={{ flex: 1, minWidth: 120 }}>
          <Field label="Description (optional)">
            <input
              className="dl-input"
              value={newIpDesc}
              onChange={(e) => setNewIpDesc(e.target.value)}
              placeholder="Main PBX"
              style={{ width: '100%' }}
            />
          </Field>
        </div>
        <button type="submit" className="dl-btn dl-btn-ghost" disabled={addMutation.isPending}>
          {addMutation.isPending ? 'Adding…' : '+ Add IP'}
        </button>
      </form>
    </div>
  );
}

// ─── Available TN type ───────────────────────────────────────────────────────

interface AvailableTN {
  tn: string;
  city: string;
  state: string;
  rate_center: string;
  lata: string;
  tier: string;
  bw_status: string;
}

// ─── DID Management Section ───────────────────────────────────────────────────

function DidSection({ trunk }: { trunk: Trunk }) {
  // ALL hooks must be declared before any conditional returns (React rule #310)
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  // Input / dropdown state
  const [inputValue, setInputValue] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  // Selected TN from dropdown (null means user typed a custom value)
  const [selectedTN, setSelectedTN] = useState<AvailableTN | null>(null);

  // Confirmation step state
  const [pendingDid, setPendingDid] = useState('');
  const [pendingTN, setPendingTN] = useState<AvailableTN | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  // Available numbers fetched once on mount
  const [availableTNs, setAvailableTNs] = useState<AvailableTN[]>([]);
  const [loadingTNs, setLoadingTNs] = useState(false);

  // Refs for click-outside handling
  const wrapperRef = useRef<HTMLDivElement>(null);

  const { data: dids, isLoading } = useQuery<TrunkDid[]>({
    queryKey: ['trunk-dids', trunk.id],
    queryFn: () => getTrunkDids(trunk.id),
  });

  const addMutation = useMutation({
    mutationFn: (did: string) => addTrunkDid(trunk.id, did),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trunk-dids', trunk.id] });
      qc.invalidateQueries({ queryKey: ['trunks'] });
      setInputValue('');
      setSelectedTN(null);
      setShowConfirm(false);
      setPendingDid('');
      setPendingTN(null);
      toastOk('DID added');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (didId: number) => deleteTrunkDid(trunk.id, didId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trunk-dids', trunk.id] });
      qc.invalidateQueries({ queryKey: ['trunks'] });
      toastOk('DID removed');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  // Fetch available numbers once on mount
  useEffect(() => {
    let cancelled = false;
    setLoadingTNs(true);
    apiRequest<AvailableTN[]>('GET', '/numbers/available')
      .then((data) => {
        if (!cancelled) setAvailableTNs(data);
      })
      .catch(() => {
        // Non-fatal — user can still type manually
      })
      .finally(() => {
        if (!cancelled) setLoadingTNs(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Click-outside closes the dropdown
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setHighlightedIndex(-1);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Filtered options — match on TN, city, or state
  const filteredOptions = useCallback((): AvailableTN[] => {
    const q = inputValue.trim().toLowerCase();
    if (!q) return availableTNs;
    return availableTNs.filter(
      (t) =>
        t.tn.toLowerCase().includes(q) ||
        t.city.toLowerCase().includes(q) ||
        t.state.toLowerCase().includes(q),
    );
  }, [inputValue, availableTNs]);

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setInputValue(val);
    setSelectedTN(null);
    setDropdownOpen(true);
    setHighlightedIndex(-1);
    // Hide confirmation if user is editing after already staging one
    if (showConfirm) {
      setShowConfirm(false);
      setPendingDid('');
      setPendingTN(null);
    }
  }

  function handleInputFocus() {
    setDropdownOpen(true);
  }

  function selectOption(tn: AvailableTN) {
    setInputValue(tn.tn);
    setSelectedTN(tn);
    setDropdownOpen(false);
    setHighlightedIndex(-1);
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const options = filteredOptions();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((i) => Math.max(i - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (highlightedIndex >= 0 && options[highlightedIndex]) {
        selectOption(options[highlightedIndex]);
      }
    } else if (e.key === 'Escape') {
      setDropdownOpen(false);
      setHighlightedIndex(-1);
    }
  }

  function handleAddDidClick(e: React.FormEvent) {
    e.preventDefault();
    if (!inputValue.trim()) { toastErr('DID is required'); return; }
    // Canonicalize to E.164 so the confirmation dialog + the API call both use the
    // canonical value (strip separators, preserve country code). Permissive — a
    // plausible value is never blocked here; the API is the final arbiter.
    const value = normalizeNumberInput(inputValue);
    // Stage the confirmation step
    setPendingDid(value);
    setPendingTN(selectedTN);
    setShowConfirm(true);
    setDropdownOpen(false);
  }

  function handleConfirmAssignment() {
    addMutation.mutate(pendingDid);
  }

  function handleCancelConfirm() {
    setShowConfirm(false);
    setPendingDid('');
    setPendingTN(null);
  }

  const options = filteredOptions();

  // Label for the confirmation message
  const pendingLabel = pendingTN
    ? `${pendingTN.tn} (${pendingTN.city}, ${pendingTN.state})`
    : pendingDid;

  return (
    <div>
      <h4 className="dl-section-title">Assigned DIDs</h4>

      {isLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--rcf-ink-dim)', fontSize: '0.8rem', marginBottom: 12 }}>
          <Spinner size="xs" /> Loading DIDs…
        </div>
      )}

      {dids && dids.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {dids.map((did) => (
            <div
              key={did.id}
              className="dl-item"
              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px' }}
            >
              <span style={{ fontFamily: MONO, fontSize: '0.8rem', fontWeight: 600, color: 'var(--rcf-ink)', flex: 1 }}>
                {did.did}
              </span>
              <EnabledPill enabled={did.enabled} />
              <button
                type="button"
                className="dlx-xbtn"
                onClick={() => {
                  if (!confirm(`Remove DID ${did.did}?`)) return;
                  deleteMutation.mutate(did.id);
                }}
                disabled={deleteMutation.isPending}
                title="Remove DID"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {dids && dids.length === 0 && !isLoading && (
        <div style={{ fontSize: '0.78rem', color: 'var(--rcf-ink-dim)', marginBottom: 12 }}>
          No DIDs assigned.
        </div>
      )}

      {/* Input row with searchable dropdown */}
      <form onSubmit={handleAddDidClick} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div ref={wrapperRef} style={{ flex: '1 1 220px', maxWidth: 320, position: 'relative' }}>
          <span className="dl-flabel">DID / Phone Number</span>

          {/* Text input */}
          <input
            type="text"
            className="dl-input dl-input-mono"
            value={inputValue}
            onChange={handleInputChange}
            onFocus={handleInputFocus}
            onKeyDown={handleInputKeyDown}
            placeholder={loadingTNs ? 'Loading numbers…' : '+14155551234'}
            autoComplete="off"
            style={{ width: '100%' }}
          />

          {/* Dropdown */}
          {dropdownOpen && (
            <div className="dlx-dropdown">
              {loadingTNs && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', color: 'var(--rcf-ink-dim)', fontSize: '0.8rem' }}>
                  <Spinner size="xs" /> Loading available numbers…
                </div>
              )}

              {!loadingTNs && options.length === 0 && (
                <div style={{ padding: '10px 14px', color: 'var(--rcf-ink-dim)', fontSize: '0.8rem' }}>
                  No available numbers
                  {inputValue.trim() && ' matching your search'}
                  . You can still submit a custom number.
                </div>
              )}

              {!loadingTNs && options.map((tn, idx) => (
                <DropdownOption
                  key={tn.tn}
                  tn={tn}
                  highlighted={idx === highlightedIndex}
                  onSelect={selectOption}
                />
              ))}
            </div>
          )}
        </div>

        <button type="submit" className="dl-btn dl-btn-ghost" disabled={showConfirm}>
          + Add DID
        </button>
      </form>

      {/* Inline confirmation step */}
      {showConfirm && (
        <div className="dl-note" style={{ marginTop: 12, flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: '0.82rem', color: 'var(--rcf-ink)', lineHeight: 1.5 }}>
            Assign{' '}
            <span style={{ fontFamily: MONO, fontWeight: 700, color: 'var(--rcf-azure-deep)' }}>{pendingLabel}</span>{' '}
            to this trunk? This DID will be routed to this trunk for all inbound calls.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="dl-btn dl-btn-ghost"
              onClick={handleCancelConfirm}
              disabled={addMutation.isPending}
            >
              Cancel
            </button>
            <button
              type="button"
              className="dl-btn dl-btn-primary"
              disabled={addMutation.isPending}
              onClick={handleConfirmAssignment}
            >
              {addMutation.isPending ? 'Assigning…' : 'Confirm Assignment'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Dropdown option sub-component ───────────────────────────────────────────

function DropdownOption({
  tn,
  highlighted,
  onSelect,
}: {
  tn: AvailableTN;
  highlighted: boolean;
  onSelect: (tn: AvailableTN) => void;
}) {
  return (
    <div
      className={highlighted ? 'dlx-dropdown-opt dlx-dropdown-opt-hi' : 'dlx-dropdown-opt'}
      onMouseDown={(e) => {
        // Use mousedown so it fires before the input's blur closes the dropdown
        e.preventDefault();
        onSelect(tn);
      }}
    >
      <span style={{ fontFamily: MONO, fontSize: '0.8rem', fontWeight: 600, color: 'var(--rcf-ink)', minWidth: 130 }}>
        {tn.tn}
      </span>
      <span style={{ fontSize: '0.74rem', color: 'var(--rcf-ink-dim)' }}>
        {tn.city}, {tn.state}
      </span>
    </div>
  );
}

// ─── Edit Trunk Form ──────────────────────────────────────────────────────────

interface EditTrunkFormProps {
  trunk: Trunk;
  onSaved: () => void;
}

function EditTrunkForm({ trunk, onSaved }: EditTrunkFormProps) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const [form, setForm] = useState<EditFormState>({
    trunk_name: trunk.trunk_name,
    max_channels: String(trunk.max_channels),
    cps_limit: String(trunk.cps_limit),
    enabled: trunk.enabled,
  });

  const mutation = useMutation({
    mutationFn: () =>
      updateTrunk(trunk.id, {
        trunk_name: form.trunk_name.trim(),
        max_channels: parseInt(form.max_channels, 10) || 10,
        cps_limit: parseInt(form.cps_limit, 10) || 5,
        enabled: form.enabled,
      }),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ['trunks'] });
      toastOk(`Trunk "${updated.trunk_name}" updated`);
      onSaved();
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.trunk_name.trim()) { toastErr('Trunk name is required'); return; }
    mutation.mutate();
  }

  return (
    <form onSubmit={handleSubmit}>
      <h4 className="dl-section-title" style={{ marginBottom: 16 }}>Edit Trunk Settings</h4>
      <div className="dlx-form-grid" style={{ marginBottom: 16 }}>
        <Field label="Trunk Name">
          <input
            className="dl-input"
            value={form.trunk_name}
            onChange={(e) => setForm((p) => ({ ...p, trunk_name: e.target.value }))}
            required
          />
        </Field>
        <Field label="Max Channels">
          <input
            className="dl-input"
            type="number"
            min="1"
            value={form.max_channels}
            onChange={(e) => setForm((p) => ({ ...p, max_channels: e.target.value }))}
          />
        </Field>
        <Field label="CPS Limit">
          <input
            className="dl-input"
            type="number"
            min="1"
            value={form.cps_limit}
            onChange={(e) => setForm((p) => ({ ...p, cps_limit: e.target.value }))}
          />
        </Field>
      </div>

      {/* Enabled toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <button
          type="button"
          role="switch"
          aria-checked={form.enabled}
          className={form.enabled ? 'dlx-switch dlx-switch-on' : 'dlx-switch'}
          onClick={() => setForm((p) => ({ ...p, enabled: !p.enabled }))}
        />
        <span
          style={{
            fontSize: '0.8rem',
            fontWeight: 700,
            color: form.enabled ? 'var(--rcf-green)' : 'var(--rcf-ink-dim)',
          }}
        >
          {form.enabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>

      <button type="submit" className="dl-btn dl-btn-primary" disabled={mutation.isPending}>
        {mutation.isPending ? 'Saving…' : 'Save Changes'}
      </button>
    </form>
  );
}

// ─── Connection Info ──────────────────────────────────────────────────────────

function ConnectionInfo() {
  return (
    <div>
      <h4 className="dl-section-title">Connection Info</h4>
      <div className="dl-note" style={{ flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
        <div>Point your customer&apos;s PBX to:</div>
        <span className="dl-chip" style={{ fontSize: '0.88rem', color: 'var(--rcf-azure-deep)' }}>
          {SIP_SERVER}
        </span>
        <div style={{ fontSize: '0.72rem', color: 'var(--rcf-ink-dim)' }}>
          SIP over UDP/TCP — Port 5060
        </div>
      </div>
    </div>
  );
}

// ─── Expanded Trunk Detail ────────────────────────────────────────────────────

interface TrunkExpandedProps {
  trunk: Trunk;
  onDelete: () => void;
}

function TrunkExpanded({ trunk, onDelete }: TrunkExpandedProps) {
  const [isEditing, setIsEditing] = useState(false);

  return (
    <div className="dlx-xpanel">
      {/* Top action bar */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 20 }}>
        <button
          type="button"
          className="dl-btn dl-btn-ghost"
          onClick={() => setIsEditing((v) => !v)}
        >
          {isEditing ? 'Cancel Edit' : 'Edit Trunk'}
        </button>
        <button type="button" className="dl-btn dl-btn-danger" onClick={onDelete}>
          Delete Trunk
        </button>
      </div>

      {/* Edit form */}
      {isEditing && (
        <div
          style={{
            marginBottom: 24,
            paddingBottom: 24,
            borderBottom: '1px solid var(--rcf-line)',
          }}
        >
          <EditTrunkForm trunk={trunk} onSaved={() => setIsEditing(false)} />
        </div>
      )}

      {/* Three sections — collapse to one column on narrow screens */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '28px 32px',
        }}
      >
        <IpSection trunk={trunk} />
        <DidSection trunk={trunk} />
        <ConnectionInfo />
      </div>
    </div>
  );
}

// ─── Trunk Row ────────────────────────────────────────────────────────────────

interface TrunkRowProps {
  trunk: Trunk;
  isExpanded: boolean;
  onToggleExpand: (id: number) => void;
  onToggleEnabled: (trunk: Trunk) => void;
  onDelete: (trunk: Trunk) => void;
}

function InlineTrunkName({ trunkId, name }: { trunkId: number; name: string }) {
  const qc = useQueryClient();
  const { toastErr } = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [hovered, setHovered] = useState(false);

  const [prev, setPrev] = useState(name);
  if (name !== prev) { setPrev(name); if (!editing) setValue(name); }

  const mutation = useMutation({
    mutationFn: (n: string) => updateTrunk(trunkId, { trunk_name: n }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-trunks'] }); setEditing(false); },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleSave() {
    const trimmed = value.trim();
    if (!trimmed) { handleCancel(); return; }
    if (trimmed === name) { setEditing(false); return; }
    mutation.mutate(trimmed);
  }

  function handleCancel() {
    setValue(name);
    setEditing(false);
  }

  if (editing) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <input
          type="text"
          className="dl-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); handleSave(); }
            if (e.key === 'Escape') handleCancel();
            e.stopPropagation();
          }}
          onBlur={handleCancel}
          onClick={(e) => e.stopPropagation()}
          disabled={mutation.isPending}
          autoFocus
          style={{
            fontWeight: 600,
            fontSize: '0.82rem',
            padding: '3px 8px',
            opacity: mutation.isPending ? 0.5 : 1,
            width: Math.max(value.length * 8.5 + 20, 80),
          }}
        />
        <button
          type="button"
          className="dl-btn dl-btn-primary dlx-btn-sm"
          onMouseDown={(e) => { e.preventDefault(); handleSave(); }}
          disabled={mutation.isPending}
        >
          {mutation.isPending ? '…' : 'Save'}
        </button>
        <button
          type="button"
          className="dl-btn dl-btn-ghost dlx-btn-sm"
          onMouseDown={(e) => { e.preventDefault(); handleCancel(); }}
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <span
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
      onClick={(e) => { e.stopPropagation(); setEditing(true); }}
      title="Click to rename"
    >
      <span style={{ color: 'var(--rcf-ink)', fontWeight: 700, fontSize: '0.85rem' }}>{name}</span>
      {hovered && (
        <Pencil size={12} strokeWidth={1.8} style={{ color: 'var(--rcf-azure-deep)', opacity: 0.7, flexShrink: 0 }} />
      )}
    </span>
  );
}

function TrunkRow({ trunk, isExpanded, onToggleExpand, onToggleEnabled, onDelete }: TrunkRowProps) {
  return (
    <>
      <tr
        className="dl-row"
        style={{
          cursor: 'pointer',
          background: isExpanded ? '#eef4fe' : undefined,
        }}
        onClick={() => onToggleExpand(trunk.id)}
      >
        {/* ID */}
        <td className="dlx-td">
          <span style={{ color: 'var(--rcf-ink-dim)', fontFamily: MONO, fontSize: '0.76rem' }}>
            #{trunk.id}
          </span>
        </td>

        {/* Trunk Name */}
        <td className="dlx-td">
          <InlineTrunkName trunkId={trunk.id} name={trunk.trunk_name} />
        </td>

        {/* Customer */}
        <td className="dlx-td">
          {trunk.customer_name ?? `#${trunk.customer_id}`}
        </td>

        {/* Auth Type */}
        <td className="dlx-td">
          <AuthTypeTag type={trunk.auth_type} />
        </td>

        {/* Max Channels */}
        <td className="dlx-td" style={{ color: 'var(--rcf-ink)', fontVariantNumeric: 'tabular-nums' }}>
          {trunk.max_channels}
        </td>

        {/* CPS */}
        <td className="dlx-td" style={{ color: 'var(--rcf-ink)', fontVariantNumeric: 'tabular-nums' }}>
          {trunk.cps_limit}
        </td>

        {/* IPs */}
        <td className="dlx-td" style={{ color: 'var(--rcf-ink-dim)', fontVariantNumeric: 'tabular-nums' }}>
          {trunk.ip_count ?? '—'}
        </td>

        {/* DIDs */}
        <td className="dlx-td" style={{ color: 'var(--rcf-ink-dim)', fontVariantNumeric: 'tabular-nums' }}>
          {trunk.did_count ?? '—'}
        </td>

        {/* Status */}
        <td className="dlx-td">
          <EnabledPill enabled={trunk.enabled} />
        </td>

        {/* Actions */}
        <td
          className="dlx-td"
          style={{ textAlign: 'right' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
            {/* Enable / Disable toggle */}
            <button
              type="button"
              className="dl-btn dl-btn-ghost dlx-btn-sm"
              title={trunk.enabled ? 'Disable trunk' : 'Enable trunk'}
              onClick={() => onToggleEnabled(trunk)}
            >
              {trunk.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              type="button"
              className="dl-btn dl-btn-danger dlx-btn-sm"
              title="Delete trunk"
              onClick={() => onDelete(trunk)}
            >
              Delete
            </button>
          </div>
        </td>
      </tr>

      {/* Expanded detail row */}
      {isExpanded && (
        <tr>
          <td colSpan={COL_COUNT} style={{ padding: 0 }}>
            <div className="dlx-xwrap">
              <div>
                <TrunkExpanded
                  trunk={trunk}
                  onDelete={() => {
                    if (!confirm(`Delete trunk "${trunk.trunk_name}"?\n\nThis will remove all associated IPs and DIDs. This cannot be undone.`)) return;
                    onDelete(trunk);
                  }}
                />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Daylight Capacity + Authorized-IPs sections ─────────────────────────────
// Presentation-only re-renders of the shared TrunkCapacityFields sections,
// driven by the SAME controllers so validation + payload stay identical.
// Exported for reuse by CustomerTrunkSection (customer-360 create-trunk form).

function CapacityModeToggle({
  mode,
  onChange,
}: {
  mode: CapacityMode;
  onChange: (mode: CapacityMode) => void;
}) {
  const options: { value: CapacityMode; label: string }[] = [
    { value: 'tier', label: 'Purchased tier' },
    { value: 'custom', label: 'Custom' },
  ];
  return (
    <div className="dlx-seg" role="radiogroup" aria-label="Capacity source" style={{ marginBottom: 14 }}>
      {options.map((opt) => {
        const active = mode === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            className={active ? 'dlx-seg-btn dlx-seg-btn-active' : 'dlx-seg-btn'}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export function DaylightCapacitySection({ ctl }: { ctl: TrunkCapacityController }) {
  return (
    <div>
      <h4 className="dl-section-title">Capacity</h4>

      <CapacityModeToggle mode={ctl.mode} onChange={ctl.setMode} />

      {ctl.mode === 'tier' ? (
        <div>
          {ctl.tiersLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--rcf-ink-dim)', fontSize: '0.8rem', padding: '6px 0' }}>
              <Spinner size="xs" /> Loading tiers…
            </div>
          ) : ctl.tiersError ? (
            <div style={{ fontSize: '0.8rem', color: 'var(--rcf-red)' }}>
              Could not load tiers. Switch to Custom to set CPS and call paths manually.
            </div>
          ) : (
            <div style={{ maxWidth: 460 }}>
              <Field label="Service Tier">
                <select
                  className="dl-input"
                  value={ctl.tierId}
                  onChange={(e) => ctl.setTierId(e.target.value)}
                >
                  <option value="">Select tier…</option>
                  {ctl.tiers.map((tier) => (
                    <option key={tier.id} value={tier.id}>
                      {formatTierOption(tier)}
                    </option>
                  ))}
                </select>
              </Field>
              <p className="dl-help">Server derives CPS and call paths from the selected tier.</p>
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, maxWidth: 460 }}>
          <div>
            <Field label="CPS">
              <input
                className="dl-input"
                type="number"
                min="1"
                step="1"
                value={ctl.customCps}
                onChange={(e) => ctl.setCustomCps(e.target.value)}
                placeholder="1"
              />
            </Field>
            <p className="dl-help">Calls per second</p>
          </div>
          <div>
            <Field label="Call Paths">
              <input
                className="dl-input"
                type="number"
                min="1"
                step="1"
                value={ctl.customPaths}
                onChange={(e) => ctl.setCustomPaths(e.target.value)}
                placeholder="20"
              />
            </Field>
            <p className="dl-help">Max concurrent channels</p>
          </div>
        </div>
      )}
    </div>
  );
}

export function DaylightAuthIpsSection({ ctl }: { ctl: TrunkAuthIpsController }) {
  const canAdd = ctl.draft.trim().length > 0 && ctl.draftError === null;

  return (
    <div>
      <h4 className="dl-section-title">Authorized IPs</h4>
      <p className="dl-help" style={{ margin: '0 0 10px' }}>
        Whitelist the customer&apos;s PBX IPs (IPv4, optional /CIDR). Optional — you can add
        more later.
      </p>

      {ctl.ips.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          {ctl.ips.map((ip) => (
            <span key={ip} className="dl-chip" style={{ gap: 8 }}>
              {ip}
              <button
                type="button"
                className="dlx-xbtn"
                style={{ width: 16, height: 16, fontSize: '0.6rem' }}
                onClick={() => ctl.remove(ip)}
                title={`Remove ${ip}`}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 220px', minWidth: 160, maxWidth: 320 }}>
          <Field label="IP Address">
            <input
              className="dl-input dl-input-mono"
              value={ctl.draft}
              onChange={(e) => ctl.setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  ctl.add();
                }
              }}
              placeholder="203.0.113.10 or 203.0.113.0/24"
              style={{ width: '100%' }}
            />
          </Field>
          {ctl.draftError && (
            <p className="dl-help" style={{ color: 'var(--rcf-red)' }}>{ctl.draftError}</p>
          )}
        </div>
        <div style={{ paddingTop: 22, flexShrink: 0 }}>
          <button type="button" className="dl-btn dl-btn-ghost" disabled={!canAdd} onClick={ctl.add}>
            + Add IP
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Create Trunk Form ────────────────────────────────────────────────────────

interface CreateTrunkFormProps {
  onClose: () => void;
}

function CreateTrunkForm({ onClose }: CreateTrunkFormProps) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [form, setForm] = useState<CreateFormState>(INITIAL_CREATE);

  // Capacity + Authorized-IP controllers own their own state and the shared
  // ['trunk-tiers'] query. Declared here (hooks-first, above any early return)
  // so hook order stays stable — React #310.
  const capacity = useTrunkCapacity();
  const authIps = useTrunkAuthIps();

  const { data: customersData } = useQuery({
    queryKey: ['customers', { limit: 500 }],
    queryFn: () => listCustomers({ limit: 500 }),
  });

  const mutation = useMutation({
    mutationFn: () =>
      createTrunk({
        customer_id: parseInt(form.customer_id, 10),
        trunk_name: form.trunk_name.trim(),
        auth_type: form.auth_type,
        // tier → { cps_tier_id }; custom → { cps_limit, max_channels }
        ...capacity.buildPayload(),
        ...(authIps.ips.length > 0 ? { auth_ips: authIps.ips } : {}),
      }),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['trunks'] });
      setForm(INITIAL_CREATE);
      capacity.reset();
      authIps.reset();
      toastOk(`Trunk "${created.trunk_name}" created`);
      onClose();
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.customer_id) { toastErr('Please select a customer'); return; }
    if (!form.trunk_name.trim()) { toastErr('Trunk name is required'); return; }
    const capacityError = capacity.validate();
    if (capacityError) { toastErr(capacityError); return; }
    mutation.mutate();
  }

  return (
    <section className="dl-panel">
      <div className="dl-panel-head">
        <h2 className="dl-panel-title">New SIP Trunk</h2>
      </div>
      <form onSubmit={handleSubmit} className="dl-panel-body">
        <div className="dlx-form-grid" style={{ marginBottom: 16 }}>
          {/* Customer */}
          <Field label="Customer">
            <select
              className="dl-input"
              value={form.customer_id}
              onChange={(e) => setForm((p) => ({ ...p, customer_id: e.target.value }))}
              required
            >
              <option value="">Select customer…</option>
              {(customersData?.items ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>

          {/* Trunk name */}
          <Field label="Trunk Name">
            <input
              className="dl-input"
              value={form.trunk_name}
              onChange={(e) => setForm((p) => ({ ...p, trunk_name: e.target.value }))}
              placeholder="Acme Main Trunk"
              required
            />
          </Field>

          {/* Auth type */}
          <Field label="Auth Type">
            <select
              className="dl-input"
              value={form.auth_type}
              onChange={(e) => setForm((p) => ({ ...p, auth_type: e.target.value as TrunkAuthType }))}
            >
              <option value="ip">IP Authentication</option>
              <option value="credentials">Credentials</option>
              <option value="both">Both</option>
            </select>
          </Field>
        </div>

        {/* Capacity — purchased tier OR custom CPS / call paths */}
        <div style={{ marginBottom: 20, paddingTop: 20, borderTop: '1px solid var(--rcf-line)' }}>
          <DaylightCapacitySection ctl={capacity} />
        </div>

        {/* Authorized IPs — optional whitelist at creation */}
        <div style={{ marginBottom: 20, paddingTop: 20, borderTop: '1px solid var(--rcf-line)' }}>
          <DaylightAuthIpsSection ctl={authIps} />
        </div>

        <div style={{ display: 'flex', gap: 10, paddingTop: 20, borderTop: '1px solid var(--rcf-line)' }}>
          <button type="submit" className="dl-btn dl-btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Creating…' : 'Create Trunk'}
          </button>
          <button
            type="button"
            className="dl-btn dl-btn-ghost"
            onClick={() => {
              setForm(INITIAL_CREATE);
              capacity.reset();
              authIps.reset();
              onClose();
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function TrunksAdminPage() {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const [search, setSearch] = useState('');
  const [committedSearch, setCommittedSearch] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['trunks', { search: committedSearch }],
    queryFn: () => listTrunks({ search: committedSearch, limit: 500 }),
  });

  const toggleEnabledMutation = useMutation({
    mutationFn: (trunk: Trunk) => updateTrunk(trunk.id, { enabled: !trunk.enabled }),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ['trunks'] });
      toastOk(`Trunk "${updated.trunk_name}" ${updated.enabled ? 'enabled' : 'disabled'}`);
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteTrunk(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trunks'] });
      setExpandedId(null);
      toastOk('Trunk deleted');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setCommittedSearch(search);
  }

  function handleToggleExpand(id: number) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  function handleDelete(trunk: Trunk) {
    deleteMutation.mutate(trunk.id);
  }

  const trunks = data?.items ?? [];

  return (
    <div className="dl-stack">
      {/* ── Toolbar ── */}
      <div className="dlx-toolbar" style={{ marginBottom: 0 }}>
        <form onSubmit={handleSearch} className="dlx-toolbar-form">
          <input
            type="search"
            className="dl-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search trunks…"
            style={{ flex: 1, maxWidth: 400 }}
          />
          <button type="submit" className="dl-btn dl-btn-ghost" style={{ flexShrink: 0 }}>
            Search
          </button>
        </form>

        {/* Summary count */}
        {data && (
          <span className="dl-count">
            {trunks.length} trunk{trunks.length !== 1 ? 's' : ''}
          </span>
        )}

        <button
          type="button"
          className="dl-btn dl-btn-primary"
          onClick={() => setShowCreateForm((v) => !v)}
          style={{ flexShrink: 0, marginLeft: 'auto' }}
        >
          {showCreateForm ? 'Cancel' : '+ New Trunk'}
        </button>
      </div>

      {/* ── Create form ── */}
      {showCreateForm && (
        <CreateTrunkForm onClose={() => setShowCreateForm(false)} />
      )}

      {/* ── Loading state ── */}
      {isLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--rcf-ink-dim)', fontSize: '0.85rem', padding: '48px 0' }}>
          <Spinner /> Loading trunks…
        </div>
      )}

      {/* ── Error state ── */}
      {isError && (
        <div className="dl-banner dl-banner-err">
          Failed to load trunks. Please try again.
        </div>
      )}

      {/* ── Trunks table ── */}
      {data && (
        <section className="dl-panel">
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 920 }}>
              <thead>
                <tr>
                  {['ID', 'Trunk Name', 'Customer', 'Auth Type', 'Max Ch.', 'CPS', 'IPs', 'DIDs', 'Status', 'Actions'].map((h) => (
                    <th key={h} className="dl-th" style={h === 'Actions' ? { textAlign: 'right' } : undefined}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trunks.length === 0 ? (
                  <tr>
                    <td colSpan={COL_COUNT} style={{ padding: 0 }}>
                      <div className="dl-empty" style={{ border: 'none', borderRadius: 0 }}>
                        No trunks found.
                      </div>
                    </td>
                  </tr>
                ) : (
                  trunks.map((trunk) => (
                    <TrunkRow
                      key={trunk.id}
                      trunk={trunk}
                      isExpanded={expandedId === trunk.id}
                      onToggleExpand={handleToggleExpand}
                      onToggleEnabled={(t) => toggleEnabledMutation.mutate(t)}
                      onDelete={handleDelete}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
