/**
 * CreateCustomerForm — the inline "new customer" form, frosted in glass. Pure
 * presentation: all form state + the create mutation live in the page's
 * `useCreateCustomer` hook and are passed in via props.
 *
 * Behaviour preserved 1:1 from the legacy page:
 *  - billing / rate-limit fields hidden for RCF accounts
 *  - UCaaS add-on toggle only for api / trunk / hybrid (resets when switching to
 *    an account type where it doesn't apply)
 *  - voicemail add-on toggle always available (account-type-orthogonal)
 */

import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { Button } from '../../../../components/ui/Button';
import { FormField } from '../../../../components/ui/FormField';
import type { AccountType, TrafficGrade } from '../../../../types/customer';
import type { CreateFormState } from '../types';
import { formEyebrow, toggleRow, toggleLabel, toggleHint, formActions } from '../styles';

const UCAAS_ACCENT = GLASS.accentSecondary; // cyan — softphone/chat/voicemail
const VOICEMAIL_ACCENT = '#818cf8'; // indigo — standalone visual voicemail

interface CreateCustomerFormProps {
  form: CreateFormState;
  isPending: boolean;
  updateField: <K extends keyof CreateFormState>(key: K, value: CreateFormState[K]) => void;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
}

export function CreateCustomerForm({ form, isPending, updateField, onSubmit, onCancel }: CreateCustomerFormProps) {
  const showUcaasToggle =
    form.account_type === 'api' || form.account_type === 'trunk' || form.account_type === 'hybrid';

  return (
    <GlassPanel padding="26px 28px 24px">
      <form onSubmit={onSubmit}>
        <div style={formEyebrow()}>New Customer</div>

        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <FormField
            label="Name"
            value={form.name}
            onChange={(e) => updateField('name', (e.target as HTMLInputElement).value)}
            placeholder="Acme Corp"
            required
          />
          <FormField
            label="Account Type"
            as="select"
            value={form.account_type}
            onChange={(e) => {
              const newType = (e.target as HTMLSelectElement).value as AccountType;
              updateField('account_type', newType);
              // Reset ucaas_enabled when switching to a type where it doesn't apply
              if (newType === 'rcf' || newType === 'ucaas') {
                updateField('ucaas_enabled', false);
              }
            }}
          >
            <option value="rcf">RCF</option>
            <option value="api">API</option>
            <option value="trunk">Trunk</option>
            <option value="hybrid">Hybrid</option>
            <option value="ucaas">UCaaS</option>
          </FormField>
          <FormField
            label="Traffic Grade"
            as="select"
            value={form.traffic_grade}
            onChange={(e) => updateField('traffic_grade', (e.target as HTMLSelectElement).value as TrafficGrade)}
          >
            <option value="standard">Standard</option>
            <option value="premium">Premium</option>
            <option value="economy">Economy</option>
          </FormField>

          {/* Billing / rate-limiting fields — hidden for RCF accounts */}
          {form.account_type !== 'rcf' && (
            <>
              <FormField
                label="Credit Limit ($)"
                type="number"
                min="0"
                step="0.01"
                value={form.credit_limit}
                onChange={(e) => updateField('credit_limit', (e.target as HTMLInputElement).value)}
              />
              <FormField
                label="Daily Limit ($)"
                type="number"
                min="0"
                step="0.01"
                value={form.daily_limit}
                onChange={(e) => updateField('daily_limit', (e.target as HTMLInputElement).value)}
              />
              <FormField
                label="CPM Limit"
                type="number"
                min="0"
                value={form.cpm_limit}
                onChange={(e) => updateField('cpm_limit', (e.target as HTMLInputElement).value)}
              />
            </>
          )}
        </div>

        {/* UCaaS add-on toggle — only relevant for api/trunk/hybrid */}
        {showUcaasToggle && (
          <div style={toggleRow(form.ucaas_enabled, UCAAS_ACCENT)} onClick={() => updateField('ucaas_enabled', !form.ucaas_enabled)}>
            <input
              id="create-ucaas-enabled"
              type="checkbox"
              checked={form.ucaas_enabled}
              onChange={(e) => updateField('ucaas_enabled', e.target.checked)}
              onClick={(e) => e.stopPropagation()}
              style={{ width: 15, height: 15, accentColor: UCAAS_ACCENT, cursor: 'pointer', flexShrink: 0 }}
            />
            <label htmlFor="create-ucaas-enabled" style={toggleLabel(form.ucaas_enabled, UCAAS_ACCENT)} onClick={(e) => e.stopPropagation()}>
              UCaaS Enabled
            </label>
            <span style={toggleHint}>Grants softphone, chat, and voicemail access</span>
          </div>
        )}

        {/* Voicemail add-on toggle — account-type-orthogonal, always available */}
        <div style={toggleRow(form.voicemail_enabled, VOICEMAIL_ACCENT)} onClick={() => updateField('voicemail_enabled', !form.voicemail_enabled)}>
          <input
            id="create-voicemail-enabled"
            type="checkbox"
            checked={form.voicemail_enabled}
            onChange={(e) => updateField('voicemail_enabled', e.target.checked)}
            onClick={(e) => e.stopPropagation()}
            style={{ width: 15, height: 15, accentColor: VOICEMAIL_ACCENT, cursor: 'pointer', flexShrink: 0 }}
          />
          <label htmlFor="create-voicemail-enabled" style={toggleLabel(form.voicemail_enabled, VOICEMAIL_ACCENT)} onClick={(e) => e.stopPropagation()}>
            Voicemail Enabled
          </label>
          <span style={toggleHint}>Grants standalone Visual Voicemail access</span>
        </div>

        <div style={formActions}>
          <Button type="submit" variant="primary" size="sm" loading={isPending}>
            Create Customer
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </GlassPanel>
  );
}
