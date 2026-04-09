import { useQuery } from '@tanstack/react-query';
import { Spinner } from '../components/ui/Spinner';
import { listApiDids } from '../api/apiDids';
import { ApiDidCard } from './ApiDidCard';
import { PortalHeader } from './RcfPage';

export function ApiDidsPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['api-dids'],
    queryFn: () => listApiDids({ limit: 200 }),
  });

  const entries = data?.items ?? [];

  return (
    <div>
      <PortalHeader
        icon="<>"
        title="Your API Numbers"
        subtitle="Configure webhook URLs for your voice applications."
        badgeVariant="api"
      />

      {isLoading && (
        <div className="flex items-center gap-2.5 text-[#718096] text-sm py-12">
          <Spinner size="sm" />
          <span>Loading your API numbers…</span>
        </div>
      )}

      {isError && (
        <div className="py-10 px-1 text-sm text-red-400">
          Unable to load API DIDs. Please try refreshing the page.
        </div>
      )}

      {!isLoading && !isError && entries.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-2 text-center">
          <p className="text-[#718096] text-sm">No API numbers found for your account.</p>
          <p className="text-[#4a5568] text-xs">Contact support to provision API-enabled numbers.</p>
        </div>
      )}

      {entries.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 md:gap-5">
          {entries.map((did) => (
            <ApiDidCard key={did.id} did={did} />
          ))}
        </div>
      )}
    </div>
  );
}
