/**
 * CustomerEditForm — inline edit panel body for the admin Customer 360
 * (rendered by CustomerAccountPage inside a dl-panel titled "Edit Customer").
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` in index.css, plus the
 * admin-area `dlx-*` primitives in styles/dl-admin.css). Presentation only —
 * the update payload, the optional tier-assignment follow-up (api/hybrid),
 * validation, and every toast are byte-identical to the previous version.
 *
 * React #310: every hook is called unconditionally at the top.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { updateCustomer } from '../../api/customers';
import { listTiers, getCustomerTier, assignCustomerTier } from '../../api/tiers';
import { useToast } from '../../components/ui/ToastContext';
import type { Customer, CustomerStatus, TrafficGrade } from '../../types/customer';
import '../../styles/dl-admin.css';

interface CustomerEditFormProps {
  customer: Customer;
  onCancel: () => void;
  onSaved: () => void;
}

/** Vertical label + dl-input field group. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <span className="dl-flabel">{label}</span>
      {children}
    </div>
  );
}

export function CustomerEditForm({ customer, onCancel, onSaved }: CustomerEditFormProps) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const [name, setName] = useState(customer.name);
  const [status, setStatus] = useState<CustomerStatus>(customer.status);
  const [grade, setGrade] = useState<TrafficGrade>(customer.traffic_grade);
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
    <form onSubmit={handleSubmit} onClick={(e) => e.stopPropagation()} className="dl-panel-body">
      {/* General section */}
      <h4 className="dl-section-title">General</h4>
      <div className="dlx-form-grid">
        <Field label="Name">
          <input
            className="dl-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </Field>
        <Field label="Status">
          <select
            className="dl-input"
            value={status}
            onChange={(e) => setStatus(e.target.value as CustomerStatus)}
          >
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="closed">Closed</option>
          </select>
        </Field>
        <Field label="Traffic Grade">
          <select
            className="dl-input"
            value={grade}
            onChange={(e) => setGrade(e.target.value as TrafficGrade)}
          >
            <option value="standard">Standard</option>
            <option value="premium">Premium</option>
            <option value="economy">Economy</option>
          </select>
        </Field>
        <Field label="Daily Limit ($)">
          <input
            className="dl-input"
            type="number"
            min="0"
            step="0.01"
            value={dailyLimit}
            onChange={(e) => setDailyLimit(e.target.value)}
          />
        </Field>
        <Field label="CPM Limit">
          <input
            className="dl-input"
            type="number"
            min="0"
            value={cpmLimit}
            onChange={(e) => setCpmLimit(e.target.value)}
          />
        </Field>
      </div>

      {/* API Tier section */}
      {showApiTier && (
        <div style={{ marginTop: 24, paddingTop: 24, borderTop: '1px solid var(--rcf-line)' }}>
          <h4 className="dl-section-title">CPS Tier</h4>
          <div style={{ maxWidth: 380 }}>
            <Field label="API Tier">
              <select
                className="dl-input"
                value={selectedTierId}
                onChange={(e) => setSelectedTierId(e.target.value)}
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
              </select>
            </Field>
          </div>
        </div>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginTop: 24,
          paddingTop: 20,
          borderTop: '1px solid var(--rcf-line)',
        }}
      >
        <button type="submit" className="dl-btn dl-btn-primary" disabled={updateMutation.isPending}>
          {updateMutation.isPending ? 'Saving…' : 'Save Changes'}
        </button>
        <button
          type="button"
          className="dl-btn dl-btn-ghost"
          onClick={(e) => {
            e.stopPropagation();
            onCancel();
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
