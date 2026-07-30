import { useQuery } from '@tanstack/react-query';
import { getCustomerTier } from '../../api/tiers';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { CustomerRcfSection } from './CustomerRcfSection';
import { CustomerApiSection } from './CustomerApiSection';
import { CustomerTrunkSection } from './CustomerTrunkSection';
import type { Customer } from '../../types/customer';

interface CustomerExpandedViewProps {
  customer: Customer;
  onEdit: () => void;
  onDelete: () => void;
}

// NOTE: The customer "bank account" (balance / credit limit / add-credit) has
// been removed platform-wide — the platform does not invoice; CDRs are rated
// externally (Equinox). This orphaned view keeps only the operational fields.

function DetailField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '14px 16px',
        background: 'rgba(59,130,246,0.03)',
        border: '1px solid rgba(59,130,246,0.10)',
        borderRadius: 10,
      }}
    >
      <div
        style={{
          fontSize: '0.6rem',
          fontWeight: 700,
          color: '#4a5568',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: '0.9rem', color: '#e2e8f0', fontWeight: 600 }}>{value}</div>
    </div>
  );
}

export function CustomerExpandedView({ customer, onEdit, onDelete }: CustomerExpandedViewProps) {
  const { data: tierData, isLoading: tierLoading } = useQuery({
    queryKey: ['customerTier', customer.id],
    queryFn: () => getCustomerTier(customer.id),
  });

  const showRcf = customer.account_type === 'rcf' || customer.account_type === 'hybrid';
  const showApi = customer.account_type === 'api' || customer.account_type === 'hybrid';
  const showTrunk = customer.account_type === 'trunk' || customer.account_type === 'hybrid';

  const tier = tierData?.tier;

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ padding: '24px 28px 28px' }}
    >
      {/* Detail fields grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
          gap: 10,
          marginBottom: 20,
        }}
      >
        <DetailField
          label="Daily Limit"
          value={customer.daily_limit != null ? `$${customer.daily_limit.toFixed(2)}` : '--'}
        />
        <DetailField
          label="CPM Limit"
          value={customer.cpm_limit != null ? String(customer.cpm_limit) : '--'}
        />
        <DetailField
          label="Fraud Score"
          value={
            <span style={{ color: customer.fraud_score > 70 ? '#f87171' : '#e2e8f0' }}>
              {customer.fraud_score ?? 0}
            </span>
          }
        />
        <DetailField label="Customer ID" value={`#${customer.id}`} />
      </div>

      {/* CPS Tier */}
      {tierLoading && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            color: '#718096',
            fontSize: '0.8rem',
            marginBottom: 16,
          }}
        >
          <Spinner size="xs" /> Loading tier…
        </div>
      )}
      {!tierLoading && tier && (
        <div
          style={{
            fontSize: '0.82rem',
            color: '#718096',
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span
            style={{
              fontSize: '0.6rem',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: '#4a5568',
            }}
          >
            CPS Tier:
          </span>
          <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{tier.name}</span>
          <span style={{ color: '#4a5568' }}>—</span>
          <span style={{ color: '#718096' }}>{tier.cps_limit} CPS</span>
        </div>
      )}

      {/* Actions bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          paddingTop: 16,
          paddingBottom: 20,
          borderTop: '1px solid rgba(59,130,246,0.12)',
          borderBottom: '1px solid rgba(59,130,246,0.12)',
          marginBottom: 24,
        }}
      >
        <Button
          variant="primary"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
        >
          Edit Customer
        </Button>

        {/* Delete — pushed to right */}
        <div style={{ marginLeft: 'auto' }}>
          <Button
            variant="danger"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            Delete Customer
          </Button>
        </div>
      </div>

      {/* Service sections — lazy loaded based on account type */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {showRcf && <CustomerRcfSection customerId={customer.id} />}
        {showApi && <CustomerApiSection customerId={customer.id} />}
        {showTrunk && <CustomerTrunkSection customerId={customer.id} />}
      </div>
    </div>
  );
}
