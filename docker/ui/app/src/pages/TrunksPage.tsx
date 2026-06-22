import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { PortalHeader } from './RcfPage';
import { AdminCustomerSelector } from '../components/AdminCustomerSelector';
import { useAuth } from '../contexts/AuthContext';
import { IconTrunk } from '../components/icons/ProductIcons';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Modal } from '../components/ui/Modal';
import { FormField } from '../components/ui/FormField';
import { StatCard } from '../components/ui/StatCard';
import { Spinner } from '../components/ui/Spinner';
import { useToast } from '../components/ui/Toast';
import { fmt, fmtMoney } from '../utils/format';
import {
  listTrunks,
  createTrunk,
  deleteTrunk,
  getTrunkStats,
  getTrunkIps,
  addTrunkIp,
  deleteTrunkIp,
  getTrunkDids,
} from '../api/trunks';
import type { Trunk, TrunkIp, TrunkDid, TrunkStats, TrunkAuthType } from '../types/trunk';

const ACCENT = '#fbbf24';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Validates an IPv4 address, optionally with a CIDR suffix (e.g. 203.0.113.0/24). */
function isValidIpv4(input: string): boolean {
  const [addr, mask, ...rest] = input.trim().split('/');
  if (rest.length > 0) return false;
  const parts = addr.split('.');
  if (parts.length !== 4) return false;
  const okAddr = parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
  if (!okAddr) return false;
  if (mask !== undefined) {
    if (!/^\d{1,2}$/.test(mask)) return false;
    const n = Number(mask);
    if (n < 0 || n > 32) return false;
  }
  return true;
}

const AUTH_LABEL: Record<TrunkAuthType, string> = {
  ip: 'IP authentication',
  credentials: 'Credential authentication',
  both: 'IP + Credential authentication',
};

// ─── Section heading ──────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h4
      style={{
        fontSize: '0.68rem',
        fontWeight: 700,
        color: '#718096',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        marginBottom: 10,
      }}
    >
      {children}
    </h4>
  );
}

// ─── Live stats (StatCard grid + manual refresh) ─────────────────────────────

function TrunkLiveStats({ trunkId, maxChannels }: { trunkId: number; maxChannels: number }) {
  const statsQuery = useQuery<TrunkStats>({
    queryKey: ['trunk-stats', trunkId],
    queryFn: () => getTrunkStats(trunkId),
    refetchInterval: 15_000,
    staleTime: 5_000,
  });

  const s = statsQuery.data;
  const active = s?.active_channels ?? 0;

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <SectionLabel>Live activity</SectionLabel>
        <button
          type="button"
          onClick={() => void statsQuery.refetch()}
          disabled={statsQuery.isFetching}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            background: 'rgba(251,191,36,0.08)',
            border: '1px solid rgba(251,191,36,0.22)',
            borderRadius: 7,
            padding: '4px 11px',
            fontSize: '0.7rem',
            fontWeight: 600,
            color: ACCENT,
            cursor: statsQuery.isFetching ? 'wait' : 'pointer',
            opacity: statsQuery.isFetching ? 0.6 : 1,
          }}
        >
          {statsQuery.isFetching ? (
            <Spinner size="xs" />
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 12, height: 12 }}>
              <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
          Refresh
        </button>
      </div>

      {statsQuery.isError ? (
        <p style={{ fontSize: '0.8rem', color: '#f87171', margin: 0 }}>
          Live statistics are temporarily unavailable.
        </p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard
            label="Active Channels"
            icon="📡"
            value={
              statsQuery.isLoading ? (
                '…'
              ) : (
                <>
                  {active}
                  <span style={{ fontSize: '0.95rem', fontWeight: 500, color: '#718096' }}> / {maxChannels}</span>
                </>
              )
            }
          />
          <StatCard label="Calls Today" icon="📞" value={statsQuery.isLoading ? '…' : (s?.calls_today ?? 0).toLocaleString()} />
          <StatCard label="Minutes Today" icon="⏱️" value={statsQuery.isLoading ? '…' : Math.round(s?.minutes_today ?? 0).toLocaleString()} />
          <StatCard label="Cost Today" icon="💵" value={statsQuery.isLoading ? '…' : fmtMoney(s?.cost_today ?? 0)} />
        </div>
      )}
    </section>
  );
}

