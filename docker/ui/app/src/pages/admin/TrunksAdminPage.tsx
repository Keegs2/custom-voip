/**
 * TrunksAdminPage — full SIP-trunk CRUD across all customers (admin).
 *
 * This is the THIN page: composition + top-level state only. All data fetching,
 * mutations, and derived/editor logic live in `./trunks-admin/hooks.ts`; the
 * frosted-glass surfaces live in `./trunks-admin/components/*` and their styles
 * in `./trunks-admin/styles.ts`. See docs/FRONTEND_GLASS_REFACTOR.md.
 *
 * It renders inside the AdminPage tab shell (which owns the page header, tab bar
 * and top offset), so this page adds no hero and does not re-pad the top edge —
 * it just lays out its sections on the app-wide glass backdrop.
 *
 * React #310: every hook sits unconditionally at the top, before any return.
 */

import { useState } from 'react';
import { useTrunksAdmin } from './trunks-admin/hooks';
import { TrunksControlsBar } from './trunks-admin/components/TrunksControlsBar';
import { CreateTrunkForm } from './trunks-admin/components/CreateTrunkForm';
import { TrunksTable } from './trunks-admin/components/TrunksTable';
import { TrunksSkeleton, StateCard } from './trunks-admin/components/states';
import { IconError } from './trunks-admin/components/icons';
import { GLASS } from '../../components/glass/glass';

export function TrunksAdminPage() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [committedSearch, setCommittedSearch] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { trunks, data, isLoading, isError, toggleEnabled, remove } = useTrunksAdmin(
    committedSearch,
    () => setExpandedId(null),
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <TrunksControlsBar
        search={search}
        onSearchChange={setSearch}
        onSubmit={(e) => { e.preventDefault(); setCommittedSearch(search); }}
        count={data ? trunks.length : null}
        showCreate={showCreateForm}
        onToggleCreate={() => setShowCreateForm((v) => !v)}
      />

      {showCreateForm && <CreateTrunkForm onClose={() => setShowCreateForm(false)} />}

      {isLoading ? (
        <TrunksSkeleton />
      ) : isError ? (
        <StateCard
          icon={<IconError />}
          title="Couldn't load trunks"
          body="The request failed. Check your connection and try again."
          accent={GLASS.danger}
        />
      ) : (
        <TrunksTable
          trunks={trunks}
          expandedId={expandedId}
          onToggleExpand={(id) => setExpandedId((prev) => (prev === id ? null : id))}
          onToggleEnabled={toggleEnabled}
          onDelete={remove}
        />
      )}
    </div>
  );
}
