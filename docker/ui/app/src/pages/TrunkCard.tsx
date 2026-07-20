/**
 * TrunkCard — one SIP trunk rendered as a frosted liquid-glass card (app-blue
 * theme). Inline-editable name, live channel utilization, and a lazily-loaded
 * expanded section (authorized IPs, assigned DIDs, call-path package).
 *
 * Built on the canonical glass kit (GlassCard / GlassChip / GLASS tokens).
 *
 * React #310: every hook is declared unconditionally at the top of its component
 * (the previous version placed a `hovered` hook after an early return — fixed).
 */

import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Trunk, TrunkIp, TrunkDid } from '../types/trunk';
import { getTrunkIps, getTrunkDids, getTrunkStats, addTrunkIp, deleteTrunkIp, updateTrunk } from '../api/trunks';
import { GlassCard, GlassChip } from '../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../components/glass/glass';
import { Spinner } from '../components/ui/Spinner';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/useAuth';
import { fmt } from '../utils/format';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/**
 * Extended stats shape returned by the API — the typed TrunkStats in types/trunk.ts
 * only captures part of the response. We extend it here to cover the fields the
 * legacy UI references.
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

interface TrunkCardProps {
  trunk: Trunk;
}

// Shared tiny button styles for inline Save/Cancel actions
const inlineSaveBtn: React.CSSProperties = {
  fontSize: '0.65rem',
  fontWeight: 700,
  padding: '5px 11px',
  borderRadius: 7,
  border: 'none',
  background: `linear-gradient(135deg, ${GLASS.accent} 0%, ${hexToRgba(GLASS.accent, 0.78)} 100%)`,
  color: '#fff',
  cursor: 'pointer',
  flexShrink: 0,
  lineHeight: 1,
  boxShadow: `0 4px 14px -4px ${hexToRgba(GLASS.accent, 0.6)}`,
};

const inlineCancelBtn: React.CSSProperties = {
  fontSize: '0.65rem',
  fontWeight: 600,
  padding: '5px 9px',
  borderRadius: 7,
  border: '1px solid rgba(255,255,255,0.10)',
  background: 'rgba(255,255,255,0.04)',
  color: GLASS.textMuted,
  cursor: 'pointer',
  flexShrink: 0,
  lineHeight: 1,
};

// Inline-editable trunk name — looks like static text when unfocused
function TrunkNameField({ trunk, canEdit }: { trunk: Trunk; canEdit: boolean }) {
  // ALL hooks unconditionally at the top (React #310 discipline)
  const qc = useQueryClient();
  const { toastErr } = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(trunk.trunk_name);
  const [hovered, setHovered] = useState(false);
  const [prevName, setPrevName] = useState(trunk.trunk_name);

  // Sync when the trunk prop refreshes from the server (only when not actively editing)
  if (trunk.trunk_name !== prevName) {
    setPrevName(trunk.trunk_name);
    if (!editing) setValue(trunk.trunk_name);
  }

  const mutation = useMutation({
    mutationFn: (name: string) => updateTrunk(trunk.id, { trunk_name: name }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['trunks'] });
      setEditing(false);
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleSave() {
    const trimmed = value.trim();
    if (!trimmed) {
      handleCancel();
      return;
    }
    if (trimmed === trunk.trunk_name) {
      setEditing(false);
      return;
    }
    mutation.mutate(trimmed);
  }

  function handleCancel() {
    setValue(trunk.trunk_name);
    setEditing(false);
  }

  const sharedStyle: React.CSSProperties = {
    fontSize: '1.1rem',
    fontWeight: 700,
    letterSpacing: '-0.01em',
    lineHeight: 1.3,
    color: GLASS.text,
    textShadow: '0 1px 10px rgba(0,0,0,0.5)',
  };

  if (!canEdit) {
    return (
      <div style={{ ...sharedStyle, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {trunk.trunk_name}
      </div>
    );
  }

  if (editing) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <input
          type="text"
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
            ...sharedStyle,
            display: 'block',
            flex: 1,
            minWidth: 80,
            background: 'rgba(8,10,15,0.55)',
            border: `1px solid ${hexToRgba(GLASS.accent, 0.5)}`,
            borderRadius: 8,
            outline: 'none',
            padding: '3px 9px',
            fontFamily: 'inherit',
            opacity: mutation.isPending ? 0.5 : 1,
            boxShadow: `0 0 0 3px ${hexToRgba(GLASS.accent, 0.14)}`,
          }}
        />
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); handleSave(); }}
          disabled={mutation.isPending}
          style={{ ...inlineSaveBtn, opacity: mutation.isPending ? 0.6 : 1 }}
        >
          {mutation.isPending ? '…' : 'Save'}
        </button>
        <button type="button" onMouseDown={(e) => { e.preventDefault(); handleCancel(); }} style={inlineCancelBtn}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} style={{ position: 'relative' }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
        onClick={(e) => { e.stopPropagation(); setEditing(true); }}
        title="Click to rename this trunk"
      >
        <div style={{ ...sharedStyle, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {trunk.trunk_name}
        </div>
        {hovered && (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke={GLASS.accent}
            strokeWidth={1.5}
            style={{ width: 14, height: 14, opacity: 0.7, flexShrink: 0 }}
          >
            <path d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>
      {hovered && (
        <div style={{ fontSize: '0.6rem', color: GLASS.accent, opacity: 0.6, marginTop: 2, letterSpacing: '0.03em' }}>
          Click to rename
        </div>
      )}
    </div>
  );
}

export function TrunkCard({ trunk }: TrunkCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [toggleHover, setToggleHover] = useState(false);
  const { user } = useAuth();
  const canEdit = user?.role !== 'readonly';

  const toggleExpanded = useCallback(() => setExpanded((prev) => !prev), []);

  // Stats — always fetch, poll every 5 seconds for live channel count
  const statsQuery = useQuery<ExtendedTrunkStats>({
    queryKey: ['trunk-stats', trunk.id],
    queryFn: () => getTrunkStats(trunk.id) as Promise<ExtendedTrunkStats>,
    staleTime: 3_000,
    refetchInterval: 5_000,
  });

  // IPs — fetched lazily when the card expands
  const ipsQuery = useQuery<TrunkIp[]>({
    queryKey: ['trunk-ips', trunk.id],
    queryFn: () => getTrunkIps(trunk.id),
    enabled: expanded,
    staleTime: 60_000,
  });

  // DIDs — fetched lazily when the card expands
  const didsQuery = useQuery<TrunkDid[]>({
    queryKey: ['trunk-dids', trunk.id],
    queryFn: () => getTrunkDids(trunk.id),
    enabled: expanded,
    staleTime: 60_000,
  });

  const stats = statsQuery.data;

  // Resolve current channels: prefer stats response, fall back to 0
  const currentChannels = stats?.current_channels ?? stats?.active_channels ?? 0;
  const maxChannels = stats?.max_channels ?? trunk.max_channels ?? 1;
  const utilPct = maxChannels > 0 ? Math.min(100, Math.round((currentChannels / maxChannels) * 100)) : 0;
  const utilLabel = stats?.channel_utilization ?? `${utilPct}%`;
  const utilBarColor = utilPct >= 80 ? GLASS.danger : utilPct >= 50 ? GLASS.warning : GLASS.success;
  const lastHour = stats?.last_hour;

  const accent = trunk.enabled ? GLASS.accent : GLASS.textFaint;

  return (
    <GlassCard accent={accent}>
      {/* Card header: trunk name + auth info + status */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '24px 24px 16px' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <TrunkNameField trunk={trunk} canEdit={canEdit} />
          <div style={{ fontSize: '0.72rem', color: GLASS.textMuted, marginTop: 5, fontFamily: MONO }}>
            {trunk.customer_name && <span style={{ marginRight: 6 }}>{trunk.customer_name}</span>}
            {trunk.auth_type} auth
            {trunk.ip_count != null && <span> &middot; {trunk.ip_count} IP{trunk.ip_count !== 1 ? 's' : ''}</span>}
            {trunk.did_count != null && <span> &middot; {trunk.did_count} DID{trunk.did_count !== 1 ? 's' : ''}</span>}
          </div>
        </div>
        <div style={{ flexShrink: 0, marginTop: 2 }}>
          <GlassChip label={trunk.enabled ? 'Active' : 'Disabled'} color={trunk.enabled ? GLASS.accent : GLASS.danger} dot />
        </div>
      </div>

      {/* Stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', borderTop: '1px solid rgba(255,255,255,0.07)' }}>
        <StatBlock label="Channels">
          <span style={statBigValue}>
            {currentChannels}
            <span style={{ fontSize: '0.85rem', fontWeight: 500, color: GLASS.textMuted }}> / {maxChannels}</span>
          </span>
          <div
            style={{ width: '100%', height: 4, borderRadius: 4, background: 'rgba(255,255,255,0.08)', marginTop: 8, overflow: 'hidden' }}
            role="progressbar"
            aria-valuenow={utilPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Channel utilization: ${utilLabel}`}
          >
            <div style={{ height: '100%', width: `${utilPct}%`, borderRadius: 4, backgroundColor: utilBarColor, boxShadow: `0 0 8px ${hexToRgba(utilBarColor, 0.6)}`, transition: 'width 0.3s' }} />
          </div>
          <span style={statSubLabel}>{utilLabel} utilization</span>
        </StatBlock>

        <StatBlock label="CPS Limit">
          <span style={statBigValue}>{trunk.cps_limit != null ? trunk.cps_limit : '--'}</span>
          <span style={statSubLabel}>calls/second</span>
        </StatBlock>

        <StatBlock label="Last Hour">
          <span style={statBigValue}>
            {expanded && !stats ? '…' : lastHour?.total_calls != null ? lastHour.total_calls.toLocaleString() : '--'}
          </span>
          <span style={statSubLabel}>{lastHour?.asr ? `ASR ${lastHour.asr}` : 'calls'}</span>
        </StatBlock>

        <StatBlock label="Avg Duration" last>
          <span style={statBigValue}>
            {expanded && !stats ? '…' : lastHour?.avg_duration_sec != null ? `${lastHour.avg_duration_sec.toFixed(1)}s` : '--'}
          </span>
          <span style={statSubLabel}>per call</span>
        </StatBlock>
      </div>

      {/* Expand toggle */}
      <button
        type="button"
        onClick={toggleExpanded}
        onMouseEnter={() => setToggleHover(true)}
        onMouseLeave={() => setToggleHover(false)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          padding: '11px 20px',
          fontSize: '0.74rem',
          fontWeight: 600,
          color: toggleHover ? GLASS.text : GLASS.textMuted,
          borderTop: '1px solid rgba(255,255,255,0.07)',
          background: toggleHover ? 'rgba(255,255,255,0.03)' : 'transparent',
          cursor: 'pointer',
          fontFamily: 'inherit',
          transition: 'background 0.15s, color 0.15s',
        }}
      >
        <span aria-hidden="true">{expanded ? '▴' : '▾'}</span>
        {expanded ? 'Less details' : 'More details — IPs, DIDs, capacity'}
      </button>

      {/* Expandable body */}
      {expanded && (
        <ExpandedSection
          trunkId={trunk.id}
          maxChannels={maxChannels}
          packageName={trunk.package_name ?? null}
          ips={ipsQuery.data ?? null}
          dids={didsQuery.data ?? null}
          ipsLoading={ipsQuery.isLoading}
          didsLoading={didsQuery.isLoading}
        />
      )}
    </GlassCard>
  );
}

