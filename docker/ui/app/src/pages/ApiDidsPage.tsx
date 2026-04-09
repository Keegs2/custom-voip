import { useQuery } from '@tanstack/react-query';
import { Badge } from '../components/ui/Badge';
import { Spinner } from '../components/ui/Spinner';
import { listApiDids } from '../api/apiDids';
import { ApiDidCard } from './ApiDidCard';

export function ApiDidsPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['api-dids'],
    queryFn: () => listApiDids({ limit: 200 }),
  });

  const entries = data?.items ?? [];

  return (
    <div>
      {/* Portal header */}
      <div className="mb-7 pb-5 border-b border-[#2a2f45]">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-[1.45rem] font-bold tracking-[-0.3px] text-[#e2e8f0] leading-tight flex items-center gap-2">
            <span className="text-[#a855f7] font-mono text-[1.1rem]" aria-hidden="true">
              {'<>'}
            </span>
            Your API Numbers
          </h1>
          <Badge variant="api">Customer Portal</Badge>
        </div>
        <p className="text-[0.82rem] text-[#718096] mt-1">
          Configure webhook URLs for your voice applications.
        </p>
      </div>

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center gap-2 text-[#718096] text-sm py-8">
          <Spinner size="sm" />
          <span>Loading your API numbers…</span>
        </div>
      )}

      {/* Error state */}
      {isError && (
        <div className="py-8 text-[0.85rem] text-red-400">
          Unable to load API DIDs. Please try refreshing the page.
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !isError && entries.length === 0 && (
        <div className="py-8 text-[0.85rem] text-[#718096]">
          No API numbers found for your account.
        </div>
      )}

      {/* Cards grid */}
      {entries.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {entries.map((did) => (
            <ApiDidCard key={did.id} did={did} />
          ))}
        </div>
      )}
    </div>
  );
}
