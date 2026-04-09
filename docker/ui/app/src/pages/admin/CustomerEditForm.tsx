import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { updateCustomer } from '../../api/customers';
import { listTiers, getCustomerTier, assignCustomerTier } from '../../api/tiers';
import { Button } from '../../components/ui/Button';
import { FormField } from '../../components/ui/FormField';
import { useToast } from '../../components/ui/ToastContext';
import type { Customer, CustomerStatus, TrafficGrade } from '../../types/customer';

interface CustomerEditFormProps {
  customer: Customer;
  onCancel: () => void;
  onSaved: () => void;
}

export function CustomerEditForm({ customer, onCancel, onSaved }: CustomerEditFormProps) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const [name, setName] = useState(customer.name);
  const [status, setStatus] = useState<CustomerStatus>(customer.status);
  const [grade, setGrade] = useState<TrafficGrade>(customer.traffic_grade);
  const [creditLimit, setCreditLimit] = useState(String(customer.credit_limit ?? 0));
  const [dailyLimit, setDailyLimit] = useState(String(customer.daily_limit ?? 0));
  const [cpmLimit, setCpmLimit] = useState(String(customer.cpm_limit ?? 0));
  const [selectedTierId, setSelectedTierId] = useState<string>('__unchanged__');

  const showApiTier = customer.account_type === 'api' || customer.account_type === 'hybrid';

  // Fetch all tiers to populate the API tier dropdown
  const { data: tiersData } = useQuery({
    queryKey: ['tiers'],
    queryFn: listTiers,
    enabled: showApiTier,
  });

  // Fetch current assigned tier so we can pre-select it
  const { data: currentTierData } = useQuery({
    queryKey: ['customerTier', customer.id],
    queryFn: () => getCustomerTier(customer.id),
    enabled: showApiTier,
  });

  const apiTiers = (Array.isArray(tiersData) ? tiersData : []).filter(
    (t) => t.tier_type === 'api' || t.tier_type === 'all',
  );

  const updateMutation = useMutation({
    mutationFn: () =>
      updateCustomer(customer.id, {
        name: name.trim(),
        status,
        traffic_grade: grade,
        credit_limit: parseFloat(creditLimit) || 0,
        daily_limit: parseFloat(dailyLimit) || 0,
        cpm_limit: parseInt(cpmLimit, 10) || 0,
      }),
    onSuccess: async () => {
      // Optionally update tier if changed
      if (showApiTier && selectedTierId !== '__unchanged__') {
        try {
          const tierId = parseInt(selectedTierId, 10);
          await assignCustomerTier(customer.id, tierId);
          await qc.invalidateQueries({ queryKey: ['customerTier', customer.id] });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          toastErr(`Customer saved but tier update failed: ${msg}`);
        }
      }
      await qc.invalidateQueries({ queryKey: ['customers'] });
      toastOk('Customer updated');
      onSaved();
    },
    onError: (err: Error) => {
      toastErr(err.message);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!name.trim()) {
      toastErr('Name is required');
      return;
    }
    updateMutation.mutate();
  }

  return (
    <form
      onSubmit={handleSubmit}
      onClick={(e) => e.stopPropagation()}
      className="p-4"
    >
      <div className="text-[0.63rem] font-bold text-[#718096] uppercase tracking-[0.9px] mb-3">
        General
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <FormField
          label="Name"
          value={name}
          onChange={(e) => setName((e.target as HTMLInputElement).value)}
          required
        />
        <FormField
          label="Status"
          as="select"
          value={status}
          onChange={(e) => setStatus((e.target as HTMLSelectElement).value as CustomerStatus)}
        >
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="closed">Closed</option>
        </FormField>
        <FormField
          label="Traffic Grade"
          as="select"
          value={grade}
          onChange={(e) => setGrade((e.target as HTMLSelectElement).value as TrafficGrade)}
        >
          <option value="standard">Standard</option>
          <option value="premium">Premium</option>
          <option value="economy">Economy</option>
        </FormField>
        <FormField
          label="Credit Limit ($)"
          type="number"
          min="0"
          step="0.01"
          value={creditLimit}
          onChange={(e) => setCreditLimit((e.target as HTMLInputElement).value)}
        />
        <FormField
          label="Daily Limit ($)"
          type="number"
          min="0"
          step="0.01"
          value={dailyLimit}
          onChange={(e) => setDailyLimit((e.target as HTMLInputElement).value)}
        />
        <FormField
          label="CPM Limit"
          type="number"
          min="0"
          value={cpmLimit}
          onChange={(e) => setCpmLimit((e.target as HTMLInputElement).value)}
        />
      </div>

      {/* API Tier section */}
      {showApiTier && (
        <div className="mt-4 pt-4 border-t border-[#2a2f45]">
          <div className="text-[0.63rem] font-bold text-[#718096] uppercase tracking-[0.9px] mb-3">
            CPS Tier
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField
              label="API Tier"
              as="select"
              value={selectedTierId}
              onChange={(e) =>
                setSelectedTierId((e.target as HTMLSelectElement).value)
              }
            >
              <option value="__unchanged__">
                Keep current
                {currentTierData?.tier ? ` (${currentTierData.tier.name})` : ''}
              </option>
              {apiTiers.map((t) => (
                <option key={t.id} value={String(t.id)}>
                  {t.name} — {t.cps_limit} CPS
                </option>
              ))}
            </FormField>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 mt-4 pt-3 border-t border-[#2a2f45]">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={updateMutation.isPending}
        >
          Save Changes
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onCancel();
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
