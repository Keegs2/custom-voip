/**
 * CreateTrunkModal — admin-only "Create SIP Trunk" dialog. Form state + the
 * create mutation live in useCreateTrunk; this is the presentational shell.
 */

import { Modal } from '../../../components/ui/Modal';
import { Button } from '../../../components/ui/Button';
import { FormField } from '../../../components/ui/FormField';
import type { TrunkAuthType } from '../../../types/trunk';
import { useCreateTrunk } from '../hooks';

interface CreateTrunkModalProps {
  open: boolean;
  onClose: () => void;
  customerId: number;
}

export function CreateTrunkModal({ open, onClose, customerId }: CreateTrunkModalProps) {
  const f = useCreateTrunk(customerId, onClose);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create SIP Trunk"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={f.pending} onClick={f.handleSubmit}>Create trunk</Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-x-4 gap-y-5">
        <FormField
          label="Trunk name"
          required
          fullWidth
          value={f.name}
          onChange={(e) => f.setName(e.target.value)}
          placeholder="acme-primary"
          hint="A friendly identifier — letters, numbers and dashes."
        />
        <FormField as="select" label="Auth type" value={f.authType} onChange={(e) => f.setAuthType(e.target.value as TrunkAuthType)}>
          <option value="ip">IP authentication</option>
          <option value="credentials">Credentials</option>
          <option value="both">Both</option>
        </FormField>
        <FormField
          label="Max channels"
          type="number"
          min={1}
          value={f.maxChannels}
          onChange={(e) => f.setMaxChannels(e.target.value)}
        />
        <FormField
          label="CPS limit"
          type="number"
          min={1}
          fullWidth
          value={f.cps}
          onChange={(e) => f.setCps(e.target.value)}
          hint="Maximum new calls per second accepted on this trunk."
        />
      </div>
    </Modal>
  );
}
