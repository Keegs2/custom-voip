/**
 * Create / edit modal wrappers around AgentForm. Each owns its own mutation hook
 * (useCreateAgent / useUpdateAgent) so the page stays thin. The form remounts per
 * agent (keyed) so its state always reflects the row being edited.
 */

import { Modal } from '../../../../components/ui/Modal';
import type { AiAgent, AiAgentCreate } from '../../../../types/aiAgent';
import { useCreateAgent, useUpdateAgent } from '../hooks';
import { AgentForm } from './AgentForm';

interface CustomerOption {
  id: number;
  name: string;
  account_type: string;
}

export function CreateAgentModal({
  open,
  customers,
  onClose,
}: {
  open: boolean;
  customers: CustomerOption[];
  onClose: () => void;
}) {
  const create = useCreateAgent(onClose);
  return (
    <Modal open={open} onClose={onClose} title="New AI Voice Agent" maxWidth="max-w-3xl">
      <AgentForm
        customers={customers}
        submitLabel="Create Agent"
        onCancel={onClose}
        onSubmit={async (values: AiAgentCreate) => {
          await create.mutateAsync(values);
        }}
      />
    </Modal>
  );
}

export function EditAgentModal({
  agent,
  customers,
  onClose,
}: {
  agent: AiAgent;
  customers: CustomerOption[];
  onClose: () => void;
}) {
  const update = useUpdateAgent(agent.id, onClose);
  return (
    <Modal open onClose={onClose} title={`Edit — ${agent.name}`} maxWidth="max-w-3xl">
      <AgentForm
        key={agent.id}
        agent={agent}
        customers={customers}
        submitLabel="Save Changes"
        onCancel={onClose}
        onSubmit={async (values: AiAgentCreate) => {
          // customer_id is fixed on edit — the server's AgentUpdate model ignores
          // it, so passing the full payload is safe and keeps this wrapper thin.
          await update.mutateAsync(values);
        }}
      />
    </Modal>
  );
}
