import { useQuery } from '@tanstack/react-query';
import { Spinner } from '../components/ui/Spinner';
import { listTrunks } from '../api/trunks';
import { TrunkCard } from './TrunkCard';
import { PortalHeader } from './RcfPage';
import { useAuth } from '../contexts/AuthContext';

export function TrunksPage() {
  const { user } = useAuth();
  // For non-admin users, scope the query to their customer — admins see everything
  const customerId = user?.customer_id ?? undefined;

  const { data, isLoading, isError } = useQuery({
    queryKey: ['trunks', customerId],
    queryFn: () => listTrunks({ limit: 200, customer_id: customerId }),
  });

  const entries = data?.items ?? [];

  return (
    <div>
      <PortalHeader
        icon="="
        title="Your SIP Trunks"
        subtitle="Monitor your trunk performance and capacity. Contact support to adjust channel limits or authorized IPs."
        badgeVariant="trunk"
        userEmail={user?.email}
      />

      {isLoading && (
        <div className="flex items-center gap-2.5 text-[#718096] text-sm py-12">
          <Spinner size="sm" />
          <span>Loading your SIP trunks…</span>
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
          Unable to load SIP trunks. Please try refreshing the page.
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
            No SIP trunks found for your account.
          </p>
          <p style={{ color: '#4a5568', fontSize: '0.75rem' }}>
            Contact support to provision SIP trunks.
          </p>
        </div>
      )}

      {entries.length > 0 && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
          {entries.map((trunk) => (
            <TrunkCard key={trunk.id} trunk={trunk} />
          ))}
        </div>
      )}
    </div>
  );
}
