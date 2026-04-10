import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  listTrunks,
  createTrunk,
  updateTrunk,
  getTrunkIps,
  addTrunkIp,
  deleteTrunkIp,
  getTrunkDids,
  listCallPathPackages,
} from '../../api/trunks';
import { apiRequest } from '../../api/client';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/ToastContext';
import type { Trunk, TrunkIp, TrunkDid, TrunkAuthType } from '../../types/trunk';

// ----- Types -----

interface TrunkWithDetails extends Trunk {
  ips: TrunkIp[];
  dids: TrunkDid[];
}

// ----- TrunkCard -----

interface TrunkCardProps {
  trunk: TrunkWithDetails;
  customerId: number;
}

const SIP_SERVER = '34.74.71.32:5080';

// Shared style tokens
const styles = {
  card: {
    background: 'linear-gradient(160deg, #1c1f2e 0%, #13151d 100%)',
    border: '1px solid rgba(42,47,69,0.7)',
    borderRadius: 14,
    padding: 24,
    marginBottom: 24,
  } as React.CSSProperties,

  innerCard: {
    background: '#0d0f17',
    border: '1px solid rgba(42,47,69,0.5)',
    borderRadius: 10,
    padding: '16px 20px',
  } as React.CSSProperties,

  sectionLabel: {
    fontSize: '0.62rem',
    fontWeight: 700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    color: '#718096',
    marginBottom: 10,
  } as React.CSSProperties,

  divider: {
    borderTop: '1px solid rgba(42,47,69,0.5)',
    margin: '18px 0',
  } as React.CSSProperties,

  statChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    background: 'rgba(42,47,69,0.35)',
    border: '1px solid rgba(42,47,69,0.6)',
    borderRadius: 6,
    padding: '4px 10px',
    fontSize: '0.78rem',
  } as React.CSSProperties,

  pill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    background: '#0d0f15',
    border: '1px solid rgba(42,47,69,0.7)',
    borderRadius: 20,
    padding: '4px 10px',
    fontFamily: 'monospace',
    fontSize: '0.78rem',
    color: '#e2e8f0',
  } as React.CSSProperties,

  input: {
    background: '#0d0f15',
    border: '1px solid rgba(42,47,69,0.6)',
    borderRadius: 7,
    padding: '6px 10px',
    color: '#e2e8f0',
    fontSize: '0.82rem',
    outline: 'none',
  } as React.CSSProperties,

  select: {
    background: '#0d0f15',
    border: '1px solid rgba(42,47,69,0.6)',
    borderRadius: 7,
    padding: '6px 10px',
    color: '#e2e8f0',
    fontSize: '0.82rem',
    outline: 'none',
    cursor: 'pointer',
  } as React.CSSProperties,

  countBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(245,158,11,0.15)',
    border: '1px solid rgba(245,158,11,0.3)',
    borderRadius: 10,
    padding: '1px 7px',
    fontSize: '0.68rem',
    fontWeight: 700,
    color: '#f59e0b',
    marginLeft: 8,
  } as React.CSSProperties,
} as const;

