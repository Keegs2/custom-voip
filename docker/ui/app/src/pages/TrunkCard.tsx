import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Trunk, TrunkIp, TrunkDid } from '../types/trunk';
import { getTrunkIps, getTrunkDids, getTrunkStats, addTrunkIp, deleteTrunkIp, updateTrunk } from '../api/trunks';
import { Badge } from '../components/ui/Badge';
import { Spinner } from '../components/ui/Spinner';
import { useToast } from '../components/ui/ToastContext';
import { useAuth } from '../contexts/AuthContext';
import { fmt } from '../utils/format';

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
  fontWeight: 600,
  padding: '4px 10px',
  borderRadius: 4,
  border: 'none',
  background: '#22c55e',
  color: '#fff',
  cursor: 'pointer',
  flexShrink: 0,
  lineHeight: 1,
};

const inlineCancelBtn: React.CSSProperties = {
  fontSize: '0.65rem',
  fontWeight: 500,
  padding: '4px 8px',
  borderRadius: 4,
  border: 'none',
  background: 'transparent',
  color: '#718096',
  cursor: 'pointer',
  flexShrink: 0,
  lineHeight: 1,
};

// Inline-editable trunk name — looks like static text when unfocused
function TrunkNameField({
  trunk,
  canEdit,
}: {
  trunk: Trunk;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const { toastErr } = useToast();

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(trunk.trunk_name);

  // Sync when the trunk prop refreshes from the server (only when not actively editing)
  const [prevName, setPrevName] = useState(trunk.trunk_name);
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
    color: '#e2e8f0',
  };

  if (!canEdit) {
    return (
      <div
        style={{
          ...sharedStyle,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {trunk.trunk_name}
      </div>
    );
  }

  const [hovered, setHovered] = useState(false);

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
            background: 'rgba(19,21,29,0.8)',
            border: '1px solid rgba(245,158,11,0.5)',
            borderRadius: 6,
            outline: 'none',
            padding: '2px 8px',
            fontFamily: 'inherit',
            opacity: mutation.isPending ? 0.5 : 1,
            boxShadow: '0 0 0 3px rgba(245,158,11,0.12)',
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
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); handleCancel(); }}
          style={inlineCancelBtn}
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ position: 'relative' }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
        onClick={(e) => { e.stopPropagation(); setEditing(true); }}
        title="Click to rename this trunk"
      >
        <div
          style={{
            ...sharedStyle,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {trunk.trunk_name}
        </div>
        {/* Pencil icon — visible on hover */}
        {hovered && (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="#f59e0b"
            strokeWidth={1.5}
            style={{ width: 14, height: 14, opacity: 0.6, flexShrink: 0 }}
          >
            <path d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>
      {/* Hint text — shown on hover when not editing */}
      {hovered && (
        <div
          style={{
            fontSize: '0.6rem',
            color: '#f59e0b',
            opacity: 0.5,
            marginTop: 2,
            letterSpacing: '0.03em',
          }}
        >
          Click to rename
        </div>
      )}
    </div>
  );
}

export function TrunkCard({ trunk }: TrunkCardProps) {
  const [expanded, setExpanded] = useState(false);
  const { user } = useAuth();
  const canEdit = user?.role !== 'readonly';

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

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
  const utilPct =
    maxChannels > 0
      ? Math.min(100, Math.round((currentChannels / maxChannels) * 100))
      : 0;

  const utilLabel = stats?.channel_utilization ?? `${utilPct}%`;

  const utilBarColor =
    utilPct >= 80
      ? '#ef4444' // red — high
      : utilPct >= 50
      ? '#f59e0b' // amber — medium
      : '#22c55e'; // green — low

  const lastHour = stats?.last_hour;

  const accent = '#f59e0b';

  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 16,
        overflow: 'hidden',
        boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
        transition: 'border-color 0.3s, box-shadow 0.3s',
        position: 'relative',
      }}
    >
      {/* Top accent line */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 32,
          right: 32,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${accent}80, transparent)`,
          opacity: 0.35,
        }}
      />

      {/* Card header: trunk name + auth info + badge */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          padding: '24px 24px 16px',
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <TrunkNameField trunk={trunk} canEdit={canEdit} />
          <div
            style={{
              fontSize: '0.72rem',
              color: '#718096',
              marginTop: 3,
              fontFamily: 'monospace',
            }}
          >
            {trunk.customer_name && (
              <span style={{ marginRight: 6 }}>{trunk.customer_name}</span>
            )}
            {trunk.auth_type} auth
            {trunk.ip_count != null && (
              <span>
                {' '}
                &middot; {trunk.ip_count} IP
                {trunk.ip_count !== 1 ? 's' : ''}
              </span>
            )}
            {trunk.did_count != null && (
              <span>
                {' '}
                &middot; {trunk.did_count} DID
                {trunk.did_count !== 1 ? 's' : ''}
              </span>
            )}
          </div>
        </div>
        <div style={{ flexShrink: 0, marginTop: 2 }}>
          <Badge variant={trunk.enabled ? 'active' : 'disabled'}>
            {trunk.enabled ? 'Active' : 'Disabled'}
          </Badge>
        </div>
      </div>

      {/* Stats grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          borderTop: '1px solid rgba(42,47,69,0.6)',
        }}
      >
        {/* Channels */}
        <StatBlock label="Channels">
          <span
            style={{
              fontSize: '1.3rem',
              fontWeight: 700,
              color: '#e2e8f0',
              fontVariantNumeric: 'tabular-nums',
              lineHeight: 1,
            }}
          >
            {currentChannels}
            <span style={{ fontSize: '0.85rem', fontWeight: 500, color: '#718096' }}>
              {' '}/ {maxChannels}
            </span>
          </span>
          {/* Utilization bar */}
          <div
            style={{
              width: '100%',
              height: 4,
              borderRadius: 4,
              background: 'rgba(42,47,69,0.8)',
              marginTop: 8,
              overflow: 'hidden',
            }}
            role="progressbar"
            aria-valuenow={utilPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Channel utilization: ${utilLabel}`}
          >
            <div
              style={{
                height: '100%',
                width: `${utilPct}%`,
                borderRadius: 4,
                backgroundColor: utilBarColor,
                transition: 'width 0.3s',
              }}
            />
          </div>
          <span style={{ fontSize: '0.68rem', color: '#718096', marginTop: 4, lineHeight: 1 }}>
            {utilLabel} utilization
          </span>
        </StatBlock>

        {/* CPS Limit */}
        <StatBlock label="CPS Limit">
          <span
            style={{
              fontSize: '1.3rem',
              fontWeight: 700,
              color: '#e2e8f0',
              fontVariantNumeric: 'tabular-nums',
              lineHeight: 1,
            }}
          >
            {trunk.cps_limit != null ? trunk.cps_limit : '--'}
          </span>
          <span style={{ fontSize: '0.68rem', color: '#718096', marginTop: 4, lineHeight: 1 }}>
            calls/second
          </span>
        </StatBlock>

        {/* Last hour calls */}
        <StatBlock label="Last Hour">
          <span
            style={{
              fontSize: '1.3rem',
              fontWeight: 700,
              color: '#e2e8f0',
              fontVariantNumeric: 'tabular-nums',
              lineHeight: 1,
            }}
          >
            {expanded && !stats
              ? '…'
              : lastHour?.total_calls != null
              ? lastHour.total_calls.toLocaleString()
              : '--'}
          </span>
          <span style={{ fontSize: '0.68rem', color: '#718096', marginTop: 4, lineHeight: 1 }}>
            {lastHour?.asr ? `ASR ${lastHour.asr}` : 'calls'}
          </span>
        </StatBlock>

        {/* Avg duration */}
        <StatBlock label="Avg Duration">
          <span
            style={{
              fontSize: '1.3rem',
              fontWeight: 700,
              color: '#e2e8f0',
              fontVariantNumeric: 'tabular-nums',
              lineHeight: 1,
            }}
          >
            {expanded && !stats
              ? '…'
              : lastHour?.avg_duration_sec != null
              ? `${lastHour.avg_duration_sec.toFixed(1)}s`
              : '--'}
          </span>
          <span style={{ fontSize: '0.68rem', color: '#718096', marginTop: 4, lineHeight: 1 }}>
            per call
          </span>
        </StatBlock>
      </div>

      {/* Expand toggle */}
      <button
        type="button"
        onClick={toggleExpanded}
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
          transition: 'background 0.15s, color 0.15s',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.03)';
          (e.currentTarget as HTMLButtonElement).style.color = '#e2e8f0';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
          (e.currentTarget as HTMLButtonElement).style.color = '#718096';
        }}
      >
        {expanded ? (
          <>
            <span aria-hidden="true">&#x25B4;</span>
            Less details
          </>
        ) : (
          <>
            <span aria-hidden="true">&#x25BE;</span>
            More details — IPs, DIDs, capacity
          </>
        )}
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
    </div>
  );
}

