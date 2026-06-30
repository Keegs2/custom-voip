/**
 * CustomerTrunkSection — SIP-trunk management inside the customer 360. Glass
 * header, a trunk picker, a detailed glass trunk card (connection details,
 * capacity / call-path package, authorized IPs, assigned DIDs, enable toggle),
 * and an accent-tinted "Create New Trunk" form. All queries + mutations are
 * preserved and run on live data.
 */

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
} from '../../../../api/trunks';
import { apiRequest } from '../../../../api/client';
import { Button } from '../../../../components/ui/Button';
import { Spinner } from '../../../../components/ui/Spinner';
import { useToast } from '../../../../components/ui/ToastContext';
import { GlassChip } from '../../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import type { Trunk, TrunkIp, TrunkDid, TrunkAuthType } from '../../../../types/trunk';
import {
  emptyNote,
  errorNote,
  fieldLabel,
  glassFieldInput,
  glassFormPanel,
  glassSelect,
  glassStatChip,
  inlineLoading,
  manageLink,
  sectionEyebrow,
} from '../styles';

// ----- Types -----

interface TrunkWithDetails extends Trunk {
  ips: TrunkIp[];
  dids: TrunkDid[];
}

const SIP_SERVER = '34.74.71.32:5080';

// ----- Shared style fragments (glass) -----

const innerCard: React.CSSProperties = {
  background: 'rgba(8,10,15,0.4)',
  border: '1px solid rgba(255,255,255,0.06)',
  borderRadius: 12,
  padding: '16px 20px',
};

const sectionLabelMini: React.CSSProperties = {
  ...fieldLabel,
  letterSpacing: '0.09em',
  marginBottom: 10,
};

const pill: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 20,
  padding: '4px 12px',
  fontFamily: 'monospace',
  fontSize: '0.78rem',
  color: GLASS.text,
};

// ----- TrunkCard -----

interface TrunkCardProps {
  trunk: TrunkWithDetails;
  customerId: number;
  accent: string;
}

