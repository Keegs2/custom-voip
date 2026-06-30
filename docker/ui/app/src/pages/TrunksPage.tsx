/**
 * TrunksPage — SIP Trunks (liquid-glass, app-blue theme).
 *
 * THIN page: composition + top-level state only. All data fetching, mutations,
 * derived state live in ./trunks/hooks; styles in ./trunks/styles; presentational
 * pieces in ./trunks/components. Mirror of the reference pages/rcf-glass/.
 *
 * The ambient GlassBackground is mounted app-wide by AppLayout — this page does
 * NOT mount its own; it just builds glass surfaces on top. Top/side page padding
 * is owned by AppLayout, so this page never re-pads the top edge.
 *
 * React #310: every hook sits unconditionally at the top, before any return.
 */

import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/ui/Toast';
import { AdminCustomerSelector } from '../components/AdminCustomerSelector';
import { GLASS } from '../components/glass/glass';
import { useTrunksData, useDeleteTrunk } from './trunks/hooks';
import { heroBadge, heroTitle, heroSubtitle } from './trunks/styles';
import { StatTile } from './trunks/components/StatTile';
import { TrunksControlsBar } from './trunks/components/TrunksControlsBar';
import { GlassTrunkCard } from './trunks/components/GlassTrunkCard';
import { CreateTrunkModal } from './trunks/components/CreateTrunkModal';
import { TrunksEmptyState } from './trunks/components/TrunksEmptyState';
import { SkeletonTrunkCard, StateCard, ErrorState } from './trunks/components/states';
import type { Trunk } from '../types/trunk';

const TILE_GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
  gap: 16,
};

const CARD_LIST: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

export function TrunksPage() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const { user, isAdmin } = useAuth();
  const { toastErr } = useToast();

  const [adminSelectedCustomer, setAdminSelectedCustomer] = useState<number | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const customerId = isAdmin ? adminSelectedCustomer : (user?.customer_id ?? undefined);
  const canManage = (user?.role ?? 'user') !== 'readonly';

  const { trunks, filtered, totals, isLoading, isError, refetch } = useTrunksData(customerId, search);
  const deleteMutation = useDeleteTrunk();

  // ── Derived (post-hook) ────────────────────────────────────────────────────
  const adminCanCreate = isAdmin && customerId !== undefined;

  function handleDelete(t: Trunk) {
    if (!confirm(`Delete trunk "${t.trunk_name}"? This permanently removes its IPs and DID routing. This cannot be undone.`)) return;
    deleteMutation.mutate(t);
  }

  function handleCreateClick() {
    if (!adminCanCreate) {
      toastErr('Select a specific customer above to create a trunk');
      return;
    }
    setCreateOpen(true);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      {/* Hero */}
      <header>
        <div style={heroBadge()}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: GLASS.accent, boxShadow: `0 0 8px ${GLASS.accent}` }} />
          <span style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: GLASS.accent }}>
            SIP Trunking
          </span>
        </div>
        <h1 style={heroTitle()}>{user?.customer_name ? `${user.customer_name}'s SIP Trunks` : 'SIP Trunks'}</h1>
        <p style={heroSubtitle}>
          Enterprise SIP trunking with IP-based authentication, channel and CPS limits, and real-time
          monitoring. Expand any trunk for live activity, authorized IPs and routed DIDs.
        </p>
      </header>

      {/* Admin scope selector */}
      {isAdmin && (
        <AdminCustomerSelector
          selectedCustomerId={adminSelectedCustomer}
          onSelect={(id) => { setAdminSelectedCustomer(id); setSearch(''); }}
          accent={GLASS.accent}
          accountTypes={['trunk', 'hybrid']}
        />
      )}

      {/* Body */}
      {isLoading ? (
        <div style={CARD_LIST}>
          {Array.from({ length: 4 }).map((_, i) => <SkeletonTrunkCard key={i} />)}
        </div>
      ) : isError ? (
        <ErrorState message="Unable to load SIP trunks. Please try refreshing the page." />
      ) : trunks.length === 0 ? (
        <TrunksEmptyState isAdmin={isAdmin} canCreate={adminCanCreate} onCreate={() => setCreateOpen(true)} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Totals */}
          <div style={TILE_GRID}>
            <StatTile label="Total Trunks" icon="🔌" value={trunks.length} />
            <StatTile label="Active" icon="✅" value={totals.active} />
            <StatTile label="Total Channels" icon="📊" value={totals.channels.toLocaleString()} />
            <StatTile label="Routed DIDs" icon="☎️" value={totals.dids.toLocaleString()} />
          </div>

          {/* Controls */}
          <TrunksControlsBar
            search={search}
            onSearch={setSearch}
            isAdmin={isAdmin}
            count={filtered.length}
            onCreate={handleCreateClick}
          />

          {/* List */}
          {filtered.length === 0 ? (
            <StateCard
              icon={<span style={{ fontSize: '1.4rem' }}>🔍</span>}
              title="No trunks match your search"
              body={`Nothing matched “${search}”. Try a different name, customer, or auth type.`}
            />
          ) : (
            <div style={CARD_LIST}>
              {filtered.map((t, i) => (
                <GlassTrunkCard
                  key={t.id}
                  trunk={t}
                  index={i}
                  isAdmin={isAdmin}
                  canManage={canManage}
                  showCustomer={isAdmin}
                  onDelete={handleDelete}
                  deleting={deleteMutation.isPending && deleteMutation.variables?.id === t.id}
                />
              ))}
            </div>
          )}

          {/* Footer refresh */}
          <div style={{ textAlign: 'center', marginTop: 4 }}>
            <button
              type="button"
              onClick={refetch}
              style={{ fontSize: '0.72rem', color: GLASS.textFaint, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit' }}
            >
              Refresh
            </button>
          </div>
        </div>
      )}

      {adminCanCreate && customerId !== undefined && (
        <CreateTrunkModal open={createOpen} onClose={() => setCreateOpen(false)} customerId={customerId} />
      )}
    </div>
  );
}
