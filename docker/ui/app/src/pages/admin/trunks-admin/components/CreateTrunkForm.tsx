/**
 * CreateTrunkForm — the inline "new SIP trunk" form, presented as a frosted
 * glass panel. Data + the create mutation live in `useCreateTrunk`; this
 * component is presentation + form wiring only.
 */

import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { Button } from '../../../../components/ui/Button';
import { FormField } from '../../../../components/ui/FormField';
import type { TrunkAuthType } from '../../../../types/trunk';
import { useCreateTrunk } from '../hooks';
import { sectionLabel, formAccentLine } from '../styles';

interface CreateTrunkFormProps {
  onClose: () => void;
}

export function CreateTrunkForm({ onClose }: CreateTrunkFormProps) {
  const { form, setForm, customers, isPending, submit, reset } = useCreateTrunk(onClose);

  return (
    <GlassPanel padding={0}>
      <form onSubmit={submit} style={{ position: 'relative', padding: '28px 28px 24px' }}>
        <div style={formAccentLine()} />

        <div style={sectionLabel()}>New SIP Trunk</div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 16 }}>
          <FormField
            label="Customer"
            as="select"
            value={form.customer_id}
            onChange={(e) => setForm((p) => ({ ...p, customer_id: (e.target as HTMLSelectElement).value }))}
            required
          >
            <option value="">Select customer…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </FormField>

          <FormField
            label="Trunk Name"
            value={form.trunk_name}
            onChange={(e) => setForm((p) => ({ ...p, trunk_name: (e.target as HTMLInputElement).value }))}
            placeholder="Acme Main Trunk"
            required
          />

          <FormField
            label="Auth Type"
            as="select"
            value={form.auth_type}
            onChange={(e) => setForm((p) => ({ ...p, auth_type: (e.target as HTMLSelectElement).value as TrunkAuthType }))}
          >
            <option value="ip">IP Authentication</option>
            <option value="credentials">Credentials</option>
            <option value="both">Both</option>
          </FormField>

          <FormField
            label="Max Channels"
            type="number"
            min="1"
            value={form.max_channels}
            onChange={(e) => setForm((p) => ({ ...p, max_channels: (e.target as HTMLInputElement).value }))}
          />

          <FormField
            label="CPS Limit"
            type="number"
            min="1"
            value={form.cps_limit}
            onChange={(e) => setForm((p) => ({ ...p, cps_limit: (e.target as HTMLInputElement).value }))}
          />
        </div>

        <div style={{ display: 'flex', gap: 8, paddingTop: 20, borderTop: `1px solid ${GLASS.textFaint}33` }}>
          <Button type="submit" variant="primary" size="sm" loading={isPending}>
            Create Trunk
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={reset}>
            Cancel
          </Button>
        </div>
      </form>
    </GlassPanel>
  );
}
