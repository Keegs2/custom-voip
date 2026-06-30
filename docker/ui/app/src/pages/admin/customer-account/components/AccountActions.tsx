/**
 * AccountActions — the bottom action bar: edit, UCaaS/Voicemail add-on toggles,
 * add-credit form, and delete. All mutations come from `useAccountActions`; this
 * file owns only the small UI state (input focus, toggle hover).
 */

import { useState } from 'react';
import type { UseMutationResult } from '@tanstack/react-query';
import { Button } from '../../../../components/ui/Button';
import type { Customer } from '../../../../types/customer';
import { useAccountActions } from '../hooks';
import { SectionPanel } from './SectionPanel';
import { creditInput, toggleBtn, toggleKnob, toggleTrack } from '../styles';
import { GLASS } from '../../../../components/glass/glass';

interface AddonToggleProps {
  enabled: boolean;
  accent: string;
  label: string;
  mutation: UseMutationResult<Customer, Error, boolean, unknown>;
}

function AddonToggle({ enabled, accent, label, mutation }: AddonToggleProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate(!enabled)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={toggleBtn(enabled, accent, mutation.isPending, hovered)}
    >
      <span style={toggleTrack(enabled, accent)}>
        <span style={toggleKnob(enabled)} />
      </span>
      {label} {enabled ? 'Enabled' : 'Disabled'}
    </button>
  );
}

interface AccountActionsProps {
  customer: Customer;
  onEdit: () => void;
  onDelete: () => void;
}

export function AccountActions({ customer, onEdit, onDelete }: AccountActionsProps) {
  const { creditAmount, setCreditAmount, submitCredit, addCreditMutation, ucaasMutation, voicemailMutation } =
    useAccountActions(customer);
  const [creditFocused, setCreditFocused] = useState(false);

  const showUcaasToggle =
    customer.account_type === 'api' ||
    customer.account_type === 'trunk' ||
    customer.account_type === 'hybrid';

  return (
    <SectionPanel label="Account Actions" accent={GLASS.accent}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <Button variant="primary" size="sm" onClick={onEdit}>
          Edit Customer
        </Button>

        {showUcaasToggle && (
          <AddonToggle enabled={!!customer.ucaas_enabled} accent="#0ea5e9" label="UCaaS" mutation={ucaasMutation} />
        )}

        <AddonToggle
          enabled={!!customer.voicemail_enabled}
          accent="#818cf8"
          label="Voicemail"
          mutation={voicemailMutation}
        />

        <form onSubmit={submitCredit} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="number"
            value={creditAmount}
            onChange={(e) => setCreditAmount(e.target.value)}
            onFocus={() => setCreditFocused(true)}
            onBlur={() => setCreditFocused(false)}
            placeholder="Amount ($)"
            step="0.01"
            min="0.01"
            style={creditInput(creditFocused)}
          />
          <Button type="submit" variant="success" size="sm" loading={addCreditMutation.isPending}>
            Add Credit
          </Button>
        </form>

        <div style={{ marginLeft: 'auto' }}>
          <Button variant="danger" size="sm" onClick={onDelete}>
            Delete Customer
          </Button>
        </div>
      </div>
    </SectionPanel>
  );
}
