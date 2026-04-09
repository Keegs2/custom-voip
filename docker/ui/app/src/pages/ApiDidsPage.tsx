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
        <div
          style={{
            padding: '12px 16px',
            borderRadius: 10,
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.2)',
            color: '#f87171',
            fontSize: '0.875rem',
            marginTop: 8,
          }}
        >
          Unable to load API DIDs. Please try refreshing the page.
        </div>
      )}

      {!isLoading && !isError && entries.length === 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '64px 16px',
            gap: 8,
            textAlign: 'center',
            background: 'linear-gradient(135deg, rgba(30,33,48,0.6) 0%, rgba(19,21,29,0.7) 100%)',
            border: '1px solid rgba(42,47,69,0.4)',
            borderRadius: 16,
          }}
        >
          <p style={{ color: '#718096', fontSize: '0.875rem', fontWeight: 500 }}>
            No API numbers found for your account.
          </p>
          <p style={{ color: '#4a5568', fontSize: '0.75rem' }}>
            Contact support to provision API-enabled numbers.
          </p>
        </div>
      )}

      {entries.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
          {entries.map((did) => (
            <ApiDidCard key={did.id} did={did} />
          ))}
        </div>
      )}
    </div>
  );
}