// ─── Authorized IP management ────────────────────────────────────────────────

function TrunkIpManager({ trunkId, canManage }: { trunkId: number; canManage: boolean }) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [newIp, setNewIp] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [touched, setTouched] = useState(false);

  const ipsQuery = useQuery<TrunkIp[]>({
    queryKey: ['trunk-ips', trunkId],
    queryFn: () => getTrunkIps(trunkId),
    staleTime: 30_000,
  });

  const addMutation = useMutation({
    mutationFn: () => addTrunkIp(trunkId, newIp.trim(), newDesc.trim() || undefined),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['trunk-ips', trunkId] });
      void qc.invalidateQueries({ queryKey: ['trunks'] });
      setNewIp('');
      setNewDesc('');
      setTouched(false);
      toastOk('Authorized IP added');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (ipId: number) => deleteTrunkIp(trunkId, ipId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['trunk-ips', trunkId] });
      void qc.invalidateQueries({ queryKey: ['trunks'] });
      toastOk('IP removed');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const ipValid = isValidIpv4(newIp);
  const showError = touched && newIp.trim().length > 0 && !ipValid;

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!ipValid) {
      toastErr('Enter a valid IPv4 address (optionally with a CIDR mask)');
      return;
    }
    addMutation.mutate();
  }

  function handleDelete(ip: TrunkIp) {
    if (!confirm(`Remove ${ip.ip_address} from the authorized IP list? Calls from this address will be rejected.`)) return;
    deleteMutation.mutate(ip.id);
  }

  const ips = ipsQuery.data ?? [];

  return (
    <section>
      <SectionLabel>
        Authorized PBX IPs{' '}
        <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 'normal', color: '#4a5568' }}>
          — source addresses permitted to send calls on this trunk
        </span>
      </SectionLabel>

      {ipsQuery.isLoading && (
        <div className="flex items-center gap-2 text-[#718096] text-[0.8rem]">
          <Spinner size="xs" /> Loading IPs…
        </div>
      )}

      {!ipsQuery.isLoading && ips.length === 0 && (
        <p style={{ fontSize: '0.82rem', color: '#fca5a5', margin: '0 0 4px' }}>
          No authorized IPs yet — add your PBX or SBC address below to start sending traffic.
        </p>
      )}

      {ips.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {ips.map((ip) => (
            <div
              key={ip.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                background: '#0d0f15',
                border: '1px solid rgba(42,47,69,0.6)',
                borderRadius: 8,
                padding: '7px 12px',
              }}
            >
              <span style={{ fontFamily: 'monospace', fontSize: '0.82rem', color: '#e2e8f0', flex: 1 }}>
                {ip.ip_address}
              </span>
              {ip.description && <span style={{ fontSize: '0.74rem', color: '#718096' }}>{ip.description}</span>}
              {canManage && (
                <button
                  type="button"
                  onClick={() => handleDelete(ip)}
                  title="Remove IP"
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    color: '#718096',
                    fontSize: '1.05rem',
                    lineHeight: 1,
                    padding: '0 2px',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#ef4444'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#718096'; }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {canManage && (
        <form onSubmit={handleAdd} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start', marginTop: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <input
              type="text"
              value={newIp}
              onChange={(e) => setNewIp(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="203.0.113.50"
              style={{
                fontSize: '0.82rem',
                fontFamily: 'monospace',
                padding: '7px 11px',
                borderRadius: 7,
                border: `1px solid ${showError ? 'rgba(239,68,68,0.55)' : 'rgba(42,47,69,0.6)'}`,
                background: '#0d0f15',
                color: '#e2e8f0',
                outline: 'none',
                width: 160,
              }}
            />
            {showError && <span style={{ fontSize: '0.66rem', color: '#f87171' }}>Invalid IPv4 address</span>}
          </div>
          <input
            type="text"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Description (optional)"
            style={{
              fontSize: '0.82rem',
              padding: '7px 11px',
              borderRadius: 7,
              border: '1px solid rgba(42,47,69,0.6)',
              background: '#0d0f15',
              color: '#e2e8f0',
              outline: 'none',
              width: 190,
            }}
          />
          <Button type="submit" variant="ghost" size="sm" loading={addMutation.isPending}>
            Add IP
          </Button>
        </form>
      )}
    </section>
  );
}

// ─── DID list (read-only) ─────────────────────────────────────────────────────

function TrunkDidList({ trunkId }: { trunkId: number }) {
  const didsQuery = useQuery<TrunkDid[]>({
    queryKey: ['trunk-dids', trunkId],
    queryFn: () => getTrunkDids(trunkId),
    staleTime: 30_000,
  });

  const dids = didsQuery.data ?? [];

  return (
    <section>
      <SectionLabel>Inbound DIDs routed to this trunk</SectionLabel>
      {didsQuery.isLoading ? (
        <div className="flex items-center gap-2 text-[#718096] text-[0.8rem]">
          <Spinner size="xs" /> Loading DIDs…
        </div>
      ) : dids.length === 0 ? (
        <p style={{ fontSize: '0.82rem', color: '#718096', margin: 0 }}>
          No DIDs are currently routed to this trunk.
        </p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {dids.map((d) => (
            <span
              key={d.id}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: '0.78rem',
                fontFamily: 'monospace',
                fontWeight: 600,
                background: 'rgba(30,33,48,0.8)',
                color: d.enabled ? '#e2e8f0' : '#718096',
                border: '1px solid rgba(42,47,69,0.6)',
                padding: '5px 11px',
                borderRadius: 7,
                textDecoration: d.enabled ? 'none' : 'line-through',
              }}
            >
              {fmt(d.did)}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Config summary ───────────────────────────────────────────────────────────

function ConfigRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'baseline', padding: '6px 0', borderBottom: '1px solid rgba(42,47,69,0.25)' }}>
      <span style={{ minWidth: 130, fontSize: '0.78rem', color: '#718096', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: '0.82rem', color: '#e2e8f0', fontFamily: 'monospace', wordBreak: 'break-all' }}>{value}</span>
    </div>
  );
}

function TrunkConfigSummary({ trunk }: { trunk: Trunk }) {
  return (
    <section>
      <SectionLabel>Trunk configuration</SectionLabel>
      <div style={{ background: 'rgba(13,15,23,0.6)', border: '1px solid rgba(42,47,69,0.5)', borderRadius: 10, padding: '10px 18px' }}>
        <ConfigRow label="Max channels" value={`${trunk.max_channels} concurrent`} />
        <ConfigRow label="CPS limit" value={`${trunk.cps_limit} calls/sec`} />
        <ConfigRow label="Authentication" value={AUTH_LABEL[trunk.auth_type]} />
        {trunk.tech_prefix && <ConfigRow label="Tech prefix" value={trunk.tech_prefix} />}
        <ConfigRow label="Call-path package" value={trunk.package_name ?? 'Default'} />
      </div>
      <p style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: '0.72rem', color: '#718096' }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 14,
            height: 14,
            borderRadius: '50%',
            border: '1px solid rgba(113,128,150,0.5)',
            fontSize: '0.55rem',
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          i
        </span>
        Contact support to change channel capacity, CPS limits, or your call-path package.
      </p>
    </section>
  );
}

// ─── Expanded detail ──────────────────────────────────────────────────────────

function TrunkDetail({ trunk, canManage }: { trunk: Trunk; canManage: boolean }) {
  return (
    <div
      style={{
        borderTop: '1px solid rgba(42,47,69,0.6)',
        padding: '22px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
        background: 'rgba(15,17,23,0.45)',
      }}
    >
      <TrunkLiveStats trunkId={trunk.id} maxChannels={trunk.max_channels} />
      <TrunkIpManager trunkId={trunk.id} canManage={canManage} />
      <TrunkDidList trunkId={trunk.id} />
      <TrunkConfigSummary trunk={trunk} />
    </div>
  );
}

// ─── Trunk card ───────────────────────────────────────────────────────────────

function TrunkRow({
  trunk,
  isAdmin,
  canManage,
  showCustomer,
  onDelete,
  deleting,
}: {
  trunk: Trunk;
  isAdmin: boolean;
  canManage: boolean;
  showCustomer: boolean;
  onDelete: (t: Trunk) => void;
  deleting: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 16,
        overflow: 'hidden',
        boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
        position: 'relative',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 32,
          right: 32,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${ACCENT}80, transparent)`,
          opacity: 0.35,
        }}
      />

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '22px 24px 16px' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: '1.1rem', fontWeight: 700, color: '#e2e8f0', letterSpacing: '-0.01em' }}>
              {trunk.trunk_name}
            </span>
            <Badge variant={trunk.enabled ? 'active' : 'disabled'}>{trunk.enabled ? 'Active' : 'Disabled'}</Badge>
            <span
              style={{
                background: 'rgba(251,191,36,0.12)',
                border: '1px solid rgba(251,191,36,0.28)',
                borderRadius: 5,
                padding: '2px 8px',
                fontSize: '0.66rem',
                fontWeight: 700,
                color: ACCENT,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              {trunk.auth_type} auth
            </span>
          </div>
          <div style={{ fontSize: '0.74rem', color: '#718096', marginTop: 5, display: 'flex', flexWrap: 'wrap', gap: '0 6px' }}>
            {showCustomer && trunk.customer_name && <span style={{ color: '#94a3b8' }}>{trunk.customer_name} ·</span>}
            <span>{trunk.max_channels} channels</span>
            <span>· {trunk.cps_limit} CPS</span>
            {trunk.ip_count != null && <span>· {trunk.ip_count} IP{trunk.ip_count !== 1 ? 's' : ''}</span>}
            {trunk.did_count != null && <span>· {trunk.did_count} DID{trunk.did_count !== 1 ? 's' : ''}</span>}
            {trunk.package_name && <span>· {trunk.package_name}</span>}
            <span>· added {new Date(trunk.created_at).toLocaleDateString()}</span>
          </div>
        </div>
        {isAdmin && (
          <Button variant="danger" size="xs" loading={deleting} onClick={() => onDelete(trunk)}>
            Delete
          </Button>
        )}
      </div>

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          padding: '10px 20px',
          fontSize: '0.75rem',
          fontWeight: 600,
          color: '#718096',
          borderTop: '1px solid rgba(42,47,69,0.6)',
          background: 'transparent',
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#e2e8f0'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#718096'; }}
      >
        <span aria-hidden="true">{expanded ? '▴' : '▾'}</span>
        {expanded ? 'Hide details' : 'Live activity, authorized IPs & DIDs'}
      </button>

      {expanded && <TrunkDetail trunk={trunk} canManage={canManage} />}
    </div>
  );
}

// ─── Create trunk modal (admin) ──────────────────────────────────────────────

function CreateTrunkModal({
  open,
  onClose,
  customerId,
}: {
  open: boolean;
  onClose: () => void;
  customerId: number;
}) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [name, setName] = useState('');
  const [authType, setAuthType] = useState<TrunkAuthType>('ip');
  const [maxChannels, setMaxChannels] = useState('10');
  const [cps, setCps] = useState('5');

  const mutation = useMutation({
    mutationFn: () =>
      createTrunk({
        customer_id: customerId,
        trunk_name: name.trim(),
        auth_type: authType,
        max_channels: Number(maxChannels) || 1,
        cps_limit: Number(cps) || 1,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['trunks'] });
      toastOk(`Trunk "${name.trim()}" created`);
      setName('');
      setAuthType('ip');
      setMaxChannels('10');
      setCps('5');
      onClose();
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleSubmit() {
    if (!name.trim()) {
      toastErr('Trunk name is required');
      return;
    }
    mutation.mutate();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create SIP Trunk"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={mutation.isPending} onClick={handleSubmit}>Create trunk</Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-x-4 gap-y-5">
        <FormField
          label="Trunk name"
          required
          fullWidth
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="acme-primary"
          hint="A friendly identifier — letters, numbers and dashes."
        />
        <FormField as="select" label="Auth type" value={authType} onChange={(e) => setAuthType(e.target.value as TrunkAuthType)}>
          <option value="ip">IP authentication</option>
          <option value="credentials">Credentials</option>
          <option value="both">Both</option>
        </FormField>
        <FormField
          label="Max channels"
          type="number"
          min={1}
          value={maxChannels}
          onChange={(e) => setMaxChannels(e.target.value)}
        />
        <FormField
          label="CPS limit"
          type="number"
          min={1}
          fullWidth
          value={cps}
          onChange={(e) => setCps(e.target.value)}
          hint="Maximum new calls per second accepted on this trunk."
        />
      </div>
    </Modal>
  );
}

// ─── Educational empty state ─────────────────────────────────────────────────

function HowItWorksStep({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div style={{ display: 'flex', gap: 14, textAlign: 'left' }}>
      <div
        style={{
          flexShrink: 0,
          width: 30,
          height: 30,
          borderRadius: 9,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(251,191,36,0.12)',
          border: '1px solid rgba(251,191,36,0.3)',
          color: ACCENT,
          fontWeight: 800,
          fontSize: '0.85rem',
        }}
      >
        {n}
      </div>
      <div>
        <div style={{ fontSize: '0.88rem', fontWeight: 700, color: '#e2e8f0', marginBottom: 2 }}>{title}</div>
        <div style={{ fontSize: '0.8rem', color: '#718096', lineHeight: 1.5 }}>{body}</div>
      </div>
    </div>
  );
}

function TrunksEmptyState({ isAdmin, canCreate, onCreate }: { isAdmin: boolean; canCreate: boolean; onCreate: () => void }) {
  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(30,33,48,0.6) 0%, rgba(19,21,29,0.7) 100%)',
        border: '1px solid rgba(42,47,69,0.5)',
        borderRadius: 18,
        padding: '48px 32px',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          width: 60,
          height: 60,
          borderRadius: 16,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 18,
          background: 'linear-gradient(135deg, rgba(251,191,36,0.15) 0%, rgba(251,191,36,0.05) 100%)',
          border: '1px solid rgba(251,191,36,0.25)',
          color: ACCENT,
        }}
      >
        <IconTrunk size={30} />
      </div>

      <h2 style={{ fontSize: '1.3rem', fontWeight: 800, color: '#e2e8f0', marginBottom: 8 }}>
        Enterprise SIP trunking
      </h2>
      <p style={{ fontSize: '0.9rem', color: '#94a3b8', maxWidth: 560, margin: '0 auto 8px', lineHeight: 1.6 }}>
        Connect your PBX or SBC directly to our carrier-grade network. Each trunk is
        IP-authenticated, capped to a concurrent-channel limit, and protected by per-second
        call-rate (CPS) enforcement — with real-time channel, volume and cost monitoring.
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 22,
          maxWidth: 720,
          margin: '32px auto',
          textAlign: 'left',
        }}
      >
        <HowItWorksStep n={1} title="Authorize your IPs" body="Add your PBX/SBC source addresses to the trunk's allow-list. Only those IPs may send calls." />
        <HowItWorksStep n={2} title="Point your DIDs" body="Inbound numbers assigned to the trunk are delivered straight to your equipment." />
        <HowItWorksStep n={3} title="Send & receive" body="Place calls within your channel and CPS limits — overflow is rejected to protect quality." />
        <HowItWorksStep n={4} title="Monitor live" body="Track active channels, daily volume and spend in real time from each trunk's dashboard." />
      </div>

      <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', marginTop: 8 }}>
        {isAdmin && canCreate && (
          <Button variant="primary" onClick={onCreate}>Create your first trunk</Button>
        )}
        <Link to="/docs/api" style={{ textDecoration: 'none' }}>
          <Button variant="ghost">Read the API reference</Button>
        </Link>
      </div>

      {isAdmin && !canCreate && (
        <p style={{ fontSize: '0.78rem', color: '#718096', marginTop: 16 }}>
          Select a specific customer above to create a trunk for them.
        </p>
      )}
      {!isAdmin && (
        <p style={{ fontSize: '0.78rem', color: '#718096', marginTop: 16 }}>
          Need a trunk provisioned? Contact your account team to get started.
        </p>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function TrunksPage() {
  const { user, isAdmin } = useAuth();
  const canManage = (user?.role ?? 'user') !== 'readonly';

  const [adminSelectedCustomer, setAdminSelectedCustomer] = useState<number | undefined>(undefined);
  const customerId = isAdmin ? adminSelectedCustomer : (user?.customer_id ?? undefined);

  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['trunks', { customerId }],
    queryFn: () => listTrunks({ customer_id: customerId, limit: 200 }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteTrunk(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['trunks'] }); },
  });

  const trunks = useMemo(() => data?.items ?? [], [data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return trunks;
    return trunks.filter(
      (t) =>
        t.trunk_name.toLowerCase().includes(q) ||
        (t.customer_name ?? '').toLowerCase().includes(q) ||
        t.auth_type.toLowerCase().includes(q),
    );
  }, [trunks, search]);

  const totals = useMemo(() => {
    const active = trunks.filter((t) => t.enabled).length;
    const channels = trunks.reduce((sum, t) => sum + (t.max_channels || 0), 0);
    const dids = trunks.reduce((sum, t) => sum + (t.did_count ?? 0), 0);
    return { active, channels, dids };
  }, [trunks]);

  function handleDelete(t: Trunk) {
    if (!confirm(`Delete trunk "${t.trunk_name}"? This permanently removes its IPs and DID routing. This cannot be undone.`)) return;
    deleteMutation.mutate(t.id, {
      onSuccess: () => toastOk(`Trunk "${t.trunk_name}" deleted`),
      onError: (err: Error) => toastErr(err.message),
    });
  }

  function handleCustomerSelect(id: number | undefined) {
    setAdminSelectedCustomer(id);
    setSearch('');
  }

  const adminCanCreate = isAdmin && customerId !== undefined;

  return (
    <div style={{ paddingTop: 20 }}>
      <PortalHeader
        icon={<IconTrunk size={24} />}
        title={user?.customer_name ? `${user.customer_name}'s SIP Trunks` : 'SIP Trunks'}
        subtitle="Enterprise SIP trunking with IP-based authentication, channel and CPS limits, and real-time monitoring."
        badgeVariant="trunk"
      />

      <AdminCustomerSelector
        selectedCustomerId={adminSelectedCustomer}
        onSelect={handleCustomerSelect}
        accent={ACCENT}
        accountTypes={['trunk', 'hybrid']}
      />

      {isLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: '#718096', fontSize: '0.875rem', padding: '48px 0', justifyContent: 'center' }}>
          <Spinner size="sm" /> Loading your trunks…
        </div>
      )}

      {isError && (
        <div style={{ padding: '16px 20px', borderRadius: 12, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.22)', color: '#f87171', fontSize: '0.875rem' }}>
          Unable to load SIP trunks. Please try refreshing the page.
        </div>
      )}

      {!isLoading && !isError && trunks.length === 0 && (
        <TrunksEmptyState isAdmin={isAdmin} canCreate={adminCanCreate} onCreate={() => setCreateOpen(true)} />
      )}

      {!isLoading && !isError && trunks.length > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" style={{ marginBottom: 20 }}>
            <StatCard label="Total Trunks" icon="🔌" value={trunks.length} />
            <StatCard label="Active" icon="✅" value={totals.active} />
            <StatCard label="Total Channels" icon="📊" value={totals.channels.toLocaleString()} />
            <StatCard label="Routed DIDs" icon="☎️" value={totals.dids.toLocaleString()} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by name, customer, or auth type…"
              style={{
                flex: '1 1 240px',
                minWidth: 200,
                boxSizing: 'border-box',
                padding: '9px 14px',
                fontSize: '0.83rem',
                background: 'rgba(19,21,29,0.7)',
                border: '1px solid rgba(251,191,36,0.14)',
                borderRadius: 11,
                color: '#e2e8f0',
                outline: 'none',
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(251,191,36,0.45)'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(251,191,36,0.14)'; }}
            />
            {isAdmin && (
              <Button
                variant="primary"
                onClick={() => {
                  if (!adminCanCreate) { toastErr('Select a specific customer above to create a trunk'); return; }
                  setCreateOpen(true);
                }}
              >
                + New trunk
              </Button>
            )}
          </div>

          {filtered.length === 0 ? (
            <p style={{ fontSize: '0.85rem', color: '#718096', textAlign: 'center', padding: '32px 0' }}>
              No trunks match “{search}”.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {filtered.map((t) => (
                <TrunkRow
                  key={t.id}
                  trunk={t}
                  isAdmin={isAdmin}
                  canManage={canManage}
                  showCustomer={isAdmin}
                  onDelete={handleDelete}
                  deleting={deleteMutation.isPending && deleteMutation.variables === t.id}
                />
              ))}
            </div>
          )}
        </>
      )}

      {adminCanCreate && customerId !== undefined && (
        <CreateTrunkModal open={createOpen} onClose={() => setCreateOpen(false)} customerId={customerId} />
      )}
    </div>
  );
}
