/**
 * EditFormPanel — the customer edit form on glass. The form itself (fields +
 * mutation) is reused as-is from CustomerEditForm; this wrapper supplies the
 * glass surface + eyebrow label and removes the form's own top padding so the
 * panel inset stays uniform.
 */

import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import type { Customer } from '../../../../types/customer';
import { CustomerEditForm } from '../../CustomerEditForm';
import { sectionLabel } from '../styles';

interface EditFormPanelProps {
  customer: Customer;
  onCancel: () => void;
  onSaved: () => void;
}

export function EditFormPanel({ customer, onCancel, onSaved }: EditFormPanelProps) {
  return (
    <GlassPanel accent={GLASS.accent} padding="26px 30px 8px">
      <div style={sectionLabel(GLASS.accent)}>Edit Customer</div>
      <CustomerEditForm customer={customer} onCancel={onCancel} onSaved={onSaved} />
    </GlassPanel>
  );
}
