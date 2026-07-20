/**
 * AssignModal — assigns an available DID to a customer + product type. Uses the
 * shared <Modal> chrome; all form state, the customer dropdown query, and the
 * live POST /assign mutation come from `useAssignForm`.
 *
 * React #310: the form hook is called unconditionally at the top, before the
 * `if (!did)` guard.
 */

import { Phone } from 'lucide-react';
import { Button } from '../../../../components/ui/Button';
import { Modal } from '../../../../components/ui/Modal';
import { FormField } from '../../../../components/ui/FormField';
import { GLASS } from '../../../../components/glass/glass';
import { fmt } from '../../../../utils/format';
import type { DidInventoryItem } from '../../../../types/didInventory';
import { PRODUCT_TYPES } from '../types';
import { useAssignForm } from '../hooks';
import { modalDidCard, modalDidNumber, modalDidMeta } from '../styles';

interface AssignModalProps {
  did: DidInventoryItem | null;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function AssignModal({ did, open, onClose, onSuccess }: AssignModalProps) {
  // ALL hooks first (React #310) — the guard comes after.
  const form = useAssignForm(did, open, () => {
    onSuccess();
    onClose();
  });

  if (!did) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Assign ${fmt(did.did)}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={form.isPending}
            disabled={!form.customerId || form.isPending}
            onClick={form.submit}
          >
            Assign Number
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* DID summary */}
        <div style={modalDidCard()}>
          <Phone size={15} color={GLASS.accent} />
          <div>
            <div style={modalDidNumber}>{fmt(did.did)}</div>
            {(did.city || did.state) && (
              <div style={modalDidMeta}>
                {[did.city, did.state].filter(Boolean).join(', ')}
                {did.rate_center && ` · ${did.rate_center}`}
              </div>
            )}
          </div>
        </div>

        {/* Customer selector */}
        <FormField
          as="select"
          label="Customer"
          required
          value={form.customerId}
          onChange={(e) => form.setCustomerId((e.target as HTMLSelectElement).value)}
          disabled={form.customersLoading}
        >
          <option value="">{form.customersLoading ? 'Loading customers…' : 'Select a customer'}</option>
          {form.customers.map((c) => (
            <option key={c.id} value={String(c.id)}>{c.name}</option>
          ))}
        </FormField>

        {/* Product type */}
        <FormField
          as="select"
          label="Product Type"
          required
          value={form.productType}
          onChange={(e) => form.setProductType((e.target as HTMLSelectElement).value)}
        >
          {PRODUCT_TYPES.map((pt) => (
            <option key={pt.value} value={pt.value}>{pt.label}</option>
          ))}
        </FormField>

        {/* Notes */}
        <FormField
          as="textarea"
          label="Notes (optional)"
          value={form.notes}
          onChange={(e) => form.setNotes((e.target as HTMLTextAreaElement).value)}
          placeholder="Internal note about this assignment…"
        />
      </div>
    </Modal>
  );
}
