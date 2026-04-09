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
}

interface AddCreditResponse {
  balance: number;
}

function DetailField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[0.62rem] font-bold text-[#4a5568] uppercase tracking-[0.8px]">
        {label}
      </div>
      <div className="text-sm text-[#e2e8f0] font-medium">{value}</div>
    </div>
  );
}

export function CustomerExpandedView({ customer, onEdit }: CustomerExpandedViewProps) {
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
      className="p-5"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Detail fields row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-4 mb-4">
        <DetailField
          label="Balance"
          value={
            <span className={customer.balance < 0 ? 'text-red-400' : undefined}>
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
            <span className={customer.fraud_score > 70 ? 'text-red-400' : undefined}>
              {customer.fraud_score ?? 0}
            </span>
          }
        />
        <DetailField label="Customer ID" value={`#${customer.id}`} />
      </div>

      {/* CPS Tier info */}
      {tierLoading && (
        <div className="flex items-center gap-1.5 text-[#718096] text-[0.8rem] mb-3">
          <Spinner size="xs" /> Loading tier…
        </div>
      )}
      {!tierLoading && tier && (
        <div className="text-[0.82rem] text-[#718096] mb-3">
          CPS Tier:{' '}
          <strong className="text-[#e2e8f0]">{tier.name}</strong>
          {' '}&mdash; {tier.cps_limit} CPS
        </div>
      )}

      {/* Actions bar */}
      <div className="flex items-center gap-3 flex-wrap mb-4 pt-2 border-t border-[#2a2f45]">
        <Button
          variant="primary"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
        >
          Edit
        </Button>

        {/* Add Credit */}
        <form
          onSubmit={handleAddCredit}
          onClick={(e) => e.stopPropagation()}
          className="flex items-center gap-2"
        >
          <input
            type="number"
            value={creditAmount}
            onChange={(e) => setCreditAmount(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            placeholder="Amount"
            step="0.01"
            min="0.01"
            className="text-[0.82rem] px-2 py-[5px] rounded-lg w-[110px] border border-[#2a2f45] bg-[#0d0f15] text-[#e2e8f0] outline-none focus:border-[#3b82f6] placeholder:text-[#718096]"
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
      </div>

      {/* Service sections — lazy loaded based on account type */}
      <div className="flex flex-col gap-0">
        {showRcf && <CustomerRcfSection customerId={customer.id} />}
        {showApi && <CustomerApiSection customerId={customer.id} />}
        {showTrunk && <CustomerTrunkSection customerId={customer.id} />}
      </div>
    </div>
  );
}
