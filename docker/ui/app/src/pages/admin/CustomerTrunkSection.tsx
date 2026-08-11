/**
 * CustomerTrunkSection — SIP trunk panel on the admin Customer 360
 * (trunk/hybrid accounts): trunk selector, full trunk detail (connection
 * facts, capacity, authorized IPs, assigned DIDs, enable/disable), and the
 * create-trunk form.
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` in index.css, plus the
 * admin-area `dlx-*` primitives in dl-admin.css). Renders its own dl-panel.
 *
 * Behavior contract: the Capacity + Authorized-IPs state, validation, and
 * payload building come from the SHARED `useTrunkCapacity()` /
 * `useTrunkAuthIps()` controllers in TrunkCapacityFields.tsx, rendered with
 * the daylight sections exported by TrunksAdminPage — so the create payload
 * is byte-identical to before. Every query, mutation, confirm() and toast is
 * unchanged.
 *
 * React #310: every hook in every component below is called unconditionally
 * at the top of its function, before any early return.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Share2 } from 'lucide-react';
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
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/ToastContext';
import { normalizeNumberInput } from '../../utils/phone';
import { useTrunkCapacity, useTrunkAuthIps } from './TrunkCapacityFields';
import { DaylightCapacitySection, DaylightAuthIpsSection } from './TrunksAdminPage';
import type { Trunk, TrunkIp, TrunkDid, TrunkAuthType } from '../../types/trunk';
import '../../styles/dl-admin.css';

// ----- Types -----

interface TrunkWithDetails extends Trunk {
  ips: TrunkIp[];
  dids: TrunkDid[];
}

// ----- Constants -----

const SIP_SERVER = '34.74.71.32:5080';
const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';

/** Vertical label + control field group. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <span className="dl-flabel">{label}</span>
      {children}
    </div>
  );
}

/** Compact fact chip — label + value on one tinted chip row. */
function FactChip({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 7,
        background: 'var(--rcf-tint)',
        border: '1px solid var(--rcf-line-soft)',
        borderRadius: 7,
        padding: '5px 11px',
        fontSize: '0.78rem',
      }}
    >
      <span style={{ fontSize: '0.68rem', color: 'var(--rcf-ink-dim)' }}>{label}</span>
      <span style={{ color: 'var(--rcf-ink)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </span>
      {hint && <span style={{ fontSize: '0.68rem', color: 'var(--rcf-ink-dim)' }}>· {hint}</span>}
    </span>
  );
}

// ----- TrunkCard -----