const statBigValue: React.CSSProperties = {
  fontSize: '1.3rem',
  fontWeight: 700,
  color: GLASS.text,
  fontVariantNumeric: 'tabular-nums',
  lineHeight: 1,
};

const statSubLabel: React.CSSProperties = {
  fontSize: '0.68rem',
  color: GLASS.textMuted,
  marginTop: 4,
  lineHeight: 1,
};

function StatBlock({ label, children, last }: { label: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: 'rgba(255,255,255,0.02)',
        padding: '12px 16px',
        borderRight: last ? 'none' : '1px solid rgba(255,255,255,0.05)',
      }}
    >
      <span style={{ fontSize: '0.66rem', fontWeight: 700, color: GLASS.textMuted, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
        {label}
      </span>
      {children}
    </div>
  );
}

interface ExpandedSectionProps {
  trunkId: number;
  maxChannels: number;
  packageName: string | null;
  ips: TrunkIp[] | null;
  dids: TrunkDid[] | null;
  ipsLoading: boolean;
  didsLoading: boolean;
}

function ExpandedSection({ trunkId, maxChannels, packageName, ips, dids, ipsLoading, didsLoading }: ExpandedSectionProps) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [newIp, setNewIp] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const addIpMutation = useMutation({
    mutationFn: () => addTrunkIp(trunkId, newIp.trim(), newDesc.trim() || undefined),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['trunk-ips', trunkId] });
      void qc.invalidateQueries({ queryKey: ['trunks'] });
      setNewIp('');
      setNewDesc('');
      toastOk('Authorized IP added');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const deleteIpMutation = useMutation({
    mutationFn: (ipId: number) => deleteTrunkIp(trunkId, ipId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['trunk-ips', trunkId] });
      void qc.invalidateQueries({ queryKey: ['trunks'] });
      toastOk('IP removed');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleAddIp(e: React.FormEvent) {
    e.preventDefault();
    if (!newIp.trim()) { toastErr('IP address is required'); return; }
    addIpMutation.mutate();
  }

  function handleDeleteIp(ip: TrunkIp) {
    if (!confirm(`Remove ${ip.ip_address} from authorized IPs?`)) return;
    deleteIpMutation.mutate(ip.id);
  }

  return (
    <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 22, background: 'rgba(8,10,15,0.35)' }}>
      {/* Authorized Customer PBX IPs */}
      <section>
        <SectionLabel>
          Authorized PBX IPs{' '}
          <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 'normal', fontSize: '0.68rem', color: GLASS.textFaint }}>
            (customer IPs allowed to send calls)
          </span>
        </SectionLabel>

        {ipsLoading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: GLASS.textMuted, fontSize: '0.78rem' }}>
            <Spinner size="xs" /> Loading IPs…
          </div>
        )}

        {!ipsLoading && ips !== null && ips.length === 0 && (
          <p style={{ fontSize: '0.82rem', color: GLASS.textMuted }}>
            No authorized IPs — add the customer's PBX IP to enable trunk calls.
          </p>
        )}

        {!ipsLoading && ips !== null && ips.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
            {ips.map((ip) => (
              <IpChip key={ip.id} ip={ip} onDelete={() => handleDeleteIp(ip)} />
            ))}
          </div>
        )}

        {/* Add IP form */}
        <form onSubmit={handleAddIp} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 10 }}>
          <input
            type="text"
            value={newIp}
            onChange={(e) => setNewIp(e.target.value)}
            placeholder="203.0.113.50"
            style={expandInput(160)}
          />
          <input
            type="text"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Description (optional)"
            style={expandInput(180)}
          />
          <button
            type="submit"
            disabled={addIpMutation.isPending}
            style={{
              fontSize: '0.75rem',
              fontWeight: 700,
              padding: '6px 14px',
              borderRadius: 8,
              border: `1px solid ${hexToRgba(GLASS.accent, 0.3)}`,
              background: hexToRgba(GLASS.accent, 0.12),
              color: GLASS.accent,
              cursor: 'pointer',
              fontFamily: 'inherit',
              opacity: addIpMutation.isPending ? 0.5 : 1,
            }}
          >
            {addIpMutation.isPending ? 'Adding…' : 'Add IP'}
          </button>
        </form>
      </section>

      {/* Assigned DIDs */}
      <section>
        <SectionLabel>Assigned DIDs</SectionLabel>

        {didsLoading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: GLASS.textMuted, fontSize: '0.78rem' }}>
            <Spinner size="xs" /> Loading DIDs…
          </div>
        )}

        {!didsLoading && dids !== null && dids.length === 0 && (
          <p style={{ fontSize: '0.82rem', color: GLASS.textMuted }}>No DIDs assigned</p>
        )}

        {!didsLoading && dids !== null && dids.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {dids.map((d) => (
              <span
                key={d.id}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  fontSize: '0.75rem',
                  fontFamily: MONO,
                  fontWeight: 600,
                  background: 'rgba(255,255,255,0.04)',
                  color: GLASS.text,
                  border: '1px solid rgba(255,255,255,0.10)',
                  padding: '4px 10px',
                  borderRadius: 7,
                }}
              >
                {fmt(d.did)}
              </span>
            ))}
          </div>
        )}
      </section>

      {/* Call Path Package */}
      <section>
        <SectionLabel>Call Path Package</SectionLabel>
        <div style={{ fontSize: '0.88rem', color: GLASS.text, marginTop: 4 }}>
          <strong>{maxChannels}</strong> concurrent call path{maxChannels !== 1 ? 's' : ''}
          {packageName && <span style={{ marginLeft: 6, color: GLASS.textMuted, fontSize: '0.8rem' }}>({packageName})</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: '0.72rem', color: GLASS.textMuted }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 14, height: 14, borderRadius: '50%', border: `1px solid ${hexToRgba(GLASS.textMuted, 0.5)}`, fontSize: '0.55rem', fontWeight: 700, flexShrink: 0 }}>
            i
          </span>
          Contact support to upgrade your call path package
        </div>
      </section>
    </div>
  );
}

