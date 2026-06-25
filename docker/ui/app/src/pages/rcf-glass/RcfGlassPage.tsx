/**
 * RcfGlassPage — the CANONICAL reference implementation for the app-wide liquid
 * glass redesign (blue theme) AND the per-page refactor architecture.
 *
 * It is a fresh, smaller "liquid glass" surface for Remote Call Forwarding wired
 * to the SAME live data + the SAME forward_to mutation as the production
 * /rcf page, so saving here actually persists. It is deliberately NOT a fork of
 * the 4800-line RcfPage.
 *
 * Architecture (mirror this for the rollout — see docs/FRONTEND_GLASS_REFACTOR.md):
 *   RcfGlassPage.tsx  → composition + top-level state ONLY (this file)
 *   hooks.ts          → data fetching, mutations, derived state
 *   styles.ts         → centralised CSSProperties / style builders
 *   components/        → dumb presentational pieces
 *   types.ts          → local types
 *
 * The ambient GlassBackground is mounted app-wide by AppLayout — this page does
 * NOT mount its own; it just builds glass surfaces on top.
 *
 * React #310: every hook sits unconditionally at the top, before any return.
 */

import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { AdminCustomerSelector } from '../../components/AdminCustomerSelector';
import { GLASS } from '../../components/glass/glass';
import { useRcfGlassData } from './hooks';
import { PAGE_SIZE, type SortField, type ViewMode } from './types';
import { heroBadge, heroTitle, heroSubtitle } from './styles';
import { GlassRcfCard } from './components/GlassRcfCard';
import { GlassTable } from './components/GlassTable';
import { RcfControlsBar } from './components/RcfControlsBar';
import { SkeletonCard, StateCard, LoadMore } from './components/states';
import { IconError, IconEmpty } from './components/icons';

const CARD_GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
  gap: 18,
};

export function RcfGlassPage() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const { user, isAdmin } = useAuth();
  const [customerId, setCustomerId] = useState<number | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortField>('did');
  const [view, setView] = useState<ViewMode>('cards');
  const [visible, setVisible] = useState(PAGE_SIZE);

  const { filtered, shown, isLoading, isError, error, isFetching, refetch } = useRcfGlassData({
    customerId,
    search,
    sort,
    visible,
  });

  const canEdit = user?.role !== 'readonly';
  const hasMore = filtered.length > shown.length;

  return (
    <>
      {/* Hero */}
      <header style={{ marginBottom: 28 }}>
        <div style={heroBadge()}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: GLASS.accent, boxShadow: `0 0 8px ${GLASS.accent}` }} />
          <span style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: GLASS.accent }}>
            Remote Call Forwarding
          </span>
        </div>
        <h1 style={heroTitle()}>Forwarding Lines</h1>
        <p style={heroSubtitle}>
          Every inbound DID and where its calls ring through. Click any destination to reroute it instantly — changes go live on the next call.
        </p>
      </header>

      {/* Admin scope selector */}
      {isAdmin && (
        <div style={{ marginBottom: 18 }}>
          <AdminCustomerSelector
            selectedCustomerId={customerId}
            onSelect={(id) => { setCustomerId(id); setVisible(PAGE_SIZE); }}
            accent={GLASS.accent}
            accountTypes={['rcf', 'hybrid']}
          />
        </div>
      )}

      {/* Controls */}
      <RcfControlsBar
        search={search}
        onSearch={(v) => { setSearch(v); setVisible(PAGE_SIZE); }}
        sort={sort}
        onSort={setSort}
        view={view}
        onView={setView}
        isAdmin={isAdmin}
        count={filtered.length}
        busy={isFetching && !isLoading}
      />

      {/* Body */}
      {isLoading ? (
        <div style={CARD_GRID}>
          {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      ) : isError ? (
        <StateCard
          icon={<IconError />}
          title="Couldn't load forwarding lines"
          body={(error as Error)?.message ?? 'The request failed. Check your connection and try again.'}
        />
      ) : filtered.length === 0 ? (
        <StateCard
          icon={<IconEmpty />}
          title={search ? 'No lines match your search' : 'No forwarding lines yet'}
          body={search ? 'Try a different DID, destination, or label.' : 'Forwarding lines provisioned to this account will appear here.'}
        />
      ) : view === 'cards' ? (
        <>
          <div style={CARD_GRID}>
            {shown.map((e, i) => (
              <GlassRcfCard key={e.id} entry={e} canEdit={canEdit} isAdmin={isAdmin} index={i} />
            ))}
          </div>
          {hasMore && <LoadMore remaining={filtered.length - shown.length} onClick={() => setVisible((v) => v + PAGE_SIZE)} />}
        </>
      ) : (
        <>
          <GlassTable entries={shown} canEdit={canEdit} isAdmin={isAdmin} />
          {hasMore && <LoadMore remaining={filtered.length - shown.length} onClick={() => setVisible((v) => v + PAGE_SIZE)} />}
        </>
      )}

      {/* Footer */}
      <div style={{ marginTop: 28, textAlign: 'center' }}>
        <button
          type="button"
          onClick={refetch}
          style={{ fontSize: '0.72rem', color: GLASS.textFaint, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit' }}
        >
          Refresh
        </button>
      </div>
    </>
  );
}
