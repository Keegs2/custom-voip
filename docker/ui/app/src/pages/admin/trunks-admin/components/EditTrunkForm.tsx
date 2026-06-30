/**
 * EditTrunkForm — edit a trunk's name / channels / CPS / enabled flag. The
 * update mutation lives in `useEditTrunk`.
 */

import { GLASS } from '../../../../components/glass/glass';
import { Button } from '../../../../components/ui/Button';
import { FormField } from '../../../../components/ui/FormField';
import type { Trunk } from '../../../../types/trunk';
import { useEditTrunk } from '../hooks';
import { sectionLabel, toggleTrack, toggleKnob } from '../styles';

interface EditTrunkFormProps {
  trunk: Trunk;
  onSaved: () => void;
}

export function EditTrunkForm({ trunk, onSaved }: EditTrunkFormProps) {
  const { form, setForm, isPending, submit } = useEditTrunk(trunk, onSaved);

  return (
    <form onSubmit={submit}>
      <div style={sectionLabel()}>Edit Trunk Settings</div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 16 }}>
        <FormField
          label="Trunk Name"
          value={form.trunk_name}
          onChange={(e) => setForm((p) => ({ ...p, trunk_name: (e.target as HTMLInputElement).value }))}
          required
        />
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

      <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginBottom: 20, width: 'fit-content' }}>
        <div onClick={() => setForm((p) => ({ ...p, enabled: !p.enabled }))} style={toggleTrack(form.enabled)}>
          <div style={toggleKnob(form.enabled)} />
        </div>
        <span style={{ fontSize: '0.8rem', color: form.enabled ? GLASS.success : GLASS.textMuted, fontWeight: 600 }}>
          {form.enabled ? 'Enabled' : 'Disabled'}
        </span>
      </label>

      <Button type="submit" variant="primary" size="sm" loading={isPending}>
        Save Changes
      </Button>
    </form>
  );
}
