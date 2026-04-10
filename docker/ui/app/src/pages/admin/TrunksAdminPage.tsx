import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
import { Button } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';
import { Spinner } from '../../components/ui/Spinner';
import { FormField } from '../../components/ui/FormField';
import { TableWrap, Table, Thead, Th } from '../../components/ui/Table';
import { useToast } from '../../components/ui/ToastContext';
import type { Trunk, TrunkAuthType, TrunkIp, TrunkDid } from '../../types/trunk';

// ─── Constants ───────────────────────────────────────────────────────────────

const ACCENT = '#f59e0b';
const SIP_SERVER = '34.74.71.32:5060';
const COL_COUNT = 10;

const CELL_STYLE: React.CSSProperties = {
  padding: '13px 16px',
  borderBottom: '1px solid rgba(42,47,69,0.45)',
  verticalAlign: 'middle',
};

// ─── Types ───────────────────────────────────────────────────────────────────

interface CreateFormState {
  customer_id: string;
  trunk_name: string;
  auth_type: TrunkAuthType;
  max_channels: string;
  cps_limit: string;
}

const INITIAL_CREATE: CreateFormState = {
  customer_id: '',
  trunk_name: '',
  auth_type: 'ip',
  max_channels: '10',
  cps_limit: '5',
};

interface EditFormState {
  trunk_name: string;
  max_channels: string;
  cps_limit: string;
  enabled: boolean;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function AuthTypeBadge({ type }: { type: TrunkAuthType }) {
  if (type === 'ip') return <Badge variant="rcf">IP</Badge>;
  if (type === 'credentials') return <Badge variant="api">Creds</Badge>;
  return <Badge variant="hybrid">Both</Badge>;
}

function EnabledBadge({ enabled }: { enabled: boolean }) {
  return enabled
    ? <Badge variant="active">Enabled</Badge>
    : <Badge variant="disabled">Disabled</Badge>;
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
      <div
        style={{
          fontSize: '0.65rem',
          fontWeight: 700,
          color: ACCENT,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          marginBottom: 12,
        }}
      >
        Authorized PBX IPs
      </div>

      {isLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#718096', fontSize: '0.8rem', marginBottom: 12 }}>
          <Spinner size="xs" /> Loading IPs…
        </div>
      )}

      {ips && ips.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {ips.map((ip) => (
            <div
              key={ip.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 12px',
                borderRadius: 8,
                background: 'rgba(15,17,23,0.6)',
                border: '1px solid rgba(42,47,69,0.5)',
              }}
            >
              <span style={{ fontFamily: 'monospace', fontSize: '0.82rem', color: '#e2e8f0', flex: 1 }}>
                {ip.ip_address}
              </span>
              {ip.description && (
                <span style={{ fontSize: '0.75rem', color: '#718096' }}>{ip.description}</span>
              )}
              <button
                type="button"
                onClick={() => {
                  if (!confirm(`Remove IP ${ip.ip_address}?`)) return;
                  deleteMutation.mutate(ip.id);
                }}
                disabled={deleteMutation.isPending}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: '#f87171',
                  fontSize: '0.75rem',
                  padding: '2px 6px',
                  borderRadius: 4,
                  opacity: deleteMutation.isPending ? 0.5 : 1,
                }}
                title="Remove IP"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {ips && ips.length === 0 && !isLoading && (
        <div style={{ fontSize: '0.8rem', color: '#4a5568', marginBottom: 12 }}>No IPs configured.</div>
      )}

      <form onSubmit={handleAddIp} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div style={{ flex: '0 0 180px' }}>
          <FormField
            label="IP Address"
            value={newIp}
            onChange={(e) => setNewIp((e.target as HTMLInputElement).value)}
            placeholder="192.168.1.1"
          />
        </div>
        <div style={{ flex: 1 }}>
          <FormField
            label="Description (optional)"
            value={newIpDesc}
            onChange={(e) => setNewIpDesc((e.target as HTMLInputElement).value)}
            placeholder="Main PBX"
          />
        </div>
        <Button type="submit" variant="ghost" size="sm" loading={addMutation.isPending}>
          + Add IP
        </Button>
      </form>
    </div>
  );
}

// ─── DID Management Section ───────────────────────────────────────────────────

