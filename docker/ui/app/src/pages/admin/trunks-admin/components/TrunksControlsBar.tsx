/**
 * TrunksControlsBar — the search / count / "new trunk" strip inside a glass
 * panel. Stateless apart from the search field's focus + button hover (purely
 * visual); all behaviour is driven by props from the page.
 */

import { useState } from 'react';
import { GlassPanel, GlassChip } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { IconSearch, IconPlus } from './icons';
import { searchWrap, searchInput, primaryBtn, ghostBtn } from '../styles';

interface TrunksControlsBarProps {
  search: string;
  onSearchChange: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  count: number | null;
  showCreate: boolean;
  onToggleCreate: () => void;
}

export function TrunksControlsBar({ search, onSearchChange, onSubmit, count, showCreate, onToggleCreate }: TrunksControlsBarProps) {
  const [focused, setFocused] = useState(false);
  const [submitHover, setSubmitHover] = useState(false);
  const [newHover, setNewHover] = useState(false);

  return (
    <GlassPanel padding="14px 16px">
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <form onSubmit={onSubmit} style={{ display: 'flex', alignItems: 'center', gap: 10, flex: '1 1 280px', minWidth: 240 }}>
          <div style={searchWrap(focused)}>
            <IconSearch stroke={focused ? GLASS.accent : GLASS.textFaint} />
            <input
              type="search"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder="Search trunks…"
              style={searchInput}
            />
          </div>
          <button
            type="submit"
            onMouseEnter={() => setSubmitHover(true)}
            onMouseLeave={() => setSubmitHover(false)}
            style={ghostBtn(submitHover)}
          >
            Search
          </button>
        </form>

        {count !== null && (
          <GlassChip label={`${count} trunk${count === 1 ? '' : 's'}`} color={GLASS.accent} />
        )}

        <button
          type="button"
          onClick={onToggleCreate}
          onMouseEnter={() => setNewHover(true)}
          onMouseLeave={() => setNewHover(false)}
          style={showCreate ? ghostBtn(newHover) : primaryBtn(newHover)}
        >
          {showCreate ? 'Cancel' : (<><IconPlus />New Trunk</>)}
        </button>
      </div>
    </GlassPanel>
  );
}
