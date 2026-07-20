/**
 * AiAgentsAdminPage — the routed AI Voice Agents admin page
 * (`/admin/platform/ai-agents`, inside the Platform Management shell).
 *
 * THIN page: composition + top-level state only. All data fetching, mutations,
 * the form pipeline, and the compliance logic live in `./ai-agents/hooks`;
 * presentation lives in `./ai-agents/components`; styles in `./ai-agents/styles`.
 *
 * The flagship differentiator — the honest in-boundary compliance badge — is
 * authoritative per row (resolved from `/runtime-config`) and proven in the
 * Runtime drawer. See docs/FRONTEND_GLASS_REFACTOR.md.
 *
 * React #310: every hook sits unconditionally at the top, before any return.
 */

import { useMemo, useState } from 'react';
import { Bot } from 'lucide-react';
import { GLASS } from '../../components/glass/glass';
import type { AiAgent } from '../../types/aiAgent';
import { useAgents, useCustomerOptions, useDeleteAgent, useToggleAgent } from './ai-agents/hooks';
import { AiAgentsControlsBar } from './ai-agents/components/AiAgentsControlsBar';
import { AgentsTable } from './ai-agents/components/AgentsTable';
import { AgentsSkeleton, StateCard } from './ai-agents/components/states';
import { CreateAgentModal, EditAgentModal } from './ai-agents/components/AgentFormModals';
import { AgentRuntimeModal } from './ai-agents/components/AgentRuntimeModal';

export function AiAgentsAdminPage() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const [customerFilter, setCustomerFilter] = useState<number | undefined>(undefined);
  const [showCreate, setShowCreate] = useState(false);
  const [editAgent, setEditAgent] = useState<AiAgent | null>(null);
  const [runtimeAgent, setRuntimeAgent] = useState<AiAgent | null>(null);

  const customers = useCustomerOptions();
  const { agents, isLoading, isError } = useAgents(customerFilter);
  const del = useDeleteAgent();
  const toggle = useToggleAgent();

  const customerNames = useMemo<Record<number, string>>(() => {
    const map: Record<number, string> = {};
    for (const c of customers) map[c.id] = c.name;
    return map;
  }, [customers]);

  const handleDelete = (agent: AiAgent) => {
    if (window.confirm(`Delete AI agent "${agent.name}"? This cannot be undone.`)) del.mutate(agent.id);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <AiAgentsControlsBar
        count={isLoading ? null : agents.length}
        customers={customers}
        customerId={customerFilter}
        onCustomerChange={setCustomerFilter}
        onNew={() => setShowCreate(true)}
      />

      {isLoading ? (
        <AgentsSkeleton />
      ) : isError ? (
        <StateCard
          accent={GLASS.danger}
          icon={<Bot size={26} />}
          title="Couldn't load AI agents"
          body="The request failed. Check your connection and try again."
        />
      ) : agents.length === 0 ? (
        <StateCard
          icon={<Bot size={26} />}
          title="No AI voice agents yet"
          body="Create your first in-boundary AI agent — keep speech, reasoning and voice entirely inside your VPC."
        />
      ) : (
        <AgentsTable
          agents={agents}
          customerNames={customerNames}
          onEdit={setEditAgent}
          onRuntime={setRuntimeAgent}
          onDelete={handleDelete}
          onToggle={(agent) => toggle.mutate({ id: agent.id, enabled: !agent.enabled })}
        />
      )}

      <CreateAgentModal open={showCreate} customers={customers} onClose={() => setShowCreate(false)} />
      {editAgent && <EditAgentModal agent={editAgent} customers={customers} onClose={() => setEditAgent(null)} />}
      <AgentRuntimeModal agent={runtimeAgent} open={runtimeAgent !== null} onClose={() => setRuntimeAgent(null)} />
    </div>
  );
}