function TrunkCard({ trunk, customerId }: TrunkCardProps) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const [newIp, setNewIp] = useState('');
  const [newIpDesc, setNewIpDesc] = useState('');
  const [newDid, setNewDid] = useState('');
  const [selectedPackageId, setSelectedPackageId] = useState('');

  const invalidateTrunks = () =>
    qc.invalidateQueries({ queryKey: ['customerTrunks', customerId] });

  // Call path packages
  const { data: packages } = useQuery({
    queryKey: ['callPathPackages'],
    queryFn: listCallPathPackages,
  });

  // Toggle trunk enabled
  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => updateTrunk(trunk.id, { enabled }),
    onSuccess: (_data, enabled) => {
      invalidateTrunks();
      toastOk(enabled ? 'Trunk enabled' : 'Trunk disabled');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  // Add IP
  const addIpMutation = useMutation({
    mutationFn: () =>
      addTrunkIp(trunk.id, newIp.trim(), newIpDesc.trim() || undefined),
    onSuccess: () => {
      invalidateTrunks();
      setNewIp('');
      setNewIpDesc('');
      toastOk(`IP ${newIp.trim()} added`);
    },
    onError: (err: Error) => toastErr(err.message),
  });

  // Remove IP
  const removeIpMutation = useMutation({
    mutationFn: (ipId: number) => deleteTrunkIp(trunk.id, ipId),
    onSuccess: () => {
      invalidateTrunks();
      toastOk('IP removed');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  // Add DID
  const addDidMutation = useMutation({
    mutationFn: () =>
      apiRequest<TrunkDid>('POST', `/trunks/${trunk.id}/dids`, { did: newDid.trim() }),
    onSuccess: () => {
      invalidateTrunks();
      setNewDid('');
      toastOk(`DID ${newDid.trim()} assigned`);
    },
    onError: (err: Error) => toastErr(err.message),
  });

  // Assign call path package
  const assignPackageMutation = useMutation({
    mutationFn: (packageId: number) =>
      apiRequest('PUT', `/trunks/${trunk.id}/call-paths`, { package_id: packageId }),
    onSuccess: () => {
      invalidateTrunks();
      setSelectedPackageId('');
      toastOk('Call path package assigned');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleAddIp(e: React.FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!newIp.trim()) { toastErr('IP address is required'); return; }
    addIpMutation.mutate();
  }

  function handleAddDid(e: React.FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!newDid.trim()) { toastErr('DID is required'); return; }
    addDidMutation.mutate();
  }

  function handleApplyPackage(e: React.MouseEvent) {
    e.stopPropagation();
    if (!selectedPackageId) { toastErr('Select a call path package'); return; }
    assignPackageMutation.mutate(parseInt(selectedPackageId, 10));
  }

  function handleRemoveIp(ip: TrunkIp) {
    if (!confirm('Remove this IP?')) return;
    removeIpMutation.mutate(ip.id);
  }

  const showAuthIps = trunk.auth_type === 'ip' || trunk.auth_type === 'both';

  return (
    <div style={styles.card}>

      {/* ── Trunk header ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
            <span style={{ fontSize: '1rem', fontWeight: 700, color: '#e2e8f0', letterSpacing: '-0.01em' }}>
              {trunk.trunk_name}
            </span>
            <Badge variant={trunk.enabled ? 'active' : 'disabled'}>
              {trunk.enabled ? 'Active' : 'Disabled'}
            </Badge>
            <span style={{
              background: 'rgba(245,158,11,0.12)',
              border: '1px solid rgba(245,158,11,0.25)',
              borderRadius: 5,
              padding: '2px 7px',
              fontSize: '0.68rem',
              fontWeight: 600,
              color: '#f59e0b',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}>
              {trunk.auth_type} auth
            </span>
          </div>
          <span style={{ fontFamily: 'monospace', fontSize: '0.7rem', color: '#4a5568' }}>
            trunk#{trunk.id}
          </span>
        </div>
      </div>

      {/* ── Quick stats row ── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
        <div style={styles.statChip}>
          <span style={{ color: '#718096', fontSize: '0.72rem' }}>Channels</span>
          <span style={{ color: '#e2e8f0', fontWeight: 700 }}>{trunk.max_channels}</span>
        </div>
        <div style={styles.statChip}>
          <span style={{ color: '#718096', fontSize: '0.72rem' }}>CPS</span>
          <span style={{ color: '#e2e8f0', fontWeight: 700 }}>{trunk.cps_limit ?? '--'}</span>
        </div>
        <div style={styles.statChip}>
          <span style={{ color: '#718096', fontSize: '0.72rem' }}>IPs</span>
          <span style={{ color: '#e2e8f0', fontWeight: 700 }}>{trunk.ips.length}</span>
        </div>
        <div style={styles.statChip}>
          <span style={{ color: '#718096', fontSize: '0.72rem' }}>DIDs</span>
          <span style={{ color: '#e2e8f0', fontWeight: 700 }}>{trunk.dids.length}</span>
        </div>
      </div>

      {/* ── Connection Details card ── */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ ...styles.sectionLabel, color: '#3b82f6' }}>
          Connection Details
        </div>
        <div style={styles.innerCard}>
          {[
            { label: 'SIP Server', value: SIP_SERVER, mono: true },
            { label: 'Auth Type', value: trunk.auth_type.toUpperCase(), mono: true },
            ...(showAuthIps ? [{
              label: 'Auth IPs',
              value: trunk.ips.length > 0
                ? trunk.ips.map((ip) => ip.ip_address + (ip.description ? ` (${ip.description})` : '')).join(', ')
                : null,
              mono: true,
              empty: 'None configured',
              emptyColor: '#fca5a5',
            }] : []),
            ...(trunk.tech_prefix ? [{ label: 'Tech Prefix', value: trunk.tech_prefix, mono: true }] : []),
            { label: 'Max Channels', value: String(trunk.max_channels), mono: true },
            { label: 'CPS Limit', value: String(trunk.cps_limit), mono: true },
            {
              label: 'DIDs',
              value: trunk.dids.length > 0 ? trunk.dids.map((d) => d.did).join(', ') : null,
              mono: true,
              empty: 'None assigned',
            },
          ].map(({ label, value, mono, empty, emptyColor }, idx) => (
            <div
              key={label}
              style={{
                display: 'flex',
                gap: 16,
                alignItems: 'baseline',
                padding: '5px 0',
                borderBottom: idx < 6 ? '1px solid rgba(42,47,69,0.25)' : 'none',
              }}
            >
              <span style={{ minWidth: 110, fontSize: '0.78rem', color: '#718096', flexShrink: 0 }}>
                {label}
              </span>
              {value !== null && value !== undefined && value !== '' ? (
                <span style={{
                  fontFamily: mono ? 'monospace' : 'inherit',
                  fontSize: '0.8rem',
                  color: '#e2e8f0',
                  wordBreak: 'break-all',
                }}>
                  {value}
                </span>
              ) : (
                <span style={{ fontFamily: 'monospace', fontSize: '0.8rem', color: emptyColor ?? '#718096' }}>
                  {empty}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── Capacity ── */}
      <div style={{ marginBottom: 20 }}>
        <div style={styles.sectionLabel}>Capacity</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          <div style={{
            ...styles.statChip,
            borderColor: 'rgba(59,130,246,0.3)',
            background: 'rgba(59,130,246,0.08)',
          }}>
            <span style={{ color: '#718096', fontSize: '0.72rem' }}>Call Paths</span>
            <span style={{ color: '#60a5fa', fontWeight: 700 }}>{trunk.max_channels}</span>
            {trunk.package_name && (
              <span style={{ color: '#4a5568', fontSize: '0.7rem' }}>· {trunk.package_name}</span>
            )}
          </div>
          <div style={{
            ...styles.statChip,
            borderColor: 'rgba(59,130,246,0.3)',
            background: 'rgba(59,130,246,0.08)',
          }}>
            <span style={{ color: '#718096', fontSize: '0.72rem' }}>CPS Limit</span>
            <span style={{ color: '#60a5fa', fontWeight: 700 }}>{trunk.cps_limit}</span>
          </div>
        </div>

        <div style={{ fontSize: '0.72rem', color: '#4a5568', marginBottom: 8 }}>
          Change call path package
        </div>
        <div
          style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}
          onClick={(e) => e.stopPropagation()}
        >
          <select
            value={selectedPackageId}
            onChange={(e) => setSelectedPackageId(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            style={{ ...styles.select, minWidth: 200, maxWidth: 300 }}
          >
            <option value="">
              Current: {trunk.max_channels} paths
              {trunk.package_name ? ` (${trunk.package_name})` : ''} — no change
            </option>
            {(packages ?? []).map((pkg) => (
              <option key={pkg.id} value={String(pkg.id)}>
                {pkg.name} — {pkg.max_channels ?? '∞'} paths, ${pkg.monthly_fee.toFixed(2)}/mo
              </option>
            ))}
          </select>
          <Button
            variant="primary"
            size="xs"
            loading={assignPackageMutation.isPending}
            onClick={handleApplyPackage}
          >
            Apply
          </Button>
        </div>
      </div>

      <div style={styles.divider} />

      {/* ── Authorized IPs ── */}
      {showAuthIps && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
            <span style={styles.sectionLabel}>Authorized IPs</span>
            <span style={{ ...styles.countBadge, marginTop: -4 }}>{trunk.ips.length}</span>
          </div>

          {trunk.ips.length === 0 ? (
            <div style={{ fontSize: '0.78rem', color: '#4a5568', marginBottom: 12 }}>
              No IPs configured
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
              {trunk.ips.map((ip) => (
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
                  onClick={(e) => e.stopPropagation()}
                >
                  <span style={{ fontFamily: 'monospace', fontSize: '0.82rem', color: '#e2e8f0', flex: 1 }}>
                    {ip.ip_address}
                  </span>
                  {ip.description && (
                    <span style={{ fontSize: '0.75rem', color: '#718096' }}>{ip.description}</span>
                  )}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleRemoveIp(ip); }}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: '#718096',
                      fontSize: '1rem',
                      lineHeight: 1,
                      padding: '0 2px',
                      borderRadius: 4,
                      transition: 'color 0.15s',
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#ef4444'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#718096'; }}
                    title="Remove IP"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <form
            onSubmit={handleAddIp}
            onClick={(e) => e.stopPropagation()}
            style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
          >
            <input
              type="text"
              value={newIp}
              onChange={(e) => setNewIp(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              placeholder="192.0.2.1"
              style={{ ...styles.input, fontFamily: 'monospace', width: 140 }}
            />
            <input
              type="text"
              value={newIpDesc}
              onChange={(e) => setNewIpDesc(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              placeholder="Description (optional)"
              style={{ ...styles.input, width: 180 }}
            />
            <Button
              type="submit"
              variant="ghost"
              size="xs"
              loading={addIpMutation.isPending}
              onClick={(e) => e.stopPropagation()}
            >
              Add IP
            </Button>
          </form>
        </div>
      )}

      {/* ── Assigned DIDs ── */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <span style={styles.sectionLabel}>Assigned DIDs</span>
          <span style={{ ...styles.countBadge, marginTop: -4 }}>{trunk.dids.length}</span>
        </div>

        {trunk.dids.length === 0 ? (
          <div style={{ fontSize: '0.78rem', color: '#4a5568', marginBottom: 12 }}>
            No DIDs assigned
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
            {trunk.dids.map((d) => (
              <span key={d.id} style={styles.pill}>
                {d.did}
              </span>
            ))}
          </div>
        )}

        <form
          onSubmit={handleAddDid}
          onClick={(e) => e.stopPropagation()}
          style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
        >
          <input
            type="tel"
            value={newDid}
            onChange={(e) => setNewDid(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            placeholder="+1XXXXXXXXXX"
            style={{ ...styles.input, fontFamily: 'monospace', width: 180 }}
          />
          <Button
            type="submit"
            variant="ghost"
            size="xs"
            loading={addDidMutation.isPending}
            onClick={(e) => e.stopPropagation()}
          >
            Assign DID
          </Button>
        </form>
      </div>

      {/* ── Enable / Disable ── */}
      <div
        style={{
          borderTop: '1px solid rgba(42,47,69,0.4)',
          paddingTop: 16,
          display: 'flex',
          justifyContent: 'flex-end',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          disabled={toggleMutation.isPending}
          onClick={(e) => {
            e.stopPropagation();
            toggleMutation.mutate(!trunk.enabled);
          }}
          style={{
            background: trunk.enabled
              ? 'rgba(239,68,68,0.08)'
              : 'rgba(34,197,94,0.08)',
            border: trunk.enabled
              ? '1px solid rgba(239,68,68,0.3)'
              : '1px solid rgba(34,197,94,0.3)',
            borderRadius: 7,
            padding: '6px 16px',
            fontSize: '0.78rem',
            fontWeight: 600,
            color: trunk.enabled ? '#f87171' : '#4ade80',
            cursor: toggleMutation.isPending ? 'not-allowed' : 'pointer',
            opacity: toggleMutation.isPending ? 0.6 : 1,
            letterSpacing: '0.02em',
          }}
        >
          {trunk.enabled ? 'Disable Trunk' : 'Enable Trunk'}
        </button>
      </div>
    </div>
  );
}

// ----- CustomerTrunkSection -----

interface CustomerTrunkSectionProps {
  customerId: number;
}

export function CustomerTrunkSection({ customerId }: CustomerTrunkSectionProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { toastOk, toastErr } = useToast();

  const [newTrunkName, setNewTrunkName] = useState('');
  const [newTrunkAuth, setNewTrunkAuth] = useState<TrunkAuthType>('ip');

  // Fetch trunks list
  const { data: trunksData, isLoading, isError } = useQuery({
    queryKey: ['customerTrunks', customerId],
    queryFn: async () => {
      const list = await listTrunks({ customer_id: customerId, limit: 50 });
      // list is normalised to { items, total } — items is always an array
      const trunkItems = list.items ?? [];
      // For each trunk, fetch IPs and DIDs in parallel
      const withDetails = await Promise.all(
        trunkItems.map(async (trunk) => {
          const [ips, dids] = await Promise.allSettled([
            getTrunkIps(trunk.id),
            getTrunkDids(trunk.id),
          ]);
          return {
            ...trunk,
            ips: ips.status === 'fulfilled' ? ips.value : [],
            dids: dids.status === 'fulfilled' ? dids.value : [],
          } satisfies TrunkWithDetails;
        }),
      );
      return withDetails;
    },
  });

  const createTrunkMutation = useMutation({
    mutationFn: () =>
      createTrunk({
        customer_id: customerId,
        trunk_name: newTrunkName.trim(),
        max_channels: 10,
        cps_limit: 5,
        auth_type: newTrunkAuth,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customerTrunks', customerId] });
      setNewTrunkName('');
      setNewTrunkAuth('ip');
      toastOk(`Trunk "${newTrunkName.trim()}" created`);
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleCreateTrunk(e: React.FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!newTrunkName.trim()) { toastErr('Trunk name is required'); return; }
    createTrunkMutation.mutate();
  }

  const trunks = trunksData ?? [];

  return (
    <div style={{ paddingTop: 20, borderTop: '1px solid rgba(42,47,69,0.5)' }}>

      {/* Section header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <span style={{
          fontSize: '0.62rem',
          fontWeight: 700,
          letterSpacing: '0.09em',
          textTransform: 'uppercase',
          color: '#718096',
        }}>
          Trunk Configuration
        </span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); navigate('/trunks'); }}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: '0.72rem',
            color: '#3b82f6',
            textDecoration: 'underline',
            padding: 0,
          }}
        >
          Manage Trunks
        </button>
      </div>

      {isLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#718096', fontSize: '0.8rem', padding: '8px 0' }}>
          <Spinner size="xs" /> Loading trunks…
        </div>
      )}

      {isError && (
        <p style={{ color: '#f87171', fontSize: '0.8rem', margin: 0 }}>Could not load trunks.</p>
      )}

      {!isLoading && !isError && trunks.length === 0 && (
        <p style={{ color: '#718096', fontSize: '0.8rem', margin: 0 }}>No trunks configured.</p>
      )}

      {!isLoading &&
        trunks.map((trunk) => (
          <TrunkCard key={trunk.id} trunk={trunk} customerId={customerId} />
        ))}

      {/* Create New Trunk form */}
      <form
        onSubmit={handleCreateTrunk}
        onClick={(e) => e.stopPropagation()}
        style={{
          marginTop: 8,
          padding: '20px 24px',
          background: 'rgba(13,15,23,0.7)',
          border: '1px solid rgba(42,47,69,0.55)',
          borderRadius: 12,
        }}
      >
        <div style={{
          fontSize: '0.62rem',
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: '#718096',
          marginBottom: 14,
        }}>
          Create New Trunk
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{
              fontSize: '0.62rem',
              fontWeight: 700,
              letterSpacing: '0.07em',
              textTransform: 'uppercase',
              color: '#4a5568',
            }}>
              Trunk Name
            </label>
            <input
              type="text"
              value={newTrunkName}
              onChange={(e) => setNewTrunkName(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              placeholder="acme-primary"
              style={{
                background: '#0d0f15',
                border: '1px solid rgba(42,47,69,0.6)',
                borderRadius: 7,
                padding: '7px 10px',
                color: '#e2e8f0',
                fontSize: '0.83rem',
                outline: 'none',
                width: 148,
              }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{
              fontSize: '0.62rem',
              fontWeight: 700,
              letterSpacing: '0.07em',
              textTransform: 'uppercase',
              color: '#4a5568',
            }}>
              Auth Type
            </label>
            <select
              value={newTrunkAuth}
              onChange={(e) => setNewTrunkAuth(e.target.value as TrunkAuthType)}
              onClick={(e) => e.stopPropagation()}
              style={{
                background: '#0d0f15',
                border: '1px solid rgba(42,47,69,0.6)',
                borderRadius: 7,
                padding: '7px 10px',
                color: '#e2e8f0',
                fontSize: '0.83rem',
                outline: 'none',
                width: 140,
                cursor: 'pointer',
              }}
            >
              <option value="ip">IP Auth</option>
              <option value="credentials">Credential</option>
              <option value="both">Both</option>
            </select>
          </div>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={createTrunkMutation.isPending}
            onClick={(e) => e.stopPropagation()}
          >
            Create Trunk
          </Button>
        </div>
      </form>
    </div>
  );
}
