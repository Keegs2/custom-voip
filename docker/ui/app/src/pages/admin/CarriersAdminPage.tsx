/**
 * CarriersAdminPage — carrier/gateway management (admin). Each carrier card
 * includes a live SIP connectivity test.
 *
 * This is the THIN page: composition + top-level state only. All data fetching,
 * mutations, and per-card editor logic live in `./carriers/hooks.ts`; the
 * frosted-glass surfaces live in `./carriers/components/*` and their styles in
 * `./carriers/styles.ts`. See docs/FRONTEND_GLASS_REFACTOR.md.
 *
 * It renders inside the PlatformManagementPage tab shell (which owns the page
 * header, tab bar and top offset), so this page adds no hero and does not re-pad
 * the top edge — it just lays out its sections on the app-wide glass backdrop.
 *
 * React #310: every hook sits unconditionally at the top, before any return.
 */

import { useState } from 'react';
import { Modal } from '../../components/ui/Modal';
import { GLASS } from '../../components/glass/glass';
import { useCarriersAdmin } from './carriers/hooks';
import { CarriersControlsBar } from './carriers/components/CarriersControlsBar';
import { CarrierCard } from './carriers/components/CarrierCard';
import { CarrierForm } from './carriers/components/CarrierForm';
import { CarriersSkeleton, StateCard } from './carriers/components/states';
import { IconError, IconEmpty } from './carriers/components/icons';

const CARD_GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))',
  gap: 16,
};

export function CarriersAdminPage() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const [showAddModal, setShowAddModal] = useState(false);
  const { carriers, isLoading, isError, testingAll, create, testAll } = useCarriersAdmin(
    () => setShowAddModal(false),
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <CarriersControlsBar
        count={isLoading ? null : carriers.length}
        testingAll={testingAll}
        onTestAll={testAll}
        onAdd={() => setShowAddModal(true)}
      />

      {isLoading ? (
        <CarriersSkeleton />
      ) : isError ? (
        <StateCard
          icon={<IconError />}
          title="Couldn't load carriers"
          body="The request failed. Check your connection and try again."
          accent={GLASS.danger}
        />
      ) : carriers.length === 0 ? (
        <StateCard
          icon={<IconEmpty />}
          title="No carriers configured"
          body="Add your first carrier connection to get started."
        />
      ) : (
        <div style={CARD_GRID}>
          {carriers.map((carrier, i) => (
            <CarrierCard key={carrier.id} carrier={carrier} index={i} />
          ))}
        </div>
      )}

      <Modal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        title="Add Carrier"
        maxWidth="max-w-2xl"
      >
        <CarrierForm
          submitLabel="Create Carrier"
          onCancel={() => setShowAddModal(false)}
          onSubmit={async (values) => { await create(values); }}
        />
      </Modal>
    </div>
  );
}
