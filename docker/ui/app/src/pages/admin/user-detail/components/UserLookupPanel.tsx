/**
 * UserLookupPanel — the glass panel wrapping the all-users filter bar + table.
 * Owns only the (visual) search term; the user list comes from `useAllUsers`.
 * Optionally scopes to a single customer's users.
 *
 * React #310: the search-term state + the users query sit at the top, before any
 * conditional rendering.
 */

import { useState } from 'react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { useAllUsers } from '../hooks';
import { sectionHeader, sectionIcon, sectionTitle, searchWrap, searchInput } from '../styles';
import { AllUsersTable } from './AllUsersTable';
import { LoadingState, ErrorState } from './states';
import { IconSearch, IconUsers, IconX } from './icons';

interface UserLookupPanelProps {
  onSelectUser: (userId: number) => void;
  customerId?: number | null;
}

export function UserLookupPanel({ onSelectUser, customerId }: UserLookupPanelProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [focused, setFocused] = useState(false);
  const { data: allUsers, isLoading, isError, error } = useAllUsers();

  const users = customerId != null ? (allUsers ?? []).filter((u) => u.customer_id === customerId) : allUsers;

  return (
    <GlassPanel accent="#a855f7" padding="20px">
      {/* Header + search row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ ...sectionHeader, marginBottom: 0, flexShrink: 0 }}>
          <span style={sectionIcon('#a855f7')}><IconUsers /></span>
          <h3 style={sectionTitle}>All Users</h3>
        </div>

        <div style={searchWrap(focused)}>
          <span style={{ color: focused ? GLASS.accent : GLASS.textFaint, display: 'flex', alignItems: 'center', transition: 'color 0.18s' }}>
            <IconSearch />
          </span>
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Filter by name, email, role, customer, status…"
            style={searchInput}
          />
          {searchTerm.length > 0 && (
            <button
              type="button"
              onClick={() => setSearchTerm('')}
              title="Clear filter"
              style={{ background: 'transparent', border: 'none', color: GLASS.textFaint, cursor: 'pointer', padding: 3, borderRadius: 4, display: 'flex', alignItems: 'center' }}
              onMouseEnter={(e) => { e.currentTarget.style.color = GLASS.textMuted; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = GLASS.textFaint; }}
            >
              <IconX />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      {isLoading && <LoadingState label="Loading users…" inset />}
      {isError && <ErrorState title="Failed to load users" message={error instanceof Error ? error.message : 'Unknown error'} inset />}
      {!isLoading && !isError && users != null && (
        <AllUsersTable users={users} searchTerm={searchTerm} onSelectUser={onSelectUser} />
      )}
    </GlassPanel>
  );
}