function DidSection({ trunk }: { trunk: Trunk }) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [newDid, setNewDid] = useState('');

  const { data: dids, isLoading } = useQuery<TrunkDid[]>({
    queryKey: ['trunk-dids', trunk.id],
    queryFn: () => getTrunkDids(trunk.id),
  });

  const addMutation = useMutation({
    mutationFn: () => addTrunkDid(trunk.id, newDid.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trunk-dids', trunk.id] });
      qc.invalidateQueries({ queryKey: ['trunks'] });
      setNewDid('');
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

  function handleAddDid(e: React.FormEvent) {
    e.preventDefault();
    if (!newDid.trim()) { toastErr('DID is required'); return; }
    addMutation.mutate();
  }

  return (
    <div>
      <div
        style={{
          fontSize: '0.65rem',
          fontWeight: 700,
          color: ACCENT,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          marginBottom: 12,
        }}
      >
        Assigned DIDs
      </div>

      {isLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#718096', fontSize: '0.8rem', marginBottom: 12 }}>
          <Spinner size="xs" /> Loading DIDs…
        </div>
      )}

      {dids && dids.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {dids.map((did) => (
            <div
              key={did.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 12px',
                borderRadius: 8,
                background: 'rgba(15,17,23,0.6)',
                border: '1px solid rgba(42,47,69,0.5)',
              }}
            >
              <span style={{ fontFamily: 'monospace', fontSize: '0.82rem', color: '#e2e8f0', flex: 1 }}>
                {did.did}
              </span>
              <EnabledBadge enabled={did.enabled} />
              <button
                type="button"
                onClick={() => {
                  if (!confirm(`Remove DID ${did.did}?`)) return;
                  deleteMutation.mutate(did.id);
                }}
                disabled={deleteMutation.isPending}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: '#f87171',
                  fontSize: '0.75rem',
                  padding: '2px 6px',
                  borderRadius: 4,
                  opacity: deleteMutation.isPending ? 0.5 : 1,
                }}
                title="Remove DID"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {dids && dids.length === 0 && !isLoading && (
        <div style={{ fontSize: '0.8rem', color: '#4a5568', marginBottom: 12 }}>No DIDs assigned.</div>
      )}

      <form onSubmit={handleAddDid} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div style={{ flex: '0 0 240px' }}>
          <FormField
            label="DID / Phone Number"
            value={newDid}
            onChange={(e) => setNewDid((e.target as HTMLInputElement).value)}
            placeholder="+14155551234"
          />
        </div>
        <Button type="submit" variant="ghost" size="sm" loading={addMutation.isPending}>
          + Add DID
        </Button>
      </form>
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
      <div
        style={{
          fontSize: '0.65rem',
          fontWeight: 700,
          color: ACCENT,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          marginBottom: 16,
        }}
      >
        Edit Trunk Settings
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 16 }}>
        <FormField
          label="Trunk Name"
          value={form.trunk_name}
          onChange={(e) => setForm((p) => ({ ...p, trunk_name: (e.target as HTMLInputElement).value }))}
          required
        />
        <FormField
          label="Max Channels"
          type="number"
          min="1"
          value={form.max_channels}
          onChange={(e) => setForm((p) => ({ ...p, max_channels: (e.target as HTMLInputElement).value }))}
        />
        <FormField
          label="CPS Limit"
          type="number"
          min="1"
          value={form.cps_limit}
          onChange={(e) => setForm((p) => ({ ...p, cps_limit: (e.target as HTMLInputElement).value }))}
        />
      </div>

      {/* Enabled toggle */}
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          cursor: 'pointer',
          marginBottom: 20,
          width: 'fit-content',
        }}
      >
        <div
          onClick={() => setForm((p) => ({ ...p, enabled: !p.enabled }))}
          style={{
            width: 40,
            height: 22,
            borderRadius: 11,
            background: form.enabled ? '#059669' : 'rgba(42,47,69,0.8)',
            border: `1px solid ${form.enabled ? '#10b981' : 'rgba(42,47,69,0.8)'}`,
            position: 'relative',
            cursor: 'pointer',
            transition: 'background 0.2s, border-color 0.2s',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 2,
              left: form.enabled ? 20 : 2,
              width: 16,
              height: 16,
              borderRadius: '50%',
              background: '#fff',
              transition: 'left 0.2s',
              boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
            }}
          />
        </div>
        <span style={{ fontSize: '0.8rem', color: form.enabled ? '#10b981' : '#718096', fontWeight: 600 }}>
          {form.enabled ? 'Enabled' : 'Disabled'}
        </span>
      </label>

      <Button type="submit" variant="primary" size="sm" loading={mutation.isPending}>
        Save Changes
      </Button>
    </form>
  );
}

// ─── Connection Info ──────────────────────────────────────────────────────────

