/**
 * TrunksPage — the customer-facing SIP Trunking portal.
 *
 * Scope (RCF-V1): trunk provisioning is ADMIN-only, so this page is read +
 * self-serve only. A trunk customer can:
 *   - view their trunk(s), status, CPS tier and included call paths
 *   - see the Connection / Setup details they point their PBX at
 *   - self-manage the trunk's authorized source IPs (add / delete)
 *   - watch live activity (channels in use, calls/min, volume, spend)
 *
 * It NEVER creates trunks (that is admin) and RCF customers must never reach it
 * — the page is gated on account_type ∈ {trunk, hybrid}. Sidebar nav gating is
 * handled separately; this component is self-safe regardless of how it is
 * reached.
 *
 * Data layer: everything goes through the existing owner-scoped functions in
 * `src/api/trunks.ts` (listTrunks, getTrunkIps, addTrunkIp, deleteTrunkIp,
 * getTrunkDids, getTrunkStats). No new endpoints are invented.
 *
 * React #310: every hook in every component below is called unconditionally at
 * the top of its function, before any early return.
 */

import { useMemo, useState, type ReactNode, type CSSProperties } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { PortalHeader } from './RcfPage';
import { IconTrunk } from '../components/icons/ProductIcons';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { fmt, fmtMoney } from '../utils/format';

import type { Trunk, TrunkIp, TrunkDid, TrunkAuthType } from '../types/trunk';
import {
  listTrunks,
  getTrunkIps,
  addTrunkIp,
  deleteTrunkIp,
  getTrunkDids,
  getTrunkStats,
} from '../api/trunks';

/* ═══════════════════════════════════════════════════════════════════════════
   Constants + shared tokens
   ═══════════════════════════════════════════════════════════════════════════ */

const ACCENT = '#3b82f6';

/** Human-readable label for each auth mode, shown in the connection panel. */
const AUTH_LABEL: Record<TrunkAuthType, string> = {
  ip: 'IP authentication',
  credentials: 'Credential authentication',
  both: 'IP + Credential authentication',
};

/**
 * Extended stats shape returned by the API. The typed `TrunkStats` in
 * types/trunk.ts only captures part of the response, so — matching the pattern
 * already used in TrunkCard.tsx — we widen it locally to cover the live fields
 * the portal renders (current channels, last-hour rollup, utilization).
 */
