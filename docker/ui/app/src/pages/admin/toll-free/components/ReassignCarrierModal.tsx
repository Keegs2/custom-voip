/**
 * ReassignCarrierModal — bulk per-TFN inbound carrier steering for the selected
 * numbers. Idempotent server-side (setting the same carrier is a no-op). Rendered
 * conditionally by the page, so state resets per open.
 */

import { useState } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { Modal } from '../../../../components/ui/Modal';
import { Button } from '../../../../components/ui/Button';
import { FormField } from '../../../../components/ui/FormField';
import { GLASS } from '../../../../components/glass/glass';
import type { Carrier } from '../../../../types/carrier';
import { useReassignCarrier } from '../hooks';
import { noteBox } from '../styles';

interface ReassignCarrierModalProps {
  selectedTfns: string[];
  carriers: Carrier[];
  onDone: () => void;
  onClose: () => void;
}

export function ReassignCarrierModal({ selectedTfns, carriers, onDone, onClose }: ReassignCarrierModalProps) {
  const [carrierId, setCarrierId] = useState('');
  const reassign = useReassignCarrier(() => {
    onDone();
    onClose();
  });

  const submit = () => {
    if (!carrierId) return;
    reassign.mutate({ tfns: selectedTfns, carrierId: Number(carrierId) });
  };

  return (
    <Modal open onClose={onClose} title="Reassign Inbound Carrier" maxWidth="max-w-lg">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={noteBox}>
          Steer <strong style={{ color: GLASS.text }}>{selectedTfns.length.toLocaleString()}</strong> selected toll-free number
          {selectedTfns.length === 1 ? '' : 's'} to a new inbound carrier. This only changes carrier steering, not ownership.
        </div>

        <FormField as="select" label="Target carrier" required value={carrierId} onChange={(e) => setCarrierId(e.target.value)}>
          <option value="">Select carrier…</option>
          {carriers.map((c) => (
            <option key={c.id} value={c.id}>{c.display_name || c.gateway_name}</option>
          ))}
        </FormField>

        <div style={{ display: 'flex', gap: 8 }}>
          <Button icon={<ArrowRightLeft size={14} />} onClick={submit} loading={reassign.isPending} disabled={!carrierId}>
            Reassign {selectedTfns.length.toLocaleString()}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={reassign.isPending}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}
