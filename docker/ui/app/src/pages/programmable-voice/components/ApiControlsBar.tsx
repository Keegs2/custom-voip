/**
 * ApiControlsBar — the search / add-number / count strip inside a glass panel.
 * Stateless apart from the search field's focus (purely visual).
 */

import { useState } from 'react';
import { Search } from 'lucide-react';
import { GlassPanel, GlassChip } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import { Button } from '../../../components/ui/Button';
import { searchWrap, searchInput } from '../styles';

interface ApiControlsBarProps {
  search: string;
  onSearch: (v: string) => void;
  isAdmin: boolean;
  onAdd: () => void;
  count: number;
}

export function ApiControlsBar({ search, onSearch, isAdmin, onAdd, count }: ApiControlsBarProps) {
  const [focused, setFocused] = useState(false);

  return (
    <GlassPanel padding="14px 16px" style={{ marginBottom: 22 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={searchWrap(focused)}>
          <Search size={15} style={{ color: focused ? GLASS.accent : GLASS.textFaint, flexShrink: 0, transition: 'color 0.18s' }} />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Filter by number, customer, or webhook URL…"
            style={searchInput}
          />
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <GlassChip label={`${count} number${count === 1 ? '' : 's'}`} color={GLASS.accent} />
          {isAdmin && (
            <Button variant="primary" onClick={onAdd}>+ Add number</Button>
          )}
        </div>
      </div>
    </GlassPanel>
  );
}
