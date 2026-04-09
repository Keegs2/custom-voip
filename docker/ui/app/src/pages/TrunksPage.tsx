import { useQuery } from '@tanstack/react-query';
import { Spinner } from '../components/ui/Spinner';
import { listTrunks } from '../api/trunks';
import { TrunkCard } from './TrunkCard';
import { PortalHeader } from './RcfPage';

export function TrunksPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['trunks'],
    queryFn: () => listTrunks({ limit: 200 }),
  });

  const entries = data?.items ?? [];

  return (
    <div>
      <PortalHeader
        icon="="
        title="Your SIP Trunks"
        subtitle="Monitor your trunk performance and capacity. Contact support to adjust channel limits or authorized IPs."
        badgeVariant="trunk"
      />

      {isLoading && (
        <div className="flex items-center gap-2.5 text-[#718096] text-sm py-12">
          <Spinner size="sm" />
          <span>Loading your SIP trunks…</span>
        </div>
      )}

      {isError && (
        <div className="py-10 px-1 text-sm text-red-400">
          Unable to load SIP trunks. Please try refreshing the page.
        </div>
      )}

      {!isLoading && !isError && entries.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-2 text-center">
          <p className="text-[#718096] text-sm">No SIP trunks found for your account.</p>
          <p className="text-[#4a5568] text-xs">Contact support to provision SIP trunks.</p>
        </div>
      )}

      {entries.length > 0 && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 md:gap-5">
          {entries.map((trunk) => (
            <TrunkCard key={trunk.id} trunk={trunk} />
          ))}
        </div>
      )}
    </div>
  );
}