function ConnectionInfo() {
  return (
    <div>
      <div
        style={{
          fontSize: '0.65rem',
          fontWeight: 700,
          color: ACCENT,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          marginBottom: 12,
        }}
      >
        Connection Info
      </div>
      <div
        style={{
          padding: '12px 16px',
          borderRadius: 8,
          background: 'rgba(245,158,11,0.06)',
          border: '1px solid rgba(245,158,11,0.2)',
          fontSize: '0.82rem',
          color: '#718096',
          lineHeight: 1.7,
        }}
      >
        <div style={{ marginBottom: 6 }}>Point your customer&apos;s PBX to:</div>
        <div
          style={{
            fontFamily: 'monospace',
            fontSize: '0.95rem',
            color: ACCENT,
            fontWeight: 700,
            letterSpacing: '0.02em',
          }}
        >
          {SIP_SERVER}
        </div>
        <div style={{ marginTop: 6, fontSize: '0.75rem', color: '#4a5568' }}>
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
    <div
      style={{
        borderLeft: `3px solid ${ACCENT}`,
        padding: '24px 28px',
        background: 'linear-gradient(135deg, rgba(19,21,29,0.98) 0%, rgba(15,17,23,1) 100%)',
      }}
    >
      {/* Top action bar */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 24 }}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setIsEditing((v) => !v)}
        >
          {isEditing ? 'Cancel Edit' : 'Edit Trunk'}
        </Button>
        <Button
          variant="danger"
          size="sm"
          onClick={onDelete}
        >
          Delete Trunk
        </Button>
      </div>

      {/* Edit form */}
      {isEditing && (
        <div
          style={{
            marginBottom: 28,
            paddingBottom: 28,
            borderBottom: '1px solid rgba(42,47,69,0.5)',
          }}
        >
          <EditTrunkForm trunk={trunk} onSaved={() => setIsEditing(false)} />
        </div>
      )}

      {/* Three column sections */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr',
          gap: 32,
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
  const [value, setValue] = useState(name);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);

  const [prev, setPrev] = useState(name);
  if (name !== prev) { setPrev(name); setValue(name); }

  const mutation = useMutation({
    mutationFn: (n: string) => updateTrunk(trunkId, { trunk_name: n }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin-trunks'] }); },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleBlur() {
    setFocused(false);
    const trimmed = value.trim();
    if (!trimmed) { setValue(name); return; }
    if (trimmed !== name) mutation.mutate(trimmed);
  }

  return (
    <span
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}
    >
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={handleBlur}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }}
        onClick={(e) => e.stopPropagation()}
        disabled={mutation.isPending}
        title="Click to rename"
        style={{
          color: '#e2e8f0',
          fontWeight: 600,
          fontSize: '0.875rem',
          background: focused ? 'rgba(19,21,29,0.8)' : 'transparent',
          border: focused ? '1px solid rgba(245,158,11,0.5)' : '1px solid transparent',
          borderRadius: 5,
          outline: 'none',
          padding: focused ? '2px 6px' : '2px 0',
          fontFamily: 'inherit',
          cursor: focused ? 'text' : 'pointer',
          transition: 'border-color 150ms, background 150ms',
          opacity: mutation.isPending ? 0.5 : 1,
          boxShadow: focused ? '0 0 0 3px rgba(245,158,11,0.12)' : 'none',
          width: Math.max(value.length * 8.5 + 20, 80),
        }}
      />
      {!focused && hovered && (
        <svg viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth={1.5} style={{ width: 12, height: 12, opacity: 0.5, flexShrink: 0 }}>
          <path d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

function TrunkRow({ trunk, isExpanded, onToggleExpand, onToggleEnabled, onDelete }: TrunkRowProps) {
  return (
    <>
      <tr
        style={{
          cursor: 'pointer',
          transition: 'background 0.15s',
          background: isExpanded ? `rgba(245,158,11,0.05)` : 'transparent',
        }}
        onMouseEnter={(e) => {
          if (!isExpanded) {
            (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.018)';
          }
        }}
        onMouseLeave={(e) => {
          if (!isExpanded) {
            (e.currentTarget as HTMLTableRowElement).style.background = 'transparent';
          }
        }}
        onClick={() => onToggleExpand(trunk.id)}
      >
        {/* ID */}
        <td style={CELL_STYLE}>
          <span style={{ color: '#4a5568', fontFamily: 'monospace', fontSize: '0.78rem' }}>
            #{trunk.id}
          </span>
        </td>

        {/* Trunk Name */}
        <td style={CELL_STYLE}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                flexShrink: 0,
                background: isExpanded ? ACCENT : 'transparent',
                boxShadow: isExpanded ? `0 0 6px ${ACCENT}` : 'none',
                transition: 'background 0.2s, box-shadow 0.2s',
              }}
            />
            <InlineTrunkName trunkId={trunk.id} name={trunk.trunk_name} />
          </div>
        </td>

        {/* Customer */}
        <td style={CELL_STYLE}>
          <span style={{ color: '#a0aec0', fontSize: '0.83rem' }}>
            {trunk.customer_name ?? `#${trunk.customer_id}`}
          </span>
        </td>

        {/* Auth Type */}
        <td style={CELL_STYLE}>
          <AuthTypeBadge type={trunk.auth_type} />
        </td>

        {/* Max Channels */}
        <td style={CELL_STYLE}>
          <span style={{ color: '#e2e8f0', fontVariantNumeric: 'tabular-nums', fontSize: '0.875rem' }}>
            {trunk.max_channels}
          </span>
        </td>

        {/* CPS */}
        <td style={CELL_STYLE}>
          <span style={{ color: '#e2e8f0', fontVariantNumeric: 'tabular-nums', fontSize: '0.875rem' }}>
            {trunk.cps_limit}
          </span>
        </td>

        {/* IPs */}
        <td style={CELL_STYLE}>
          <span style={{ color: '#718096', fontSize: '0.83rem', fontVariantNumeric: 'tabular-nums' }}>
            {trunk.ip_count ?? '—'}
          </span>
        </td>

        {/* DIDs */}
        <td style={CELL_STYLE}>
          <span style={{ color: '#718096', fontSize: '0.83rem', fontVariantNumeric: 'tabular-nums' }}>
            {trunk.did_count ?? '—'}
          </span>
        </td>

        {/* Status */}
        <td style={CELL_STYLE}>
          <EnabledBadge enabled={trunk.enabled} />
        </td>

        {/* Actions */}
        <td
          style={{ ...CELL_STYLE, textAlign: 'right' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
            {/* Enable / Disable toggle */}
            <button
              type="button"
              title={trunk.enabled ? 'Disable trunk' : 'Enable trunk'}
              onClick={() => onToggleEnabled(trunk)}
              style={{
                background: 'none',
                border: `1px solid ${trunk.enabled ? 'rgba(16,185,129,0.3)' : 'rgba(42,47,69,0.8)'}`,
                borderRadius: 6,
                cursor: 'pointer',
                color: trunk.enabled ? '#10b981' : '#718096',
                fontSize: '0.72rem',
                padding: '4px 8px',
                fontWeight: 600,
                transition: 'all 0.15s',
              }}
            >
              {trunk.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              type="button"
              title="Delete trunk"
              onClick={() => onDelete(trunk)}
              style={{
                background: 'none',
                border: '1px solid rgba(239,68,68,0.25)',
                borderRadius: 6,
                cursor: 'pointer',
                color: '#f87171',
                fontSize: '0.72rem',
                padding: '4px 8px',
                fontWeight: 600,
                transition: 'all 0.15s',
              }}
            >
              Delete
            </button>
          </div>
        </td>
      </tr>

      {/* Expanded detail row */}
      {isExpanded && (
        <tr>
          <td
            colSpan={COL_COUNT}
            style={{
              padding: 0,
              borderBottom: '1px solid rgba(42,47,69,0.6)',
            }}
          >
            <TrunkExpanded
              trunk={trunk}
              onDelete={() => {
                if (!confirm(`Delete trunk "${trunk.trunk_name}"?\n\nThis will remove all associated IPs and DIDs. This cannot be undone.`)) return;
                onDelete(trunk);
              }}
            />
          </td>
        </tr>
      )}
    </>
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
        max_channels: parseInt(form.max_channels, 10) || 10,
        cps_limit: parseInt(form.cps_limit, 10) || 5,
      }),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['trunks'] });
      setForm(INITIAL_CREATE);
      toastOk(`Trunk "${created.trunk_name}" created`);
      onClose();
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.customer_id) { toastErr('Please select a customer'); return; }
    if (!form.trunk_name.trim()) { toastErr('Trunk name is required'); return; }
    mutation.mutate();
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 16,
        padding: '28px 28px 24px',
        boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Amber accent line */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 32,
          right: 32,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${ACCENT}, transparent)`,
          opacity: 0.6,
        }}
      />

      <div
        style={{
          fontSize: '0.65rem',
          fontWeight: 700,
          color: ACCENT,
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          marginBottom: 20,
        }}
      >
        New SIP Trunk
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 16 }}>
        {/* Customer */}
        <FormField
          label="Customer"
          as="select"
          value={form.customer_id}
          onChange={(e) => setForm((p) => ({ ...p, customer_id: (e.target as HTMLSelectElement).value }))}
          required
        >
          <option value="">Select customer…</option>
          {(customersData?.items ?? []).map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </FormField>

        {/* Trunk name */}
        <FormField
          label="Trunk Name"
          value={form.trunk_name}
          onChange={(e) => setForm((p) => ({ ...p, trunk_name: (e.target as HTMLInputElement).value }))}
          placeholder="Acme Main Trunk"
          required
        />

        {/* Auth type */}
        <FormField
          label="Auth Type"
          as="select"
          value={form.auth_type}
          onChange={(e) => setForm((p) => ({ ...p, auth_type: (e.target as HTMLSelectElement).value as TrunkAuthType }))}
        >
          <option value="ip">IP Authentication</option>
          <option value="credentials">Credentials</option>
          <option value="both">Both</option>
        </FormField>

        {/* Max Channels */}
        <FormField
          label="Max Channels"
          type="number"
          min="1"
          value={form.max_channels}
          onChange={(e) => setForm((p) => ({ ...p, max_channels: (e.target as HTMLInputElement).value }))}
        />

        {/* CPS Limit */}
        <FormField
          label="CPS Limit"
          type="number"
          min="1"
          value={form.cps_limit}
          onChange={(e) => setForm((p) => ({ ...p, cps_limit: (e.target as HTMLInputElement).value }))}
        />
      </div>

      <div
        style={{
          display: 'flex',
          gap: 8,
          paddingTop: 20,
          borderTop: '1px solid rgba(42,47,69,0.6)',
        }}
      >
        <Button type="submit" variant="primary" size="sm" loading={mutation.isPending}>
          Create Trunk
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setForm(INITIAL_CREATE);
            onClose();
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          flexWrap: 'wrap',
          background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
          border: '1px solid rgba(42,47,69,0.6)',
          borderRadius: 12,
          padding: '20px 24px',
          marginBottom: 4,
        }}
      >
        <form onSubmit={handleSearch} style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 280 }}>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search trunks…"
            style={{
              fontSize: '0.875rem',
              padding: '8px 14px',
              height: 38,
              borderRadius: 8,
              border: '1px solid rgba(42,47,69,0.8)',
              background: 'rgba(13,15,21,0.8)',
              color: '#e2e8f0',
              outline: 'none',
              transition: 'border-color 0.15s, box-shadow 0.15s',
              minWidth: 260,
              width: '100%',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = ACCENT;
              e.currentTarget.style.boxShadow = `0 0 0 3px rgba(245,158,11,0.15)`;
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'rgba(42,47,69,0.8)';
              e.currentTarget.style.boxShadow = 'none';
            }}
          />
          <Button type="submit" variant="ghost" size="sm" style={{ flexShrink: 0 }}>
            Search
          </Button>
        </form>

        {/* Summary badge */}
        {data && (
          <span style={{ color: '#4a5568', fontSize: '0.8rem', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
            {trunks.length} trunk{trunks.length !== 1 ? 's' : ''}
          </span>
        )}

        <Button
          variant="primary"
          size="sm"
          onClick={() => setShowCreateForm((v) => !v)}
          style={{ background: ACCENT, borderColor: 'transparent', flexShrink: 0, marginLeft: 4 }}
        >
          {showCreateForm ? 'Cancel' : '+ New Trunk'}
        </Button>
      </div>

      {/* Create form */}
      {showCreateForm && (
        <CreateTrunkForm onClose={() => setShowCreateForm(false)} />
      )}

      {/* Loading state */}
      {isLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#718096', padding: '48px 0' }}>
          <Spinner /> Loading trunks…
        </div>
      )}

      {/* Error state */}
      {isError && (
        <div
          style={{
            padding: '16px 20px',
            borderRadius: 12,
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.2)',
            color: '#f87171',
            fontSize: '0.875rem',
          }}
        >
          Failed to load trunks. Please try again.
        </div>
      )}

      {/* Trunks table */}
      {data && (
        <TableWrap>
          <Table>
            <Thead>
              <tr>
                <Th>ID</Th>
                <Th>Trunk Name</Th>
                <Th>Customer</Th>
                <Th>Auth Type</Th>
                <Th>Max Ch.</Th>
                <Th>CPS</Th>
                <Th>IPs</Th>
                <Th>DIDs</Th>
                <Th>Status</Th>
                <Th>Actions</Th>
              </tr>
            </Thead>
            <tbody>
              {trunks.length === 0 ? (
                <tr>
                  <td
                    colSpan={COL_COUNT}
                    style={{
                      padding: '48px 16px',
                      textAlign: 'center',
                      color: '#718096',
                      fontSize: '0.875rem',
                    }}
                  >
                    No trunks found.
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
          </Table>
        </TableWrap>
      )}
    </div>
  );
}
