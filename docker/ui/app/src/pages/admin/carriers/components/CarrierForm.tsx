/**
 * CarrierForm — the create / edit carrier form. All field state, validation and
 * the build-and-submit pipeline live in `useCarrierForm`; this component is
 * presentation + form wiring only. Used both in the "Add Carrier" modal and the
 * per-card inline editor.
 */

import { FormField } from '../../../../components/ui/FormField';
import { Button } from '../../../../components/ui/Button';
import type { Carrier, CarrierCreate, CarrierTransport, CarrierAuthType } from '../../../../types/carrier';
import { useCarrierForm } from '../hooks';
import { PRODUCT_TYPE_OPTIONS, TRANSPORTS, AUTH_TYPES } from '../types';
import { groupLabel, formError } from '../styles';
import { CheckPill } from './CheckPill';

interface CarrierFormProps {
  /** Carrier to pre-populate the form. Omit for "create" mode. */
  carrier?: Carrier;
  onSubmit: (values: CarrierCreate) => Promise<void>;
  onCancel: () => void;
  submitLabel?: string;
}

export function CarrierForm({ carrier, onSubmit, onCancel, submitLabel = 'Save' }: CarrierFormProps) {
  const { form, setField, toggleProductType, error, submitting, submit } = useCarrierForm(carrier, onSubmit);
  const showCredentials = form.authType === 'credentials';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {error && <p style={formError}>{error}</p>}

      {/* Core fields */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
        <FormField
          label="Display Name"
          required
          value={form.displayName}
          onChange={(e) => setField('displayName', e.target.value)}
          placeholder="Acme Carrier"
        />
        <FormField
          label="Description"
          value={form.description}
          onChange={(e) => setField('description', e.target.value)}
          placeholder="Optional"
        />
        <FormField
          label="SIP Proxy Hostname / IP"
          required
          value={form.sipProxy}
          onChange={(e) => setField('sipProxy', e.target.value)}
          placeholder="sip.carrier.com"
        />
        <FormField
          label="Port"
          type="number"
          min="1"
          max="65535"
          value={form.port}
          onChange={(e) => setField('port', e.target.value)}
        />
        <FormField
          as="select"
          label="Transport"
          value={form.transport}
          onChange={(e) => setField('transport', e.target.value as CarrierTransport)}
        >
          {TRANSPORTS.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </FormField>
        <FormField
          as="select"
          label="Auth Type"
          value={form.authType}
          onChange={(e) => setField('authType', e.target.value as CarrierAuthType)}
        >
          {AUTH_TYPES.map((a) => (
            <option key={a.value} value={a.value}>{a.label}</option>
          ))}
        </FormField>

        {showCredentials && (
          <>
            <FormField
              label="Username"
              value={form.username}
              onChange={(e) => setField('username', e.target.value)}
              placeholder="sip-user"
            />
            <FormField
              label="Password"
              type="password"
              value={form.password}
              onChange={(e) => setField('password', e.target.value)}
              placeholder={carrier ? 'leave blank to keep unchanged' : ''}
            />
          </>
        )}

        <FormField
          label="Codec Preferences"
          value={form.codecPrefs}
          onChange={(e) => setField('codecPrefs', e.target.value)}
          placeholder="PCMU,PCMA"
          hint="Comma-separated codec list"
        />
        <FormField
          label="Max Channels"
          type="number"
          min="1"
          value={form.maxChannels}
          onChange={(e) => setField('maxChannels', e.target.value)}
          placeholder="unlimited"
        />
        <FormField
          label="CPS Limit"
          type="number"
          min="1"
          value={form.cpsLimit}
          onChange={(e) => setField('cpsLimit', e.target.value)}
          placeholder="unlimited"
        />
      </div>

      {/* Product types */}
      <div>
        <div style={groupLabel()}>Product Types</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {PRODUCT_TYPE_OPTIONS.map((pt) => (
            <CheckPill
              key={pt}
              label={pt.toUpperCase()}
              checked={form.productTypes.includes(pt)}
              onChange={() => toggleProductType(pt)}
            />
          ))}
        </div>
      </div>

      {/* Roles & options */}
      <div>
        <div style={groupLabel()}>Role &amp; Options</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          <CheckPill label="Primary" checked={form.isPrimary} onChange={() => setField('isPrimary', !form.isPrimary)} />
          <CheckPill label="Failover" checked={form.isFailover} onChange={() => setField('isFailover', !form.isFailover)} />
          <CheckPill label="Register" checked={form.register} onChange={() => setField('register', !form.register)} />
          <CheckPill label="Caller ID in From" checked={form.callerIdInFrom} onChange={() => setField('callerIdInFrom', !form.callerIdInFrom)} />
          <CheckPill label="Enabled" checked={form.enabled} onChange={() => setField('enabled', !form.enabled)} />
        </div>
      </div>

      {/* Footer actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 2 }}>
        <Button onClick={submit} loading={submitting}>
          {submitLabel}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