interface ExtendedTrunkStats {
  active_channels?: number;
  current_channels?: number;
  max_channels?: number;
  calls_today?: number;
  minutes_today?: number;
  cost_today?: number;
  channel_utilization?: string;
  last_hour?: {
    total_calls?: number;
    asr?: string;
    avg_duration_sec?: number;
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   IP validation — IPv4, optionally with a CIDR suffix (e.g. 203.0.113.0/24)
   ═══════════════════════════════════════════════════════════════════════════ */

function isValidIpv4(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  const [addr, mask, ...rest] = trimmed.split('/');
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

/* ═══════════════════════════════════════════════════════════════════════════
   Small presentational helpers
   ═══════════════════════════════════════════════════════════════════════════ */

const sectionLabelStyle: CSSProperties = {
  fontSize: '0.7rem',
  fontWeight: 700,
  color: '#718096',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  margin: '0 0 12px',
};

function SectionLabel({ children }: { children: ReactNode }) {
  return <h3 style={sectionLabelStyle}>{children}</h3>;
}

/** A frosted-glass metric tile (label + large value) for live activity. */
function StatTile({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div
      className="glass-surface"
      style={{
        padding: '14px 16px',
        borderRadius: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minWidth: 0,
      }}
    >
      <span
        style={{
          fontSize: '0.66rem',
          fontWeight: 700,
          color: '#718096',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: '1.5rem',
          fontWeight: 700,
          color: '#e2e8f0',
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1.05,
        }}
      >
        {value}
      </span>
      {hint && (
        <span style={{ fontSize: '0.68rem', color: '#475569', lineHeight: 1.3 }}>{hint}</span>
      )}
    </div>
  );
}

/** i-badge used inline in notes. */
function InfoBadge() {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 15,
        height: 15,
        borderRadius: '50%',
        border: '1px solid rgba(96,165,250,0.5)',
        color: '#60a5fa',
        fontSize: '0.6rem',
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      i
    </span>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Live activity — polled gently (15s) so channels-in-use stays fresh
   ═══════════════════════════════════════════════════════════════════════════ */

function LiveActivity({ trunkId, maxChannels }: { trunkId: number; maxChannels: number }) {
  const statsQuery = useQuery<ExtendedTrunkStats>({
    queryKey: ['trunk-stats', trunkId],
    queryFn: () => getTrunkStats(trunkId) as Promise<ExtendedTrunkStats>,
    refetchInterval: 15_000,
    staleTime: 5_000,
  });

  const s = statsQuery.data;
  const active = s?.current_channels ?? s?.active_channels ?? 0;
  const cap = s?.max_channels ?? maxChannels ?? 0;
  const utilPct = cap > 0 ? Math.min(100, Math.round((active / cap) * 100)) : 0;
  const utilBarColor = utilPct >= 80 ? '#ef4444' : utilPct >= 50 ? '#f59e0b' : '#22c55e';
  const lastHour = s?.last_hour;

  const loading = statsQuery.isLoading;

  return (
    <section aria-label="Live activity">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 12,
          flexWrap: 'wrap',
        }}
      >
        <SectionLabel>Live activity</SectionLabel>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span
            aria-hidden="true"
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: statsQuery.isError ? '#ef4444' : '#22c55e',
              boxShadow: statsQuery.isError
                ? '0 0 6px rgba(239,68,68,0.6)'
                : '0 0 6px rgba(34,197,94,0.6)',
              flexShrink: 0,
            }}
          />
          <span style={{ fontSize: '0.66rem', color: '#64748b', letterSpacing: '0.02em' }}>
            {statsQuery.isError ? 'Offline' : 'Live · auto-refresh 15s'}
          </span>
        </div>
      </div>

      {statsQuery.isError ? (
        <p style={{ fontSize: '0.82rem', color: '#f87171', margin: 0 }}>
          Live statistics are temporarily unavailable. Your trunk keeps running — this only
          affects the dashboard.
        </p>
      ) : (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: 12,
            }}
          >
            <StatTile
              label="Channels in use"
              value={
                loading ? (
                  '…'
                ) : (
                  <>
                    {active}
                    <span style={{ fontSize: '0.95rem', fontWeight: 500, color: '#718096' }}>
                      {' '}/ {cap}
                    </span>
                  </>
                )
              }
              hint={loading ? undefined : `${utilPct}% utilization`}
            />
            <StatTile
              label="Answer rate (1h)"
              value={loading ? '…' : lastHour?.asr ? lastHour.asr : '—'}
              hint="ASR, last hour"
            />
            <StatTile
              label="Calls today"
              value={loading ? '…' : (s?.calls_today ?? 0).toLocaleString()}
              hint={
                lastHour?.total_calls != null
                  ? `${lastHour.total_calls.toLocaleString()} in the last hour`
                  : undefined
              }
            />
            <StatTile
              label="Minutes today"
              value={loading ? '…' : Math.round(s?.minutes_today ?? 0).toLocaleString()}
              hint={s?.cost_today != null ? `${fmtMoney(s.cost_today)} spend` : undefined}
            />
          </div>

          {/* Utilization bar under the tiles */}
          {!loading && cap > 0 && (
            <div style={{ marginTop: 14 }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: '0.66rem',
                  color: '#64748b',
                  marginBottom: 6,
                }}
              >
                <span>Concurrent channel usage</span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {active} of {cap}
                </span>
              </div>
              <div
                style={{
                  width: '100%',
                  height: 6,
                  borderRadius: 6,
                  background: 'rgba(42,47,69,0.8)',
                  overflow: 'hidden',
                }}
                role="progressbar"
                aria-valuenow={utilPct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`Channel utilization: ${utilPct}%`}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${utilPct}%`,
                    borderRadius: 6,
                    backgroundColor: utilBarColor,
                    transition: 'width 0.3s ease',
                  }}
                />
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Capacity / plan summary — CPS tier + included call paths
   ═══════════════════════════════════════════════════════════════════════════ */

function ConfigRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 16,
        padding: '9px 0',
        borderBottom: '1px solid rgba(59,130,246,0.08)',
      }}
    >
      <span style={{ fontSize: '0.75rem', color: '#718096', flexShrink: 0 }}>{label}</span>
      <span
        style={{
          fontSize: '0.85rem',
          color: '#e2e8f0',
          fontWeight: 600,
          textAlign: 'right',
          minWidth: 0,
        }}
      >
        {value}
      </span>
    </div>
  );
}

function PlanSummary({ trunk }: { trunk: Trunk }) {
  return (
    <section aria-label="Plan and capacity">
      <SectionLabel>Plan &amp; capacity</SectionLabel>
      <div
        style={{
          background: 'rgba(15,17,23,0.4)',
          border: '1px solid rgba(59,130,246,0.10)',
          borderRadius: 12,
          padding: '4px 16px 8px',
        }}
      >
        <ConfigRow
          label="Call-path package"
          value={trunk.package_name ?? 'Standard'}
        />
        <ConfigRow
          label="Included call paths"
          value={
            <>
              {trunk.max_channels}
              <span style={{ color: '#718096', fontWeight: 500 }}> concurrent</span>
            </>
          }
        />
        <ConfigRow
          label="CPS tier"
          value={
            <>
              {trunk.cps_limit}
              <span style={{ color: '#718096', fontWeight: 500 }}> calls/sec</span>
            </>
          }
        />
        <ConfigRow label="Authentication" value={AUTH_LABEL[trunk.auth_type]} />
        {trunk.tech_prefix ? (
          <ConfigRow
            label="Tech prefix"
            value={
              <span
                style={{
                  fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
                }}
              >
                {trunk.tech_prefix}
              </span>
            }
          />
        ) : null}
      </div>
      <p
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          margin: '10px 2px 0',
          fontSize: '0.72rem',
          color: '#718096',
          lineHeight: 1.5,
        }}
      >
        <InfoBadge />
        Contact your account team to change channel capacity, CPS limits, or your call-path
        package.
      </p>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Connection / Setup panel — what the customer points their PBX at.
   The per-zone SBC endpoint is NOT exposed by the trunk API, so we present a
   clearly-labeled setup section: the authorized-source-IP list is the
   load-bearing self-serve config, plus a note that the exact SBC host is issued
   during provisioning.
   ═══════════════════════════════════════════════════════════════════════════ */

function ConnectionPanel({
  trunk,
  ips,
  ipsLoading,
}: {
  trunk: Trunk;
  ips: TrunkIp[] | null;
  ipsLoading: boolean;
}) {
  return (
    <section aria-label="Connection and setup">
      <SectionLabel>Connection &amp; setup</SectionLabel>

      <div
        style={{
          background: 'rgba(15,17,23,0.4)',
          border: '1px solid rgba(59,130,246,0.10)',
          borderRadius: 12,
          padding: '4px 16px 8px',
        }}
      >
        <ConfigRow
          label="SBC / SIP host"
          value={
            <span style={{ color: '#94a3b8', fontWeight: 500, fontStyle: 'italic' }}>
              Issued at provisioning
            </span>
          }
        />
        <ConfigRow
          label="Signaling"
          value={
            <span
              style={{
                fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
              }}
            >
              SIP · UDP/5060
            </span>
          }
        />
        <ConfigRow label="Authentication" value={AUTH_LABEL[trunk.auth_type]} />
        <ConfigRow
          label="Authorized sources"
          value={
            ipsLoading ? (
              '…'
            ) : (
              <>
                {ips?.length ?? 0}
                <span style={{ color: '#718096', fontWeight: 500 }}>
                  {' '}
                  IP{(ips?.length ?? 0) === 1 ? '' : 's'}
                </span>
              </>
            )
          }
        />
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          marginTop: 12,
          padding: '10px 12px',
          borderRadius: 10,
          background: 'rgba(59,130,246,0.06)',
          border: '1px solid rgba(59,130,246,0.16)',
        }}
      >
        <InfoBadge />
        <p style={{ margin: 0, fontSize: '0.75rem', color: '#94a3b8', lineHeight: 1.55 }}>
          {(trunk.auth_type === 'ip' || trunk.auth_type === 'both') ? (
            <>
              Point your PBX or SBC at the platform SIP host issued to you during onboarding, and
              make sure calls originate from one of your <strong style={{ color: '#cbd5e0' }}>authorized
              source IPs</strong> below — traffic from any other address is rejected.
            </>
          ) : (
            <>
              Point your PBX or SBC at the platform SIP host issued to you during onboarding and
              authenticate with your trunk credentials. Your account team can confirm the exact
              host and port for your region.
            </>
          )}
        </p>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Authorized IP management — self-serve list / add / delete (owner-scoped)
   ═══════════════════════════════════════════════════════════════════════════ */

function IpRow({
  ip,
  canManage,
  onDelete,
  deleting,
}: {
  ip: TrunkIp;
  canManage: boolean;
  onDelete: (ip: TrunkIp) => void;
  deleting: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        background: 'rgba(30,33,48,0.8)',
        border: '1px solid rgba(59,130,246,0.15)',
        borderRadius: 8,
        padding: '7px 12px',
        opacity: deleting ? 0.5 : 1,
        transition: 'opacity 0.15s',
      }}
    >
      <span
        style={{
          fontSize: '0.82rem',
          fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
          color: '#e2e8f0',
          fontWeight: 600,
        }}
      >
        {ip.ip_address}
      </span>
      {ip.description && (
        <span style={{ fontSize: '0.72rem', color: '#718096' }}>{ip.description}</span>
      )}
      {canManage && (
        <button
          type="button"
          onClick={() => onDelete(ip)}
          disabled={deleting}
          title={`Remove ${ip.ip_address}`}
          aria-label={`Remove authorized IP ${ip.ip_address}`}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          style={{
            marginLeft: 'auto',
            background: 'none',
            border: 'none',
            color: hovered ? '#f87171' : '#718096',
            cursor: deleting ? 'not-allowed' : 'pointer',
            padding: '0 2px',
            fontSize: '1.05rem',
            lineHeight: 1,
            transition: 'color 0.15s',
          }}
        >
          &times;
        </button>
      )}
    </div>
  );
}

function AuthIpManager({ trunkId, canManage }: { trunkId: number; canManage: boolean }) {
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
  const deletingId = deleteMutation.isPending ? deleteMutation.variables : undefined;

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!ipValid) {
      toastErr('Enter a valid IPv4 address (optionally with a CIDR mask, e.g. 203.0.113.0/24)');
      return;
    }
    addMutation.mutate();
  }

  function handleDelete(ip: TrunkIp) {
    if (
      !confirm(
        `Remove ${ip.ip_address} from this trunk's authorized IPs? Calls from this address will be rejected.`,
      )
    ) {
      return;
    }
    deleteMutation.mutate(ip.id);
  }

  const ips = ipsQuery.data ?? null;

  return (
    <section aria-label="Authorized IP addresses">
      <SectionLabel>
        Authorized source IPs{' '}
        <span
          style={{
            fontWeight: 400,
            textTransform: 'none',
            letterSpacing: 'normal',
            fontSize: '0.68rem',
            color: '#718096',
          }}
        >
          (addresses permitted to send calls on this trunk)
        </span>
      </SectionLabel>

      {ipsQuery.isLoading && (
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#718096', fontSize: '0.8rem' }}
        >
          <Spinner size="xs" /> Loading IPs…
        </div>
      )}

      {ipsQuery.isError && (
        <p style={{ fontSize: '0.82rem', color: '#f87171', margin: 0 }}>
          Could not load authorized IPs. Refresh the page to try again.
        </p>
      )}

      {!ipsQuery.isLoading && !ipsQuery.isError && ips !== null && ips.length === 0 && (
        <p style={{ fontSize: '0.82rem', color: '#f59e0b', margin: '0 0 4px' }}>
          No authorized IPs yet — add your PBX or SBC address below to start sending traffic.
        </p>
      )}

      {ips !== null && ips.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {ips.map((ip) => (
            <IpRow
              key={ip.id}
              ip={ip}
              canManage={canManage}
              onDelete={handleDelete}
              deleting={deletingId === ip.id}
            />
          ))}
        </div>
      )}

      {canManage ? (
        <form
          onSubmit={handleAdd}
          style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start', marginTop: 12 }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <input
              type="text"
              value={newIp}
              onChange={(e) => setNewIp(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="203.0.113.50"
              aria-label="New authorized IP address"
              aria-invalid={showError}
              className="form-control"
              style={{
                width: 170,
                fontSize: '0.82rem',
                fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
                boxShadow: showError ? 'inset 0 0 0 1px rgba(239,68,68,0.6)' : undefined,
              }}
            />
            {showError && (
              <span style={{ fontSize: '0.66rem', color: '#f87171' }}>
                Invalid IPv4 address
              </span>
            )}
          </div>
          <input
            type="text"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Description (optional)"
            aria-label="Description for the new IP"
            className="form-control"
            style={{ width: 200, fontSize: '0.82rem' }}
          />
          <Button type="submit" variant="ghost" size="sm" loading={addMutation.isPending}>
            Add IP
          </Button>
        </form>
      ) : (
        <p style={{ fontSize: '0.72rem', color: '#718096', marginTop: 10 }}>
          Read-only access — contact an administrator to change authorized IPs.
        </p>
      )}
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Routed DIDs
   ═══════════════════════════════════════════════════════════════════════════ */

function DidList({ trunkId }: { trunkId: number }) {
  const didsQuery = useQuery<TrunkDid[]>({
    queryKey: ['trunk-dids', trunkId],
    queryFn: () => getTrunkDids(trunkId),
    staleTime: 30_000,
  });

  const dids = didsQuery.data ?? null;

  return (
    <section aria-label="Assigned DIDs">
      <SectionLabel>Inbound DIDs routed to this trunk</SectionLabel>

      {didsQuery.isLoading && (
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#718096', fontSize: '0.8rem' }}
        >
          <Spinner size="xs" /> Loading DIDs…
        </div>
      )}

      {didsQuery.isError && (
        <p style={{ fontSize: '0.82rem', color: '#f87171', margin: 0 }}>
          Could not load DIDs. Refresh the page to try again.
        </p>
      )}

      {!didsQuery.isLoading && !didsQuery.isError && dids !== null && dids.length === 0 && (
        <p style={{ fontSize: '0.82rem', color: '#718096', margin: 0 }}>
          No DIDs are currently routed to this trunk. Contact your account team to assign numbers.
        </p>
      )}

      {dids !== null && dids.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {dids.map((d) => (
            <span
              key={d.id}
              title={d.enabled ? 'Active' : 'Disabled'}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                fontSize: '0.8rem',
                fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
                fontWeight: 600,
                background: 'rgba(30,33,48,0.8)',
                color: d.enabled ? '#e2e8f0' : '#64748b',
                border: '1px solid rgba(59,130,246,0.15)',
                padding: '5px 11px',
                borderRadius: 8,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: d.enabled ? '#22c55e' : '#475569',
                  flexShrink: 0,
                }}
              />
              {fmt(d.did)}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Trunk panel — one full trunk: header + all sections
   ═══════════════════════════════════════════════════════════════════════════ */

function TrunkPanel({ trunk, canManage }: { trunk: Trunk; canManage: boolean }) {
  // IPs are read once here and shared with the Connection panel to avoid a
  // duplicate request; the AuthIpManager reads the same cached query key.
  const ipsQuery = useQuery<TrunkIp[]>({
    queryKey: ['trunk-ips', trunk.id],
    queryFn: () => getTrunkIps(trunk.id),
    staleTime: 30_000,
  });

  return (
    <div
      className="glass-surface"
      style={{ borderRadius: 20, overflow: 'hidden', position: 'relative' }}
    >
      {/* Top accent line */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 0,
          left: 32,
          right: 32,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${ACCENT}80, transparent)`,
          opacity: 0.4,
        }}
      />

      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          padding: '24px 28px 18px',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontSize: '1.15rem',
              fontWeight: 700,
              color: '#e2e8f0',
              letterSpacing: '-0.01em',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 34,
                height: 34,
                borderRadius: 10,
                background: 'linear-gradient(135deg, rgba(59,130,246,0.15) 0%, rgba(59,130,246,0.05) 100%)',
                border: '1px solid rgba(59,130,246,0.25)',
                color: '#60a5fa',
                flexShrink: 0,
              }}
            >
              <IconTrunk size={18} />
            </span>
            <span
              style={{
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {trunk.trunk_name}
            </span>
          </div>
          <div
            style={{
              fontSize: '0.72rem',
              color: '#718096',
              marginTop: 6,
              marginLeft: 44,
            }}
          >
            {AUTH_LABEL[trunk.auth_type]} · {trunk.max_channels} call path
            {trunk.max_channels === 1 ? '' : 's'} · {trunk.cps_limit} CPS
          </div>
        </div>
        <Badge variant={trunk.enabled ? 'active' : 'disabled'}>
          {trunk.enabled ? 'Active' : 'Disabled'}
        </Badge>
      </div>

      {/* Suspended notice */}
      {!trunk.enabled && (
        <div
          style={{
            margin: '0 28px 4px',
            padding: '10px 14px',
            borderRadius: 10,
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.2)',
            fontSize: '0.78rem',
            color: '#fca5a5',
          }}
        >
          This trunk is currently disabled — calls will be rejected. Contact your account team to
          re-enable it.
        </div>
      )}

      {/* Body — sections */}
      <div
        style={{
          padding: '18px 28px 28px',
          display: 'flex',
          flexDirection: 'column',
          gap: 28,
        }}
      >
        <LiveActivity trunkId={trunk.id} maxChannels={trunk.max_channels} />

        {/* Two-column: plan + connection */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: 28,
          }}
        >
          <PlanSummary trunk={trunk} />
          <ConnectionPanel
            trunk={trunk}
            ips={ipsQuery.data ?? null}
            ipsLoading={ipsQuery.isLoading}
          />
        </div>

        <AuthIpManager trunkId={trunk.id} canManage={canManage} />
        <DidList trunkId={trunk.id} />
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   States: gate / loading / error / empty
   ═══════════════════════════════════════════════════════════════════════════ */

function CenteredGlass({ children }: { children: ReactNode }) {
  return (
    <div
      className="glass-surface"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '72px 24px',
        textAlign: 'center',
        borderRadius: 20,
      }}
    >
      {children}
    </div>
  );
}

function TrunkIconBadge() {
  return (
    <div
      aria-hidden="true"
      style={{
        width: 64,
        height: 64,
        borderRadius: 16,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 20,
        background: 'linear-gradient(135deg, rgba(59,130,246,0.15) 0%, rgba(59,130,246,0.05) 100%)',
        border: '1px solid rgba(59,130,246,0.25)',
        color: '#60a5fa',
        boxShadow: '0 0 24px rgba(59,130,246,0.18)',
      }}
    >
      <IconTrunk size={32} />
    </div>
  );
}

/** Shown when a non-trunk account somehow reaches this page. */
function NotAvailableState() {
  return (
    <CenteredGlass>
      <TrunkIconBadge />
      <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: '#e2e8f0', margin: '0 0 8px' }}>
        SIP Trunking isn&apos;t part of your plan
      </h2>
      <p style={{ fontSize: '0.88rem', color: '#718096', maxWidth: 440, lineHeight: 1.6, margin: 0 }}>
        Your account isn&apos;t set up for SIP trunking. If you&apos;d like to connect a PBX or SBC
        to our network, contact your account team to add a trunk.
      </p>
    </CenteredGlass>
  );
}

/** Shown when the customer is a trunk account but has no trunk provisioned. */
function EmptyState() {
  return (
    <CenteredGlass>
      <TrunkIconBadge />
      <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: '#e2e8f0', margin: '0 0 8px' }}>
        Your SIP trunk isn&apos;t provisioned yet
      </h2>
      <p
        style={{
          fontSize: '0.88rem',
          color: '#718096',
          maxWidth: 460,
          lineHeight: 1.6,
          margin: '0 0 20px',
        }}
      >
        Trunk provisioning is handled by our team. Contact us to get set up — once your trunk is
        live, you&apos;ll manage its authorized IPs and watch live activity right here.
      </p>
      <div
        style={{
          padding: '8px 16px',
          borderRadius: 8,
          background: 'rgba(59,130,246,0.08)',
          border: '1px solid rgba(59,130,246,0.2)',
          color: '#60a5fa',
          fontSize: '0.78rem',
          fontWeight: 600,
          letterSpacing: '0.02em',
        }}
      >
        Contact your account team to get started
      </div>
    </CenteredGlass>
  );
}

function LoadingState() {
  return (
    <CenteredGlass>
      <Spinner size="lg" />
      <p style={{ fontSize: '0.85rem', color: '#718096', marginTop: 14 }}>Loading your trunks…</p>
    </CenteredGlass>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <CenteredGlass>
      <div
        aria-hidden="true"
        style={{
          width: 56,
          height: 56,
          borderRadius: 14,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 18,
          background: 'rgba(239,68,68,0.10)',
          border: '1px solid rgba(239,68,68,0.25)',
          color: '#f87171',
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} style={{ width: 26, height: 26 }}>
          <path d="M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#e2e8f0', margin: '0 0 8px' }}>
        Couldn&apos;t load your trunks
      </h2>
      <p style={{ fontSize: '0.85rem', color: '#718096', maxWidth: 400, lineHeight: 1.6, margin: '0 0 18px' }}>
        Something went wrong fetching your trunk details. Please try again.
      </p>
      <Button variant="primary" onClick={onRetry}>
        Retry
      </Button>
    </CenteredGlass>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   Page
   ═══════════════════════════════════════════════════════════════════════════ */

export function TrunksPage() {
  const { user, isActualAdmin } = useAuth();

  // account_type gate: this portal is for trunk + hybrid customers only.
  // Admins previewing the app (customer view) or operating it get through so
  // they can support the page; RCF/api/ucaas customers get the not-available
  // state. Sidebar nav gating is handled separately — this keeps the page safe
  // regardless of how it is reached.
  const accountType = user?.account_type ?? null;
  const isTrunkAccount = accountType === 'trunk' || accountType === 'hybrid';
  const allowed = isTrunkAccount || isActualAdmin;

  // Read-only users may view but not mutate.
  const canManage = user?.role !== 'readonly';

  // Owner-scoped: the backend filters listTrunks() to the caller's customer, so
  // no customer_id is sent. Admins see the full list (this page is primarily a
  // customer view; admins have the dedicated /admin/trunks tools for CRUD).
  const trunksQuery = useQuery({
    queryKey: ['trunks', { scope: 'portal' }],
    queryFn: () => listTrunks({ limit: 200 }),
    enabled: allowed,
  });

  const trunks = useMemo(() => trunksQuery.data?.items ?? [], [trunksQuery.data]);

  const subtitle = isTrunkAccount
    ? 'View your trunk, manage authorized IPs, and monitor live activity.'
    : 'Enterprise SIP trunking with IP-based authentication and channel management.';

  // ── Render ──────────────────────────────────────────────────────────────────
  let body: ReactNode;
  if (!allowed) {
    body = <NotAvailableState />;
  } else if (trunksQuery.isLoading) {
    body = <LoadingState />;
  } else if (trunksQuery.isError) {
    body = <ErrorState onRetry={() => void trunksQuery.refetch()} />;
  } else if (trunks.length === 0) {
    body = <EmptyState />;
  } else {
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {trunks.length > 1 && (
          <p style={{ fontSize: '0.8rem', color: '#718096', margin: 0 }}>
            You have <strong style={{ color: '#cbd5e0' }}>{trunks.length}</strong> trunks.
          </p>
        )}
        {trunks.map((trunk) => (
          <TrunkPanel key={trunk.id} trunk={trunk} canManage={canManage} />
        ))}
      </div>
    );
  }

  return (
    <div style={{ width: '100%' }}>
      <PortalHeader
        icon={<IconTrunk size={24} />}
        title={user?.customer_name ? `${user.customer_name}'s SIP Trunks` : 'SIP Trunks'}
        subtitle={subtitle}
        badgeVariant="trunk"
      />
      {body}
    </div>
  );
}