interface TrunkCardProps {
  trunk: TrunkWithDetails;
  customerId: number;
}

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

  // Add DID — canonicalize to E.164 before it hits the API (belt-and-suspenders:
  // the backend validates trunk DIDs too).
  const addDidMutation = useMutation({
    mutationFn: () => {
      const did = normalizeNumberInput(newDid);
      return apiRequest<TrunkDid>('POST', `/trunks/${trunk.id}/dids`, { did });
    },
    onSuccess: () => {
      invalidateTrunks();
      toastOk(`DID ${normalizeNumberInput(newDid)} assigned`);
      setNewDid('');
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

  // Connection facts — same fields + fallbacks as before
  const connectionFacts: Array<{
    label: string;
    value: string | null;
    empty?: string;
    emptyRed?: boolean;
  }> = [
    { label: 'SIP Server', value: SIP_SERVER },
    { label: 'Auth Type', value: trunk.auth_type.toUpperCase() },
    ...(showAuthIps
      ? [{
          label: 'Auth IPs',
          value: trunk.ips.length > 0
            ? trunk.ips.map((ip) => ip.ip_address + (ip.description ? ` (${ip.description})` : '')).join(', ')
            : null,
          empty: 'None configured',
          emptyRed: true,
        }]
      : []),
    ...(trunk.tech_prefix ? [{ label: 'Tech Prefix', value: trunk.tech_prefix }] : []),
    { label: 'Max Channels', value: String(trunk.max_channels) },
    { label: 'CPS Limit', value: String(trunk.cps_limit) },
    {
      label: 'DIDs',
      value: trunk.dids.length > 0 ? trunk.dids.map((d) => d.did).join(', ') : null,
      empty: 'None assigned',
    },
  ];

  return (
    <div className="dlx-well" style={{ gap: 20, padding: '18px 20px', marginBottom: 20 }}>

      {/* ── Trunk header ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: '"Archivo", "IBM Plex Sans", sans-serif', fontSize: '0.95rem', fontWeight: 700, color: 'var(--rcf-ink)', letterSpacing: '-0.01em' }}>
          {trunk.trunk_name}
        </span>
        <span className={trunk.enabled ? 'dl-pill dl-pill-on' : 'dl-pill dl-pill-off'}>
          {trunk.enabled ? 'Active' : 'Disabled'}
        </span>
        <span className="dl-tag dl-tag-slate">{trunk.auth_type} auth</span>
        <span style={{ fontFamily: MONO, fontSize: '0.72rem', color: 'var(--rcf-ink-dim)', marginLeft: 'auto' }}>
          trunk#{trunk.id}
        </span>
      </div>

      {/* ── Quick stats row ── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <FactChip label="Channels" value={trunk.max_channels} />
        <FactChip label="CPS" value={trunk.cps_limit ?? '--'} />
        <FactChip label="IPs" value={trunk.ips.length} />
        <FactChip label="DIDs" value={trunk.dids.length} />
      </div>

      {/* ── Connection Details ── */}
      <div>
        <h4 className="dl-section-title">Connection Details</h4>
        <div className="dl-kvbox">
          {connectionFacts.map(({ label, value, empty, emptyRed }) => (
            <div key={label} className="dl-kv">
              <span className="dl-kv-label">{label}</span>
              {value !== null && value !== undefined && value !== '' ? (
                <span className="dl-kv-value" style={{ fontFamily: MONO, overflowWrap: 'anywhere', textAlign: 'right' }}>
                  {value}
                </span>
              ) : (
                <span
                  className="dl-kv-value"
                  style={{
                    fontFamily: MONO,
                    fontWeight: 500,
                    color: emptyRed ? 'var(--rcf-red)' : 'var(--rcf-ink-dim)',
                  }}
                >
                  {empty}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── Capacity ── */}
      <div>
        <h4 className="dl-section-title">Capacity</h4>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          <FactChip
            label="Call Paths"
            value={<span style={{ color: 'var(--rcf-azure-deep)' }}>{trunk.max_channels}</span>}
            hint={trunk.package_name ?? undefined}
          />
          <FactChip
            label="CPS Limit"
            value={<span style={{ color: 'var(--rcf-azure-deep)' }}>{trunk.cps_limit}</span>}
          />
        </div>

        <div className="dl-help" style={{ margin: '0 0 8px' }}>Change call path package</div>
        <div
          style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}
          onClick={(e) => e.stopPropagation()}
        >
          <select
            className="dl-input"
            value={selectedPackageId}
            onChange={(e) => setSelectedPackageId(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            style={{ minWidth: 220, maxWidth: 320 }}
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
          <button
            type="button"
            className="dl-btn dl-btn-primary dlx-btn-sm"
            disabled={assignPackageMutation.isPending}
            onClick={handleApplyPackage}
          >
            {assignPackageMutation.isPending ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>

      {/* ── Authorized IPs ── */}
      {showAuthIps && (
        <div style={{ paddingTop: 16, borderTop: '1px solid var(--rcf-line)' }}>
          <h4 className="dl-section-title">
            Authorized IPs
            <span className="dl-count">{trunk.ips.length}</span>
          </h4>

          {trunk.ips.length === 0 ? (
            <div style={{ fontSize: '0.78rem', color: 'var(--rcf-ink-dim)', marginBottom: 12 }}>
              No IPs configured
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
              {trunk.ips.map((ip) => (
                <div
                  key={ip.id}
                  className="dl-item"
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px' }}
                  onClick={(e) => e.stopPropagation()}
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
                    onClick={(e) => { e.stopPropagation(); handleRemoveIp(ip); }}
                    disabled={removeIpMutation.isPending}
                    title="Remove IP"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <form
            onSubmit={handleAddIp}
            onClick={(e) => e.stopPropagation()}
            style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}
          >
            <Field label="IP Address">
              <input
                type="text"
                className="dl-input dl-input-mono"
                value={newIp}
                onChange={(e) => setNewIp(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                placeholder="192.0.2.1"
                style={{ width: 150 }}
              />
            </Field>
            <Field label="Description (optional)">
              <input
                type="text"
                className="dl-input"
                value={newIpDesc}
                onChange={(e) => setNewIpDesc(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                placeholder="Main PBX"
                style={{ width: 180 }}
              />
            </Field>
            <button
              type="submit"
              className="dl-btn dl-btn-ghost"
              disabled={addIpMutation.isPending}
              onClick={(e) => e.stopPropagation()}
            >
              {addIpMutation.isPending ? 'Adding…' : '+ Add IP'}
            </button>
          </form>
        </div>
      )}

      {/* ── Assigned DIDs ── */}
      <div style={{ paddingTop: 16, borderTop: '1px solid var(--rcf-line)' }}>
        <h4 className="dl-section-title">
          Assigned DIDs
          <span className="dl-count">{trunk.dids.length}</span>
        </h4>

        {trunk.dids.length === 0 ? (
          <div style={{ fontSize: '0.78rem', color: 'var(--rcf-ink-dim)', marginBottom: 12 }}>
            No DIDs assigned
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            {trunk.dids.map((d) => (
              <span key={d.id} className="dl-chip">{d.did}</span>
            ))}
          </div>
        )}

        <form
          onSubmit={handleAddDid}
          onClick={(e) => e.stopPropagation()}
          style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}
        >
          <Field label="DID">
            <input
              type="tel"
              className="dl-input dl-input-mono"
              value={newDid}
              onChange={(e) => setNewDid(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              placeholder="+1XXXXXXXXXX"
              style={{ width: 180 }}
            />
          </Field>
          <button
            type="submit"
            className="dl-btn dl-btn-ghost"
            disabled={addDidMutation.isPending}
            onClick={(e) => e.stopPropagation()}
          >
            {addDidMutation.isPending ? 'Assigning…' : 'Assign DID'}
          </button>
        </form>
      </div>

      {/* ── Enable / Disable ── */}
      <div
        style={{
          borderTop: '1px solid var(--rcf-line)',
          paddingTop: 14,
          display: 'flex',
          justifyContent: 'flex-end',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className={trunk.enabled ? 'dl-btn dl-btn-danger' : 'dl-btn dlx-btn-ok'}
          disabled={toggleMutation.isPending}
          onClick={(e) => {
            e.stopPropagation();
            toggleMutation.mutate(!trunk.enabled);
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
  const [selectedTrunkId, setSelectedTrunkId] = useState<number | null>(null);

  // Capacity + Authorized-IP controllers (own their state + the shared
  // ['trunk-tiers'] query). Declared with the other hooks, above any early
  // return, so hook order never changes — React #310.
  const capacity = useTrunkCapacity();
  const authIps = useTrunkAuthIps();

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
        auth_type: newTrunkAuth,
        // tier → { cps_tier_id }; custom → { cps_limit, max_channels }
        ...capacity.buildPayload(),
        ...(authIps.ips.length > 0 ? { auth_ips: authIps.ips } : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customerTrunks', customerId] });
      setNewTrunkName('');
      setNewTrunkAuth('ip');
      capacity.reset();
      authIps.reset();
      toastOk(`Trunk "${newTrunkName.trim()}" created`);
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleCreateTrunk(e: React.FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!newTrunkName.trim()) { toastErr('Trunk name is required'); return; }
    const capacityError = capacity.validate();
    if (capacityError) { toastErr(capacityError); return; }
    createTrunkMutation.mutate();
  }

  const trunks = trunksData ?? [];

  return (
    <section className="dl-panel">
      {/* ── Panel head ── */}
      <div className="dl-panel-head" style={{ flexWrap: 'nowrap' }}>
        <span aria-hidden="true" style={{ display: 'inline-flex', color: 'var(--rcf-azure-deep)', flexShrink: 0 }}>
          <Share2 size={15} strokeWidth={2} />
        </span>
        <h3 className="dl-panel-title" style={{ margin: 0 }}>Trunk Configuration</h3>
        {!isLoading && !isError && (
          <span className="dl-count">{trunks.length === 1 ? '1 trunk' : `${trunks.length} trunks`}</span>
        )}
        <button
          type="button"
          className="dlx-linkbtn"
          style={{ marginLeft: 'auto', flexShrink: 0 }}
          onClick={(e) => { e.stopPropagation(); navigate('/trunks'); }}
        >
          Manage Trunks →
        </button>
      </div>

      <div className="dl-panel-body">
        {isLoading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--rcf-ink-dim)', fontSize: '0.8rem', padding: '8px 0' }}>
            <Spinner size="xs" /> Loading trunks…
          </div>
        )}

        {isError && <div className="dl-banner dl-banner-err">Could not load trunks.</div>}

        {!isLoading && !isError && trunks.length === 0 && (
          <div className="dl-empty" style={{ marginBottom: 16 }}>No trunks configured.</div>
        )}

        {/* Trunk selector dropdown */}
        {!isLoading && trunks.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <select
              className="dl-input"
              value={selectedTrunkId ?? ''}
              onChange={(e) => setSelectedTrunkId(e.target.value ? Number(e.target.value) : null)}
              style={{ minWidth: 280, maxWidth: '100%' }}
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
            <TrunkCard key={trunk.id} trunk={trunk} customerId={customerId} />
          ))}

        {/* Create New Trunk form */}
        <form
          onSubmit={handleCreateTrunk}
          onClick={(e) => e.stopPropagation()}
          style={{ paddingTop: 16, borderTop: '1px solid var(--rcf-line)' }}
        >
          <h4 className="dl-section-title">Create New Trunk</h4>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
            <Field label="Trunk Name">
              <input
                type="text"
                className="dl-input"
                value={newTrunkName}
                onChange={(e) => setNewTrunkName(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                placeholder="acme-primary"
                style={{ width: 170 }}
              />
            </Field>
            <Field label="Auth Type">
              <select
                className="dl-input"
                value={newTrunkAuth}
                onChange={(e) => setNewTrunkAuth(e.target.value as TrunkAuthType)}
                onClick={(e) => e.stopPropagation()}
                style={{ width: 150 }}
              >
                <option value="ip">IP Auth</option>
                <option value="credentials">Credential</option>
                <option value="both">Both</option>
              </select>
            </Field>
          </div>

          {/* Capacity — purchased tier OR custom CPS / call paths */}
          <div style={{ marginTop: 20, maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
            <DaylightCapacitySection ctl={capacity} />
          </div>

          {/* Authorized IPs — optional whitelist at creation */}
          <div style={{ marginTop: 20, maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
            <DaylightAuthIpsSection ctl={authIps} />
          </div>

          <div style={{ marginTop: 20 }}>
            <button
              type="submit"
              className="dl-btn dl-btn-primary"
              disabled={createTrunkMutation.isPending}
              onClick={(e) => e.stopPropagation()}
            >
              {createTrunkMutation.isPending ? 'Creating…' : 'Create Trunk'}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
