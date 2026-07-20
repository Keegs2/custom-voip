/**
 * AgentsTable — frosted table of AI agents. Pure composition: maps agents to
 * AgentRow (each row owns its authoritative compliance query). Column layout +
 * the customer-name lookup are passed in from the page.
 */

import { GlassPanel } from '../../../../components/glass/GlassCard';
import type { AiAgent } from '../../../../types/aiAgent';
import { tableWrap, table, th } from '../styles';
import { AgentRow } from './AgentRow';

interface AgentsTableProps {
  agents: AiAgent[];
  customerNames: Record<number, string>;
  onEdit: (agent: AiAgent) => void;
  onRuntime: (agent: AiAgent) => void;
  onDelete: (agent: AiAgent) => void;
  onToggle: (agent: AiAgent) => void;
}

export function AgentsTable({ agents, customerNames, onEdit, onRuntime, onDelete, onToggle }: AgentsTableProps) {
  return (
    <GlassPanel padding={0}>
      <div style={tableWrap}>
        <table style={table}>
          <thead>
            <tr>
              <th style={th()}>Agent</th>
              <th style={th()}>Status</th>
              <th style={th()}>Providers</th>
              <th style={th()}>Compliance</th>
              <th style={th(true)}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                customerName={customerNames[agent.customer_id] ?? null}
                onEdit={() => onEdit(agent)}
                onRuntime={() => onRuntime(agent)}
                onDelete={() => onDelete(agent)}
                onToggle={() => onToggle(agent)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </GlassPanel>
  );
}
