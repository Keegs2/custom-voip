import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../api/client';
import { getCustomerTier } from '../../api/tiers';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/ToastContext';
import { CustomerRcfSection } from './CustomerRcfSection';
import { CustomerApiSection } from './CustomerApiSection';
import { CustomerTrunkSection } from './CustomerTrunkSection';
import type { Customer } from '../../types/customer';

interface CustomerExpandedViewProps {
  customer: Customer;
  onEdit: () => void;
  onDelete: () => void;
}

interface AddCreditResponse {
  balance: number;
}

function DetailField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '14px 16px',
        background: 'rgba(255,255,255,0.025)',
        border: '1px solid rgba(42,47,69,0.5)',
        borderRadius: 10,
      }}
    >
      <div
        style={{
          fontSize: '0.6rem',
          fontWeight: 700,
          color: '#4a5568',
          textTransform: 'uppercase',
          letterSpacing: '0.09em',
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: '0.9rem', color: '#e2e8f0', fontWeight: 600 }}>{value}</div>
    </div>
  );
}

export function CustomerExpandedView({ customer, onEdit, onDelete }: CustomerExpandedViewProps) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [creditAmount, setCreditAmount] = useState('');

  const { data: tierData, isLoading: tierLoading } = useQuery({
    queryKey: ['customerTier', customer.id],
    queryFn: () => getCustomerTier(customer.id),
  });

  const addCreditMutation = useMutation({
    mutationFn: (amount: number) =>
      apiRequest<AddCreditResponse>(
        'POST',
        `/customers/${customer.id}/credit?amount=${amount}`,
      ),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      toastOk(`Added $${parseFloat(creditAmount).toFixed(2)} credit. New balance: $${data.balance.toFixed(2)}`);
      setCreditAmount('');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleAddCredit(e: React.FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    const amount = parseFloat(creditAmount);
    if (!amount || amount <= 0) {
      toastErr('Enter a valid amount');
      return;
    }
    addCreditMutation.mutate(amount);
  }

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
          label="Balance"
          value={
            <span style={{ color: customer.balance < 0 ? '#f87171' : '#4ade80' }}>
              ${customer.balance.toFixed(2)}
            </span>
          }
        />
        <DetailField label="Credit Limit" value={`$${customer.credit_limit.toFixed(2)}`} />
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
              letterSpacing: '0.09em',
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
          borderTop: '1px solid rgba(42,47,69,0.5)',
          borderBottom: '1px solid rgba(42,47,69,0.5)',
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

        {/* Add Credit */}
        <form
          onSubmit={handleAddCredit}
          onClick={(e) => e.stopPropagation()}
          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <input
            type="number"
            value={creditAmount}
            onChange={(e) => setCreditAmount(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            placeholder="Amount"
            step="0.01"
            min="0.01"
            style={{
              fontSize: '0.82rem',
              padding: '7px 12px',
              borderRadius: 8,
              width: 120,
              border: '1px solid rgba(42,47,69,0.8)',
              background: 'rgba(13,15,21,0.9)',
              color: '#e2e8f0',
              outline: 'none',
              transition: 'border-color 0.15s, box-shadow 0.15s',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = '#22c55e';
              e.currentTarget.style.boxShadow = '0 0 0 3px rgba(34,197,94,0.12)';
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'rgba(42,47,69,0.8)';
              e.currentTarget.style.boxShadow = 'none';
            }}
          />
          <Button
            type="submit"
            variant="success"
            size="sm"
            loading={addCreditMutation.isPending}
            onClick={(e) => e.stopPropagation()}
          >
            Add Credit
          </Button>
        </form>

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
