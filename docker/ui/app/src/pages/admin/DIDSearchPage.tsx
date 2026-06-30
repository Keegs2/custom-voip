/**
 * DIDSearchPage — the THIN routed page for Number Management / DID Search
 * (rendered at /admin/platform/dids inside the Platform Management shell).
 *
 * Per docs/FRONTEND_GLASS_REFACTOR.md this file does composition + top-level
 * state ONLY. All data, mutations, styles, and presentational pieces live in the
 * co-located `did-search/` feature folder. The app-wide GlassBackground is
 * mounted by AppLayout, and the page padding/top-offset is owned centrally — so
 * this page adds neither; it just stacks glass surfaces with even section gaps.
 *
 * React #310: every hook is called unconditionally at the very top.
 */

import { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { PageHero } from './did-search/components/PageHero';
import { TabBar } from './did-search/components/TabBar';
import { InventoryTab } from './did-search/components/InventoryTab';
import { AvailableTab } from './did-search/components/AvailableTab';
import { AssignmentsTab } from './did-search/components/AssignmentsTab';
import { MyNumbersTab } from './did-search/components/MyNumbersTab';
import type { TabDef, TabId } from './did-search/types';

const ADMIN_TABS: TabDef[] = [
  { id: 'inventory',   label: 'Inventory' },
  { id: 'available',   label: 'Available Numbers' },
  { id: 'assignments', label: 'Assignments' },
];

const CUSTOMER_TABS: TabDef[] = [
  { id: 'available',  label: 'Available Numbers' },
  { id: 'my-numbers', label: 'My Numbers' },
];

export function DIDSearchPage() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const { isAdmin } = useAuth();
  const [activeTab, setActiveTab] = useState<TabId>(() => (isAdmin ? 'inventory' : 'available'));

  const tabs = isAdmin ? ADMIN_TABS : CUSTOMER_TABS;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <PageHero isAdmin={isAdmin} />

      <TabBar tabs={tabs} activeId={activeTab} onChange={setActiveTab} />

      <div className="glass-rise">
        {activeTab === 'inventory' && isAdmin && <InventoryTab />}
        {activeTab === 'available' && <AvailableTab isAdmin={isAdmin} />}
        {activeTab === 'assignments' && isAdmin && <AssignmentsTab />}
        {activeTab === 'my-numbers' && !isAdmin && <MyNumbersTab />}
      </div>
    </div>
  );
}
