/**
 * CustomersControlsBar — the search field + Search/New-Customer actions inside a
 * frosted glass panel. Stateless apart from the search field's focus (visual),
 * driven entirely by props from the page.
 */

import { useState } from 'react';
import { GlassPanel, GlassChip } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { Button } from '../../../../components/ui/Button';
import { IconSearch } from './icons';
import { searchWrap, searchInput } from '../styles';

interface CustomersControlsBarProps {
  search: string;
  onSearchChange: (v: string) => void;
  onSearchSubmit: (e: React.FormEvent) => void;
  showCreateForm: boolean;
  onToggleCreate: () => void;
  total: number;
  hasData: boolean;
}

export function CustomersControlsBar({
  search,
  onSearchChange,
  onSearchSubmit,
  showCreateForm,
  onToggleCreate,
  total,
  hasData,
}: CustomersControlsBarProps) {
  // Local focus state for the search field — visual only.
  const [focused, setFocused] = useState(false);

  return (
    <GlassPanel padding="14px 16px">
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <form onSubmit={onSearchSubmit} style={{ display: 'flex', alignItems: 'center', gap: 10, flex: '1 1 280px' }}>
          <div style={searchWrap(focused)}>
            <IconSearch stroke={focused ? GLASS.accent : GLASS.textFaint} />
            <input
              type="search"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder="Search customers…"
              style={searchInput}
            />
          </div>
          <Button type="submit" variant="ghost" size="sm" style={{ flexShrink: 0 }}>
            Search
          </Button>
        </form>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {hasData && (
            <GlassChip label={`${total} customer${total === 1 ? '' : 's'}`} color={GLASS.accent} />
          )}
          <Button variant="primary" size="sm" onClick={onToggleCreate} style={{ flexShrink: 0 }}>
            {showCreateForm ? 'Cancel' : '+ New Customer'}
          </Button>
        </div>
      </div>
    </GlassPanel>
  );
}