interface StatBlockProps {
  label: string;
  children: React.ReactNode;
}

function StatBlock({ label, children }: StatBlockProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
        background: 'rgba(19,21,29,0.5)',
        padding: '12px 16px',
        borderRight: '1px solid rgba(42,47,69,0.4)',
      }}
    >
      <span
        style={{
          fontSize: '0.68rem',
          fontWeight: 700,
          color: '#718096',
          textTransform: 'uppercase',
          letterSpacing: '0.07em',
          marginBottom: 8,
        }}
      >
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

function ExpandedSection({
  trunkId,
  maxChannels,
  packageName,
  ips,
  dids,
  ipsLoading,
  didsLoading,
}: ExpandedSectionProps) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [newIp, setNewIp] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const addIpMutation = useMutation({
    mutationFn: () => addTrunkIp(trunkId, newIp.trim(), newDesc.trim() || undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trunk-ips', trunkId] });
      qc.invalidateQueries({ queryKey: ['trunks'] });
      setNewIp('');
      setNewDesc('');
      toastOk('Authorized IP added');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const deleteIpMutation = useMutation({
    mutationFn: (ipId: number) => deleteTrunkIp(trunkId, ipId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trunk-ips', trunkId] });
      qc.invalidateQueries({ queryKey: ['trunks'] });
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
    <div
      style={{
        borderTop: '1px solid rgba(42,47,69,0.6)',
        padding: '20px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        background: 'rgba(15,17,23,0.4)',
      }}
    >
      {/* Authorized Customer PBX IPs */}
      <section>
        <SectionLabel>
          Authorized PBX IPs{' '}
          <span
            style={{
              fontWeight: 400,
              textTransform: 'none',
              letterSpacing: 'normal',
              fontSize: '0.68rem',
              color: '#718096',
            }}
          >
            (customer IPs allowed to send calls)
          </span>
        </SectionLabel>

        {ipsLoading && (
          <div className="flex items-center gap-2 text-[#718096] text-[0.78rem]">
            <Spinner size="xs" /> Loading IPs…
          </div>
        )}

        {!ipsLoading && ips !== null && ips.length === 0 && (
          <p style={{ fontSize: '0.82rem', color: '#718096' }}>
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
        <form
          onSubmit={handleAddIp}
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            alignItems: 'center',
            marginTop: 10,
          }}
        >
          <input
            type="text"
            value={newIp}
            onChange={(e) => setNewIp(e.target.value)}
            placeholder="203.0.113.50"
            style={{
              fontSize: '0.8rem',
              fontFamily: 'monospace',
              padding: '5px 10px',
              borderRadius: 6,
              border: '1px solid rgba(42,47,69,0.6)',
              background: '#0d0f15',
              color: '#e2e8f0',
              outline: 'none',
              width: 160,
            }}
          />
          <input
            type="text"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Description (optional)"
            style={{
              fontSize: '0.8rem',
              padding: '5px 10px',
              borderRadius: 6,
              border: '1px solid rgba(42,47,69,0.6)',
              background: '#0d0f15',
              color: '#e2e8f0',
              outline: 'none',
              width: 180,
            }}
          />
          <button
            type="submit"
            disabled={addIpMutation.isPending}
            style={{
              fontSize: '0.75rem',
              fontWeight: 600,
              padding: '5px 14px',
              borderRadius: 6,
              border: '1px solid rgba(245,158,11,0.3)',
              background: 'rgba(245,158,11,0.1)',
              color: '#fbbf24',
              cursor: 'pointer',
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
          <div className="flex items-center gap-2 text-[#718096] text-[0.78rem]">
            <Spinner size="xs" /> Loading DIDs…
          </div>
        )}

        {!didsLoading && dids !== null && dids.length === 0 && (
          <p style={{ fontSize: '0.82rem', color: '#718096' }}>No DIDs assigned</p>
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
                  fontFamily: 'monospace',
                  fontWeight: 600,
                  background: 'rgba(30,33,48,0.8)',
                  color: '#e2e8f0',
                  border: '1px solid rgba(42,47,69,0.6)',
                  padding: '4px 10px',
                  borderRadius: 6,
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
        <div style={{ fontSize: '0.88rem', color: '#e2e8f0', marginTop: 4 }}>
          <strong>{maxChannels}</strong> concurrent call path
          {maxChannels !== 1 ? 's' : ''}
          {packageName && (
            <span style={{ marginLeft: 6, color: '#718096', fontSize: '0.8rem' }}>
              ({packageName})
            </span>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 8,
            fontSize: '0.72rem',
            color: '#718096',
          }}
        >
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
          Contact support to upgrade your call path package
        </div>
      </section>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h4
      style={{
        fontSize: '0.7rem',
        fontWeight: 700,
        color: '#718096',
        textTransform: 'uppercase',
        letterSpacing: '0.07em',
        marginBottom: 8,
      }}
    >
      {children}
    </h4>
  );
}

interface IpChipProps {
  ip: TrunkIp;
  onDelete: () => void;
}

function IpChip({ ip, onDelete }: IpChipProps) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        background: 'rgba(30,33,48,0.8)',
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 6,
        padding: '6px 12px',
        fontSize: '0.78rem',
        fontFamily: 'monospace',
        color: '#e2e8f0',
      }}
    >
      <span>{ip.ip_address}</span>
      {ip.description && (
        <span style={{ color: '#718096', fontFamily: 'sans-serif', fontSize: '0.72rem' }}>
          {ip.description}
        </span>
      )}
      <button
        type="button"
        onClick={onDelete}
        title="Remove this IP"
        style={{
          background: 'none',
          border: 'none',
          color: '#718096',
          cursor: 'pointer',
          padding: '0 2px',
          fontSize: '1rem',
          lineHeight: 1,
          transition: 'color 0.15s',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#f87171'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#718096'; }}
      >
        &times;
      </button>
    </div>
  );
}
