import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '../components/ui/Badge';
import { Spinner } from '../components/ui/Spinner';
import { listRcf } from '../api/rcf';
import type { RcfEntry } from '../types/rcf';
import { RcfCard } from './RcfCard';
import { useAuth } from '../contexts/AuthContext';
import { IconRCF } from '../components/icons/ProductIcons';
import { AdminCustomerSelector } from '../components/AdminCustomerSelector';

export function RcfPage() {
  const { user, isAdmin } = useAuth();
  const [adminSelectedCustomer, setAdminSelectedCustomer] = useState<number | undefined>(undefined);

  // Non-admins: locked to their customer. Admins: use selector (undefined = all)
  const customerId = isAdmin ? adminSelectedCustomer : (user?.customer_id ?? undefined);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['rcf', customerId],
    queryFn: () => listRcf({ limit: 200, customer_id: customerId }),
  });

  const [pendingEdits, setPendingEdits] = useState<Record<string, string>>({});
  const entries: RcfEntry[] = useMemo(() => data?.items ?? [], [data]);

  function handlePendingChange(did: string, value: string) {
    setPendingEdits((prev) => ({ ...prev, [did]: value }));
  }

  function resolveValue(entry: RcfEntry): string {
    return pendingEdits[entry.did] !== undefined
      ? pendingEdits[entry.did]
      : entry.forward_to;
  }

  return (
    <div>
      <PortalHeader
        icon={<IconRCF size={24} />}
        title={user?.customer_name ? `${user.customer_name}'s Numbers` : 'RCF Numbers'}
        subtitle="Change where your calls forward to. Updates take effect within seconds."
        badgeVariant="rcf"
        userEmail={user?.email}
      />

      <AdminCustomerSelector
        selectedCustomerId={adminSelectedCustomer}
        onSelect={setAdminSelectedCustomer}
        accent="#22c55e"
      />

      {isLoading && (
        <div className="flex items-center gap-2.5 text-[#718096] text-sm py-12">
          <Spinner size="sm" />
          <span>Loading your numbers…</span>
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
          Unable to load RCF numbers. Please try refreshing the page.
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
            No RCF numbers found for your account.
          </p>
          <p style={{ color: '#4a5568', fontSize: '0.75rem' }}>
            Contact support to provision numbers.
          </p>
        </div>
      )}

      {entries.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
          {entries.map((entry) => (
            <RcfCard
              key={entry.id}
              entry={entry}
              pendingValue={resolveValue(entry)}
              onPendingChange={handlePendingChange}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface PortalHeaderProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  badgeVariant?: 'rcf' | 'api' | 'trunk';
  userEmail?: string | null;
}

const ACCENT_BY_VARIANT: Record<string, string> = {
  rcf: '#22c55e',
  api: '#a855f7',
  trunk: '#f59e0b',
};

export function PortalHeader({ icon, title, subtitle, badgeVariant = 'rcf', userEmail }: PortalHeaderProps) {
  const accent = ACCENT_BY_VARIANT[badgeVariant] ?? '#3b82f6';

  return (
    <div
      style={{
        marginBottom: 36,
        paddingTop: 8,
        paddingBottom: 28,
        borderBottom: '1px solid rgba(42,47,69,0.6)',
        textAlign: 'center',
      }}
    >
      {/* Icon badge — centered */}
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 14,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: `linear-gradient(135deg, ${accent}20 0%, ${accent}10 100%)`,
          border: `1px solid ${accent}30`,
          color: accent,
          marginBottom: 14,
        }}
        aria-hidden="true"
      >
        {icon}
      </div>

      {/* Title + badge */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 6 }}>
        <h1
          style={{
            fontSize: '1.5rem',
            fontWeight: 800,
            letterSpacing: '-0.02em',
            color: '#e2e8f0',
            lineHeight: 1.15,
            margin: 0,
          }}
        >
          {title}
        </h1>
        <Badge variant={badgeVariant}>Customer Portal</Badge>
      </div>

      {/* User email — personal context */}
      {userEmail && (
        <div
          style={{
            fontSize: '0.78rem',
            color: accent,
            fontWeight: 600,
            letterSpacing: '0.01em',
            marginBottom: 6,
          }}
        >
          {userEmail}
        </div>
      )}

      <p
        style={{
          fontSize: '0.85rem',
          color: '#718096',
          marginTop: 2,
          lineHeight: 1.6,
          maxWidth: 480,
          marginLeft: 'auto',
          marginRight: 'auto',
        }}
      >
        {subtitle}
      </p>
    </div>
  );
}
