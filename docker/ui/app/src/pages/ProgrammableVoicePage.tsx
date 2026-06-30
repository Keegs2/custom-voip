/**
 * ProgrammableVoicePage — THIN routed page (composition + top-level state only).
 *
 * Data fetching, mutations, and derived state live in ./programmable-voice/hooks;
 * styles in ./programmable-voice/styles; presentational pieces in
 * ./programmable-voice/components. Mirrors the RcfGlass reference architecture
 * (docs/FRONTEND_GLASS_REFACTOR.md).
 *
 * The ambient GlassBackground is mounted app-wide by AppLayout — this page just
 * builds glass surfaces on top. The layout owns the top offset, so this page
 * adds no top padding.
 *
 * React #310: every hook sits unconditionally at the top, before any return.
 */

import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { AdminCustomerSelector } from '../components/AdminCustomerSelector';
import { useToast } from '../components/ui/Toast';
import { GLASS } from '../components/glass/glass';
import { useApiDids } from './programmable-voice/hooks';
import { ProgrammableVoiceHero } from './programmable-voice/components/ProgrammableVoiceHero';
import { WebhookSecretPanel } from './programmable-voice/components/WebhookSecretPanel';
import { ApiControlsBar } from './programmable-voice/components/ApiControlsBar';
import { StatTiles } from './programmable-voice/components/StatTiles';
import { GlassApiDidCard } from './programmable-voice/components/GlassApiDidCard';
import { CreateApiDidModal } from './programmable-voice/components/CreateApiDidModal';
import { ApiEmptyState } from './programmable-voice/components/ApiEmptyState';
import { LoadingState, ErrorState, NoMatchState } from './programmable-voice/components/states';

const CARD_GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
  gap: 16,
};

export function ProgrammableVoicePage() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const { user, isAdmin } = useAuth();
  const { toastErr } = useToast();
  const [adminSelectedCustomer, setAdminSelectedCustomer] = useState<number | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const customerId = isAdmin ? adminSelectedCustomer : (user?.customer_id ?? undefined);
  const canManage = (user?.role ?? 'user') !== 'readonly';
  const adminCanCreate = isAdmin && customerId !== undefined;

  const { dids, filtered, activeCount, isLoading, isError, deletingId, removeDid } = useApiDids({ customerId, search });

  function handleCustomerSelect(id: number | undefined) {
    setAdminSelectedCustomer(id);
    setSearch('');
  }

  function handleAdd() {
    if (!adminCanCreate) { toastErr('Select a specific customer above to add a number'); return; }
    setCreateOpen(true);
  }

  return (
    <>
      <ProgrammableVoiceHero
        title={user?.customer_name ? `${user.customer_name}'s Programmable Voice` : 'Programmable Voice'}
      />

      {isAdmin && (
        <AdminCustomerSelector
          selectedCustomerId={adminSelectedCustomer}
          onSelect={handleCustomerSelect}
          accent={GLASS.accent}
          accountTypes={['api', 'hybrid']}
        />
      )}

      {/* Signing secret first — applies account-wide to all of this customer's numbers. */}
      <WebhookSecretPanel customerId={customerId} />

      {isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState />
      ) : dids.length === 0 ? (
        <ApiEmptyState isAdmin={isAdmin} canCreate={adminCanCreate} onCreate={() => setCreateOpen(true)} />
      ) : (
        <>
          <StatTiles total={dids.length} active={activeCount} disabled={dids.length - activeCount} />

          <ApiControlsBar
            search={search}
            onSearch={setSearch}
            isAdmin={isAdmin}
            onAdd={handleAdd}
            count={filtered.length}
          />

          {filtered.length === 0 ? (
            <NoMatchState search={search} />
          ) : (
            <div style={CARD_GRID}>
              {filtered.map((d, i) => (
                <GlassApiDidCard
                  key={d.id}
                  did={d}
                  isAdmin={isAdmin}
                  canManage={canManage}
                  showCustomer={isAdmin}
                  onDelete={removeDid}
                  deleting={deletingId === d.id}
                  index={i}
                />
              ))}
            </div>
          )}
        </>
      )}

      {adminCanCreate && customerId !== undefined && (
        <CreateApiDidModal open={createOpen} onClose={() => setCreateOpen(false)} customerId={customerId} />
      )}
    </>
  );
}
