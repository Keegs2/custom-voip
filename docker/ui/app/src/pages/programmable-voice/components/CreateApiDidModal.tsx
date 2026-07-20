/**
 * CreateApiDidModal — admin-only "add programmable number" dialog. Uses the
 * shared Modal + FormField primitives; all state + the live POST come from
 * `useCreateApiDid`.
 */

import { Modal } from '../../../components/ui/Modal';
import { Button } from '../../../components/ui/Button';
import { FormField } from '../../../components/ui/FormField';
import { useCreateApiDid } from '../hooks';

interface CreateApiDidModalProps {
  open: boolean;
  onClose: () => void;
  customerId: number;
}

export function CreateApiDidModal({ open, onClose, customerId }: CreateApiDidModalProps) {
  const c = useCreateApiDid(customerId, onClose);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add Programmable Number"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={c.isPending} onClick={c.submit}>Add number</Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <FormField
          label="DID (E.164)"
          required
          value={c.did}
          onChange={(e) => c.setDid(e.target.value)}
          placeholder="+1XXXXXXXXXX"
          hint="The inbound number to make programmable."
        />
        <FormField
          label="Voice URL"
          required
          type="url"
          value={c.voiceUrl}
          onChange={(e) => c.setVoiceUrl(e.target.value)}
          placeholder="https://your-app.com/voice"
          hint="POSTed when a call arrives; respond with TwiML."
        />
        <FormField
          label="Status Callback URL"
          type="url"
          value={c.callback}
          onChange={(e) => c.setCallback(e.target.value)}
          placeholder="https://your-app.com/status"
          hint="Optional — receives call lifecycle events."
        />
      </div>
    </Modal>
  );
}
