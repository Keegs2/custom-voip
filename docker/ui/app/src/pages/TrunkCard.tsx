import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Trunk, TrunkIp, TrunkDid } from '../types/trunk';
import { getTrunkIps, getTrunkDids, getTrunkStats } from '../api/trunks';
import { Badge } from '../components/ui/Badge';
import { Spinner } from '../components/ui/Spinner';
import { fmt } from '../utils/format';
import { cn } from '../utils/cn';

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

export function TrunkCard({ trunk }: TrunkCardProps) {
  const [expanded, setExpanded] = useState(false);

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  // Stats — fetched lazily when the card first expands
  const statsQuery = useQuery<ExtendedTrunkStats>({
    queryKey: ['trunk-stats', trunk.id],
    queryFn: () => getTrunkStats(trunk.id) as Promise<ExtendedTrunkStats>,
    enabled: expanded,
    staleTime: 30_000,
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

  return (
    <div
      className={cn(
        'bg-[#1a1d27] border border-[#2a2f45] rounded-xl',
        'shadow-[0_1px_3px_rgba(0,0,0,.4)]',
        'transition-all duration-200 hover:border-[#363c57]',
        'overflow-hidden',
      )}
    >
      {/* Card header: trunk name + auth info + badge */}
      <div className="flex items-start justify-between gap-3 p-5 pb-4">
        <div className="min-w-0">
          <div className="text-[1.1rem] font-bold text-[#e2e8f0] leading-snug truncate">
            {trunk.trunk_name}
          </div>
          <div className="text-[0.72rem] text-[#718096] mt-0.5 font-mono">
            {trunk.customer_name && (
              <span className="mr-1.5">{trunk.customer_name}</span>
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
        <div className="flex-shrink-0 mt-0.5">
          <Badge variant={trunk.enabled ? 'active' : 'disabled'}>
            {trunk.enabled ? 'Active' : 'Disabled'}
          </Badge>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-[#2a2f45] border-t border-[#2a2f45]">
        {/* Channels */}
        <StatBlock label="Channels">
          <span className="text-[1.3rem] font-bold text-[#e2e8f0] tabular-nums leading-none">
            {currentChannels}
            <span className="text-[0.85rem] font-medium text-[#718096]">
              {' '}/ {maxChannels}
            </span>
          </span>
          {/* Utilization bar */}
          <div
            className="w-full h-1 rounded-full bg-[#2a2f45] mt-2 overflow-hidden"
            role="progressbar"
            aria-valuenow={utilPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Channel utilization: ${utilLabel}`}
          >
            <div
              className="h-full rounded-full transition-[width] duration-300"
              style={{ width: `${utilPct}%`, backgroundColor: utilBarColor }}
            />
          </div>
          <span className="text-[0.68rem] text-[#718096] mt-1 leading-none">
            {utilLabel} utilization
          </span>
        </StatBlock>

        {/* CPS Limit */}
        <StatBlock label="CPS Limit">
          <span className="text-[1.3rem] font-bold text-[#e2e8f0] tabular-nums leading-none">
            {trunk.cps_limit != null ? trunk.cps_limit : '--'}
          </span>
          <span className="text-[0.68rem] text-[#718096] mt-1 leading-none">
            calls/second
          </span>
        </StatBlock>

        {/* Last hour calls */}
        <StatBlock label="Last Hour">
          <span className="text-[1.3rem] font-bold text-[#e2e8f0] tabular-nums leading-none">
            {expanded && !stats
              ? '…'
              : lastHour?.total_calls != null
              ? lastHour.total_calls.toLocaleString()
              : '--'}
          </span>
          <span className="text-[0.68rem] text-[#718096] mt-1 leading-none">
            {lastHour?.asr ? `ASR ${lastHour.asr}` : 'calls'}
          </span>
        </StatBlock>

        {/* Avg duration */}
        <StatBlock label="Avg Duration">
          <span className="text-[1.3rem] font-bold text-[#e2e8f0] tabular-nums leading-none">
            {expanded && !stats
              ? '…'
              : lastHour?.avg_duration_sec != null
              ? `${lastHour.avg_duration_sec.toFixed(1)}s`
              : '--'}
          </span>
          <span className="text-[0.68rem] text-[#718096] mt-1 leading-none">
            per call
          </span>
        </StatBlock>
      </div>

      {/* Expand toggle */}
      <button
        type="button"
        onClick={toggleExpanded}
        className={cn(
          'w-full flex items-center justify-center gap-1.5',
          'py-2.5 px-5 text-[0.75rem] font-semibold text-[#718096]',
          'border-t border-[#2a2f45]',
          'hover:bg-white/[0.03] hover:text-[#e2e8f0]',
          'transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3b82f6]/50',
        )}
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
    <div className="flex flex-col gap-0 bg-[#1a1d27] px-4 py-3">
      <span className="text-[0.68rem] font-bold text-[#718096] uppercase tracking-[0.7px] mb-2">
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
  maxChannels,
  packageName,
  ips,
  dids,
  ipsLoading,
  didsLoading,
}: ExpandedSectionProps) {
  return (
    <div className="border-t border-[#2a2f45] px-5 py-4 flex flex-col gap-4">
      {/* Authorized IPs */}
      <section>
        <SectionLabel>
          Authorized IPs{' '}
          <span className="font-normal normal-case tracking-normal text-[0.68rem] text-[#718096]">
            (contact support to modify)
          </span>
        </SectionLabel>

        {ipsLoading && (
          <div className="flex items-center gap-2 text-[#718096] text-[0.78rem]">
            <Spinner size="xs" /> Loading IPs…
          </div>
        )}

        {!ipsLoading && ips !== null && ips.length === 0 && (
          <p className="text-[0.82rem] text-[#718096]">
            No authorized IPs configured — contact support to add IPs.
          </p>
        )}

        {!ipsLoading && ips !== null && ips.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-1">
            {ips.map((ip) => (
              <IpChip key={ip.id} ip={ip} />
            ))}
          </div>
        )}
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
          <p className="text-[0.82rem] text-[#718096]">No DIDs assigned</p>
        )}

        {!didsLoading && dids !== null && dids.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1">
            {dids.map((d) => (
              <span
                key={d.id}
                className={cn(
                  'inline-flex items-center',
                  'text-[0.75rem] font-mono font-semibold',
                  'bg-[#1e2130] text-[#e2e8f0] border border-[#2a2f45]',
                  'px-2.5 py-1 rounded-md',
                )}
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
        <div className="text-[0.88rem] text-[#e2e8f0] mt-1">
          <strong>{maxChannels}</strong> concurrent call path
          {maxChannels !== 1 ? 's' : ''}
          {packageName && (
            <span className="ml-1.5 text-[#718096] text-[0.8rem]">
              ({packageName})
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-1.5 text-[0.72rem] text-[#718096]">
          <span
            className={cn(
              'inline-flex items-center justify-center',
              'w-3.5 h-3.5 rounded-full border border-[#718096]/50',
              'text-[0.55rem] font-bold flex-shrink-0',
            )}
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
    <h4 className="text-[0.7rem] font-bold text-[#718096] uppercase tracking-[0.7px] mb-2">
      {children}
    </h4>
  );
}

interface IpChipProps {
  ip: TrunkIp;
}

function IpChip({ ip }: IpChipProps) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2',
        'bg-[#1e2130] border border-[#2a2f45] rounded-md',
        'px-3 py-1.5 text-[0.78rem] font-mono text-[#e2e8f0]',
      )}
    >
      <span>{ip.ip_address}</span>
      {ip.description && (
        <span className="text-[#718096] font-sans text-[0.72rem]">
          {ip.description}
        </span>
      )}
    </div>
  );
}
