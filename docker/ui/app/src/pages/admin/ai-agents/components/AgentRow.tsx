/**
 * AgentRow — one agent in the table. Owns its own `useAgentRuntime` query so the
 * compliance badge is AUTHORITATIVE (resolved from the backend, not guessed) and
 * cached — opening the runtime drawer reuses the same cache entry. Also owns the
 * per-button hover state (visual). All hooks sit at the top (React #310).
 */

import { useState } from 'react';
import { Pencil, Trash2, Radio, Power } from 'lucide-react';
import { GLASS } from '../../../../components/glass/glass';
import { fmt } from '../../../../utils/format';
import type { AiAgent } from '../../../../types/aiAgent';
import { useAgentRuntime } from '../hooks';
import { td, agentName, rowActions, iconBtn } from '../styles';
import { ComplianceBadge, type ComplianceStatus } from './ComplianceBadge';
import { ProviderChips } from './ProviderChips';

interface AgentRowProps {
  agent: AiAgent;
  customerName: string | null;
  onEdit: () => void;
  onRuntime: () => void;
  onDelete: () => void;
  onToggle: () => void;
}

export function AgentRow({ agent, customerName, onEdit, onRuntime, onDelete, onToggle }: AgentRowProps) {
  const [hover, setHover] = useState<string | null>(null);
  const { data: runtime, isLoading, isError } = useAgentRuntime(agent.id);

  const status: ComplianceStatus = isLoading
    ? 'loading'
    : isError || !runtime
      ? 'unknown'
      : runtime.data_stays_in_vpc
        ? 'in-vpc'
        : 'cloud';

  return (
    <tr>
      <td style={td()}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={agentName}>{agent.name}</span>
          <span style={{ fontSize: '0.7rem', color: GLASS.textMuted }}>
            {customerName ?? `Customer #${agent.customer_id}`}
            {agent.fallback_destination ? ` · fallback ${fmt(agent.fallback_destination)}` : ''}
          </span>
        </div>
      </td>
      <td style={td()}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: '0.66rem',
            fontWeight: 800,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            color: agent.enabled ? GLASS.success : GLASS.textFaint,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: agent.enabled ? GLASS.success : GLASS.textFaint,
              boxShadow: agent.enabled ? `0 0 6px ${GLASS.success}` : 'none',
            }}
          />
          {agent.enabled ? 'Enabled' : 'Disabled'}
        </span>
      </td>
      <td style={td()}>
        <ProviderChips agent={agent} />
      </td>
      <td style={td()}>
        <ComplianceBadge status={status} />
      </td>
      <td style={td({ right: true })}>
        <div style={rowActions}>
          <button
            type="button"
            onClick={onToggle}
            onMouseEnter={() => setHover('toggle')}
            onMouseLeave={() => setHover(null)}
            style={iconBtn('muted', hover === 'toggle')}
            title={agent.enabled ? 'Disable agent' : 'Enable agent'}
          >
            <Power size={12} />
          </button>
          <button
            type="button"
            onClick={onRuntime}
            onMouseEnter={() => setHover('runtime')}
            onMouseLeave={() => setHover(null)}
            style={iconBtn('accent', hover === 'runtime')}
            title="Runtime & compliance"
          >
            <Radio size={12} />
            Runtime
          </button>
          <button
            type="button"
            onClick={onEdit}
            onMouseEnter={() => setHover('edit')}
            onMouseLeave={() => setHover(null)}
            style={iconBtn('accent', hover === 'edit')}
          >
            <Pencil size={12} />
            Edit
          </button>
          <button
            type="button"
            onClick={onDelete}
            onMouseEnter={() => setHover('delete')}
            onMouseLeave={() => setHover(null)}
            style={iconBtn('danger', hover === 'delete')}
            title="Delete agent"
          >
            <Trash2 size={12} />
          </button>
        </div>
      </td>
    </tr>
  );
}