function TrunkCard({ trunk, customerId, accent }: TrunkCardProps) {
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
    <div
      style={{
        background: 'rgba(255,255,255,0.025)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 16,
        padding: 24,
        marginBottom: 20,
      }}
    >
      {/* ── Trunk header ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
            <span style={{ fontSize: '1rem', fontWeight: 700, color: GLASS.text, letterSpacing: '-0.01em' }}>
              {trunk.trunk_name}
            </span>
            <GlassChip
              label={trunk.enabled ? 'Active' : 'Disabled'}
              color={trunk.enabled ? GLASS.success : GLASS.textFaint}
              dot={trunk.enabled}
            />
            <GlassChip label={`${trunk.auth_type} auth`} color={accent} />
          </div>
          <span style={{ fontFamily: 'monospace', fontSize: '0.7rem', color: GLASS.textFaint }}>
            trunk#{trunk.id}
          </span>
        </div>
      </div>

      {/* ── Quick stats row ── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
        <div style={glassStatChip()}>
          <span style={{ color: GLASS.textMuted, fontSize: '0.72rem' }}>Channels</span>
          <span style={{ color: GLASS.text, fontWeight: 700 }}>{trunk.max_channels}</span>
        </div>
        <div style={glassStatChip()}>
          <span style={{ color: GLASS.textMuted, fontSize: '0.72rem' }}>CPS</span>
          <span style={{ color: GLASS.text, fontWeight: 700 }}>{trunk.cps_limit ?? '--'}</span>
        </div>
        <div style={glassStatChip()}>
          <span style={{ color: GLASS.textMuted, fontSize: '0.72rem' }}>IPs</span>
          <span style={{ color: GLASS.text, fontWeight: 700 }}>{trunk.ips.length}</span>
        </div>
        <div style={glassStatChip()}>
          <span style={{ color: GLASS.textMuted, fontSize: '0.72rem' }}>DIDs</span>
          <span style={{ color: GLASS.text, fontWeight: 700 }}>{trunk.dids.length}</span>
        </div>
      </div>

      {/* ── Connection Details card ── */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ ...sectionLabelMini, color: accent }}>Connection Details</div>
        <div style={innerCard}>
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
          ].map(({ label, value, mono, empty, emptyColor }, idx, arr) => (
            <div
              key={label}
              style={{
                display: 'flex',
                gap: 16,
                alignItems: 'baseline',
                padding: '5px 0',
                borderBottom: idx < arr.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
              }}
            >
              <span style={{ minWidth: 110, fontSize: '0.78rem', color: GLASS.textMuted, flexShrink: 0 }}>
                {label}
              </span>
              {value !== null && value !== undefined && value !== '' ? (
                <span style={{ fontFamily: mono ? 'monospace' : 'inherit', fontSize: '0.8rem', color: GLASS.text, wordBreak: 'break-all' }}>
                  {value}
                </span>
              ) : (
                <span style={{ fontFamily: 'monospace', fontSize: '0.8rem', color: emptyColor ?? GLASS.textMuted }}>
                  {empty}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── Capacity ── */}
      <div style={{ marginBottom: 20 }}>
        <div style={sectionLabelMini}>Capacity</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
          <div style={glassStatChip(accent, true)}>
            <span style={{ color: GLASS.textMuted, fontSize: '0.72rem' }}>Call Paths</span>
            <span style={{ color: accent, fontWeight: 700 }}>{trunk.max_channels}</span>
            {trunk.package_name && (
              <span style={{ color: GLASS.textFaint, fontSize: '0.7rem' }}>· {trunk.package_name}</span>
            )}
          </div>
          <div style={glassStatChip(accent, true)}>
            <span style={{ color: GLASS.textMuted, fontSize: '0.72rem' }}>CPS Limit</span>
            <span style={{ color: accent, fontWeight: 700 }}>{trunk.cps_limit}</span>
          </div>
        </div>

        <div style={{ fontSize: '0.72rem', color: GLASS.textFaint, marginBottom: 8 }}>
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
            style={{ ...glassSelect(accent), minWidth: 200, maxWidth: 300 }}
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

      <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', margin: '18px 0' }} />

      {/* ── Authorized IPs ── */}
      {showAuthIps && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <span style={sectionLabelMini}>Authorized IPs</span>
            <GlassChip label={String(trunk.ips.length)} color={accent} />
          </div>

          {trunk.ips.length === 0 ? (
            <div style={{ fontSize: '0.78rem', color: GLASS.textFaint, marginBottom: 12 }}>
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
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: 8,
                    padding: '7px 12px',
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <span style={{ fontFamily: 'monospace', fontSize: '0.82rem', color: GLASS.text, flex: 1 }}>
                    {ip.ip_address}
                  </span>
                  {ip.description && (
                    <span style={{ fontSize: '0.75rem', color: GLASS.textMuted }}>{ip.description}</span>
                  )}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleRemoveIp(ip); }}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: GLASS.textMuted,
                      fontSize: '1rem',
                      lineHeight: 1,
                      padding: '0 2px',
                      borderRadius: 4,
                      transition: 'color 0.15s',
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = GLASS.danger; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = GLASS.textMuted; }}
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
              style={{ ...glassFieldInput(false, accent), fontFamily: 'monospace', width: 140 }}
            />
            <input
              type="text"
              value={newIpDesc}
              onChange={(e) => setNewIpDesc(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              placeholder="Description (optional)"
              style={{ ...glassFieldInput(false, accent), width: 180 }}
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span style={sectionLabelMini}>Assigned DIDs</span>
          <GlassChip label={String(trunk.dids.length)} color={accent} />
        </div>

        {trunk.dids.length === 0 ? (
          <div style={{ fontSize: '0.78rem', color: GLASS.textFaint, marginBottom: 12 }}>
            No DIDs assigned
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
            {trunk.dids.map((d) => (
              <span key={d.id} style={pill}>
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
            style={{ ...glassFieldInput(false, accent), fontFamily: 'monospace', width: 180 }}
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
          borderTop: '1px solid rgba(255,255,255,0.06)',
          paddingTop: 16,
          display: 'flex',
          justifyContent: 'flex-end',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          disabled={toggleMutation.isPending}
          onClick={(e) => { e.stopPropagation(); toggleMutation.mutate(!trunk.enabled); }}
          style={{
            background: trunk.enabled ? hexToRgba(GLASS.danger, 0.1) : hexToRgba(GLASS.success, 0.1),
            border: `1px solid ${trunk.enabled ? hexToRgba(GLASS.danger, 0.32) : hexToRgba(GLASS.success, 0.32)}`,
            borderRadius: 9,
            padding: '6px 16px',
            fontSize: '0.78rem',
            fontWeight: 600,
            color: trunk.enabled ? '#f87171' : '#4ade80',
            cursor: toggleMutation.isPending ? 'not-allowed' : 'pointer',
            opacity: toggleMutation.isPending ? 0.6 : 1,
            letterSpacing: '0.02em',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
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
  accent?: string;
}

export function CustomerTrunkSection({ customerId, accent = GLASS.warning }: CustomerTrunkSectionProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { toastOk, toastErr } = useToast();

  const [newTrunkName, setNewTrunkName] = useState('');
  const [newTrunkAuth, setNewTrunkAuth] = useState<TrunkAuthType>('ip');
  const [selectedTrunkId, setSelectedTrunkId] = useState<number | null>(null);
  const [nameFocused, setNameFocused] = useState(false);

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
    <div>
      {/* Section header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={sectionEyebrow(accent)}>Trunk Configuration</span>
          {!isLoading && !isError && (
            <GlassChip label={trunks.length === 1 ? '1 trunk' : `${trunks.length} trunks`} color={accent} />
          )}
        </div>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); navigate('/trunks'); }}
          style={manageLink(accent)}
          onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
          onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
        >
          Manage Trunks
        </button>
      </div>

      {isLoading && (
        <div style={inlineLoading}>
          <Spinner size="xs" /> Loading trunks…
        </div>
      )}

      {isError && <div style={errorNote()}>Could not load trunks.</div>}

      {!isLoading && !isError && trunks.length === 0 && (
        <div style={{ ...emptyNote, padding: '20px 0', textAlign: 'left' }}>No trunks configured.</div>
      )}

      {/* Trunk selector dropdown */}
      {!isLoading && trunks.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <select
            value={selectedTrunkId ?? ''}
            onChange={(e) => setSelectedTrunkId(e.target.value ? Number(e.target.value) : null)}
            style={{ ...glassSelect(accent), minWidth: 280, fontSize: '0.85rem', padding: '9px 14px' }}
          >
            <option value="">Select a trunk ({trunks.length} configured)</option>
            {trunks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.trunk_name} — {t.auth_type} auth · {t.ips.length} IPs · {t.dids.length} DIDs
                {t.enabled ? '' : ' (disabled)'}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Selected trunk detail */}
      {!isLoading && selectedTrunkId != null &&
        trunks.filter((t) => t.id === selectedTrunkId).map((trunk) => (
          <TrunkCard key={trunk.id} trunk={trunk} customerId={customerId} accent={accent} />
        ))}

      {/* Create New Trunk form */}
      <form onSubmit={handleCreateTrunk} onClick={(e) => e.stopPropagation()} style={glassFormPanel(accent)}>
        <div style={{ ...sectionEyebrow(accent), marginBottom: 14 }}>Create New Trunk</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={fieldLabel}>Trunk Name</label>
            <input
              type="text"
              value={newTrunkName}
              onChange={(e) => setNewTrunkName(e.target.value)}
              onFocus={() => setNameFocused(true)}
              onBlur={() => setNameFocused(false)}
              onClick={(e) => e.stopPropagation()}
              placeholder="acme-primary"
              style={{ ...glassFieldInput(nameFocused, accent), width: 148 }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={fieldLabel}>Auth Type</label>
            <select
              value={newTrunkAuth}
              onChange={(e) => setNewTrunkAuth(e.target.value as TrunkAuthType)}
              onClick={(e) => e.stopPropagation()}
              style={{ ...glassSelect(accent), width: 140 }}
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
