/**
 * RcfControlsBar — the search / sort / view-toggle / count strip inside a glass
 * panel. Stateless apart from the search field's focus (purely visual), driven
 * entirely by props from the page.
 */

import { useState } from 'react';
import { GlassPanel, GlassChip } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import type { SortField, ViewMode } from '../types';
import { IconSearch, IconCards, IconTable } from './icons';
import {
  searchWrap,
  searchInput,
  selectStyle,
  viewToggleWrap,
  viewToggleBtn,
  spinner,
} from '../styles';

interface RcfControlsBarProps {
  search: string;
  onSearch: (v: string) => void;
  sort: SortField;
  onSort: (s: SortField) => void;
  view: ViewMode;
  onView: (v: ViewMode) => void;
  isAdmin: boolean;
  count: number;
  busy: boolean;
}

export function RcfControlsBar({ search, onSearch, sort, onSort, view, onView, isAdmin, count, busy }: RcfControlsBarProps) {
  // Local focus state for the search field — visual only.
  const [focused, setFocused] = useState(false);

  return (
    <GlassPanel padding="14px 16px" style={{ marginBottom: 22 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {/* Search */}
        <div style={searchWrap(focused)}>
          <IconSearch stroke={focused ? GLASS.accent : GLASS.textFaint} />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Search DID, destination, label…"
            style={searchInput}
          />
        </div>

        {/* Sort */}
        <select value={sort} onChange={(e) => onSort(e.target.value as SortField)} style={selectStyle}>
          <option value="did">Sort: DID</option>
          <option value="forward_to">Sort: Destination</option>
          <option value="name">Sort: Label</option>
          {isAdmin && <option value="customer">Sort: Customer</option>}
        </select>

        {/* View toggle */}
        <div style={viewToggleWrap}>
          <button type="button" onClick={() => onView('cards')} title="Cards" style={viewToggleBtn(view === 'cards')}>
            <IconCards />Cards
          </button>
          <button type="button" onClick={() => onView('table')} title="Table" style={viewToggleBtn(view === 'table')}>
            <IconTable />Table
          </button>
        </div>

        {/* Count + activity spinner */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {busy && <span style={spinner()} />}
          <GlassChip label={`${count} line${count === 1 ? '' : 's'}`} color={GLASS.accent} />
        </div>
      </div>
    </GlassPanel>
  );
}