function expandInput(width: number): React.CSSProperties {
  return {
    fontSize: '0.8rem',
    fontFamily: MONO,
    padding: '6px 11px',
    borderRadius: 8,
    border: '1px solid rgba(255,255,255,0.10)',
    background: 'rgba(8,10,15,0.5)',
    color: GLASS.text,
    outline: 'none',
    width,
  };
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h4 style={{ fontSize: '0.7rem', fontWeight: 700, color: GLASS.textMuted, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8 }}>
      {children}
    </h4>
  );
}

function IpChip({ ip, onDelete }: { ip: TrunkIp; onDelete: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.10)',
        borderRadius: 8,
        padding: '6px 12px',
        fontSize: '0.78rem',
        fontFamily: MONO,
        color: GLASS.text,
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
    >
      <span>{ip.ip_address}</span>
      {ip.description && (
        <span style={{ color: GLASS.textMuted, fontFamily: 'sans-serif', fontSize: '0.72rem' }}>{ip.description}</span>
      )}
      <button
        type="button"
        onClick={onDelete}
        title="Remove this IP"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          background: 'none',
          border: 'none',
          color: hovered ? GLASS.danger : GLASS.textMuted,
          cursor: 'pointer',
          padding: '0 2px',
          fontSize: '1rem',
          lineHeight: 1,
          transition: 'color 0.15s',
          fontFamily: 'inherit',
        }}
      >
        &times;
      </button>
    </div>
  );
}
