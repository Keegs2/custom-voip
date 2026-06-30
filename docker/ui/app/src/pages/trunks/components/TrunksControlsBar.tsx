/**
 * TrunksControlsBar — the search field + "New trunk" action + count chip inside
 * a glass panel. Stateless apart from the search field's focus (visual only).
 */

import { useState } from 'react';
import { GlassPanel, GlassChip } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import { Button } from '../../../components/ui/Button';
import { IconSearch } from './icons';
import { searchWrap, searchInput } from '../styles';

interface TrunksControlsBarProps {
  search: string;
  onSearch: (v: string) => void;
  isAdmin: boolean;
  count: number;
  onCreate: () => void;
}

export function TrunksControlsBar({ search, onSearch, isAdmin, count, onCreate }: TrunksControlsBarProps) {
  const [focused, setFocused] = useState(false);

  return (
    <GlassPanel padding="14px 16px">
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={searchWrap(focused)}>
          <IconSearch stroke={focused ? GLASS.accent : GLASS.textFaint} />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Filter by name, customer, or auth type…"
            style={searchInput}
          />
        </div>

        <GlassChip label={`${count} trunk${count === 1 ? '' : 's'}`} color={GLASS.accent} />

        {isAdmin && (
          <div style={{ marginLeft: 'auto' }}>
            <Button variant="primary" onClick={onCreate}>+ New trunk</Button>
          </div>
        )}
      </div>
    </GlassPanel>
  );
}
