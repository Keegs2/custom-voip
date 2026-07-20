/**
 * AiAgentsControlsBar — section header inside a glass panel: title + count on the
 * left, an optional customer filter + "New Agent" action on the right. Stateless
 * apart from button hover (visual only).
 */

import { useState } from 'react';
import { Plus, Bot } from 'lucide-react';
import { GlassPanel, GlassChip } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { sectionTitle, sectionSubtitle, primaryBtn, selectStyle } from '../styles';

interface CustomerOption {
  id: number;
  name: string;
  account_type: string;
}

interface AiAgentsControlsBarProps {
  count: number | null;
  customers: CustomerOption[];
  customerId: number | undefined;
  onCustomerChange: (id: number | undefined) => void;
  onNew: () => void;
}

export function AiAgentsControlsBar({ count, customers, customerId, onCustomerChange, onNew }: AiAgentsControlsBarProps) {
  const [addHover, setAddHover] = useState(false);

  return (
    <GlassPanel padding="20px 24px">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Bot size={18} style={{ color: GLASS.accent }} />
            <h2 style={sectionTitle}>AI Voice Agents</h2>
            {count !== null && <GlassChip label={`${count} agent${count === 1 ? '' : 's'}`} color={GLASS.accent} />}
          </div>
          <p style={sectionSubtitle}>In-boundary AI answering — speech, reasoning and voice you can keep entirely in your VPC.</p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <select
            value={customerId ?? ''}
            onChange={(e) => onCustomerChange(e.target.value ? Number(e.target.value) : undefined)}
            style={{ ...selectStyle(customerId !== undefined), minWidth: 190 }}
            aria-label="Filter agents by customer"
          >
            <option value="">All customers</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.account_type.toUpperCase()})
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onNew}
            onMouseEnter={() => setAddHover(true)}
            onMouseLeave={() => setAddHover(false)}
            style={primaryBtn(addHover)}
          >
            <Plus size={14} />
            New Agent
          </button>
        </div>
      </div>
    </GlassPanel>
  );
}
