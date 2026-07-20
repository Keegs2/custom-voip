/**
 * FilterBar — the search / state / status / environment filter strip rendered
 * inside a glass table panel. Stateless apart from the search field's focus
 * (visual only); every value + change handler is driven by props.
 */

import { useState } from 'react';
import { Search, X } from 'lucide-react';
import { GLASS } from '../../../../components/glass/glass';
import type { DidStatus, DidAllocatedEnv } from '../../../../types/didInventory';
import { US_STATES } from '../types';
import { filterBar, searchWrap, searchInput, clearBtn, selectStyle } from '../styles';

interface FilterBarProps {
  search: string;
  onSearchChange: (v: string) => void;
  statusFilter: DidStatus | '';
  onStatusChange: (v: DidStatus | '') => void;
  stateFilter: string;
  onStateChange: (v: string) => void;
  placeholder?: string;
  hideStatus?: boolean;
  // Optional environment filter (Inventory tab only — applied client-side).
  showEnv?: boolean;
  envFilter?: DidAllocatedEnv | '';
  onEnvChange?: (v: DidAllocatedEnv | '') => void;
}

export function FilterBar({
  search,
  onSearchChange,
  statusFilter,
  onStatusChange,
  stateFilter,
  onStateChange,
  placeholder = 'Search DID, city, rate center…',
  hideStatus = false,
  showEnv = false,
  envFilter = '',
  onEnvChange,
}: FilterBarProps) {
  const [focused, setFocused] = useState(false);

  return (
    <div style={filterBar}>
      {/* Search */}
      <div style={searchWrap(focused)}>
        <Search size={15} color={focused ? GLASS.accent : GLASS.textFaint} style={{ flexShrink: 0 }} />
        <input
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          style={searchInput}
        />
        {search && (
          <button type="button" onClick={() => onSearchChange('')} style={clearBtn()} aria-label="Clear search">
            <X size={13} />
          </button>
        )}
      </div>

      {/* State filter */}
      <select value={stateFilter} onChange={(e) => onStateChange(e.target.value)} style={selectStyle(Boolean(stateFilter))}>
        <option value="">All States</option>
        {US_STATES.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>

      {/* Status filter */}
      {!hideStatus && (
        <select
          value={statusFilter}
          onChange={(e) => onStatusChange(e.target.value as DidStatus | '')}
          style={selectStyle(Boolean(statusFilter))}
        >
          <option value="">All Statuses</option>
          <option value="available">Available</option>
          <option value="assigned">Assigned</option>
          <option value="reserved">Reserved</option>
          <option value="porting_in">Porting In</option>
          <option value="porting_out">Porting Out</option>
          <option value="suspended">Suspended</option>
        </select>
      )}

      {/* Environment filter (Inventory tab only) */}
      {showEnv && (
        <select
          value={envFilter}
          onChange={(e) => onEnvChange?.(e.target.value as DidAllocatedEnv | '')}
          style={selectStyle(Boolean(envFilter))}
        >
          <option value="">All Environments</option>
          <option value="prod">Production</option>
          <option value="sandbox">Sandbox</option>
          <option value="reserved">Reserved</option>
        </select>
      )}
    </div>
  );
}
