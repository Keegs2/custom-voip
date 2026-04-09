import { useQuery } from '@tanstack/react-query';
import { Badge } from '../components/ui/Badge';
import { Spinner } from '../components/ui/Spinner';
import { listTrunks } from '../api/trunks';
import { TrunkCard } from './TrunkCard';

export function TrunksPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['trunks'],
    queryFn: () => listTrunks({ limit: 200 }),
  });

  const entries = data?.items ?? [];

  return (
    <div>
      {/* Portal header */}
      <div className="mb-7 pb-5 border-b border-[#2a2f45]">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-[1.45rem] font-bold tracking-[-0.3px] text-[#e2e8f0] leading-tight flex items-center gap-2">
            <span className="text-[#f59e0b] font-mono text-[1.3rem] leading-none" aria-hidden="true">
              =
            </span>
            Your SIP Trunks
          </h1>
          <Badge variant="trunk">Customer Portal</Badge>
        </div>
        <p className="text-[0.82rem] text-[#718096] mt-1">
          Monitor your trunk performance and capacity. Contact support to adjust channel limits or authorized IPs.
        </p>
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center gap-2 text-[#718096] text-sm py-8">
          <Spinner size="sm" />
          <span>Loading your SIP trunks…</span>
        </div>
      )}

      {/* Error state */}
      {isError && (
        <div className="py-8 text-[0.85rem] text-red-400">
          Unable to load SIP trunks. Please try refreshing the page.
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !isError && entries.length === 0 && (
        <div className="py-8 text-[0.85rem] text-[#718096]">
          No SIP trunks found for your account.
        </div>
      )}

      {/* Cards — single column on mobile, 2 columns on wider screens */}
      {entries.length > 0 && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {entries.map((trunk) => (
            <TrunkCard key={trunk.id} trunk={trunk} />
          ))}
        </div>
      )}
    </div>
  );
}
