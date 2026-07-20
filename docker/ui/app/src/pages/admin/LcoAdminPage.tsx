/**
 * LcoAdminPage — the routed Least-Cost Outbound admin page
 * (`/admin/platform/lco`, inside the Platform Management shell).
 *
 * THIN page: composition + the active sub-tab only. The four surfaces — route
 * preview, rate decks, carrier policy, and the transparent savings report — each
 * own their state via the feature hooks. Customers + carriers are fetched once
 * here and passed down. React #310: every hook sits unconditionally at the top.
 */

import { useState } from 'react';
import { TabBar } from '../../components/ui/TabBar';
import { useCustomerOptions, useCarrierOptions } from './lco/hooks';
import { LCO_TABS, type LcoTabId } from './lco/types';
import { RoutePreview } from './lco/components/RoutePreview';
import { DecksTab } from './lco/components/DecksTab';
import { PolicyTab } from './lco/components/PolicyTab';
import { SavingsTab } from './lco/components/SavingsTab';

export function LcoAdminPage() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<LcoTabId>('route');
  const customers = useCustomerOptions();
  const carriers = useCarrierOptions();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <TabBar tabs={LCO_TABS.map((t) => ({ id: t.id, label: t.label }))} activeTab={activeTab} onTabChange={(id) => setActiveTab(id as LcoTabId)} />

      {activeTab === 'route' && <RoutePreview customers={customers} carriers={carriers} />}
      {activeTab === 'decks' && <DecksTab carriers={carriers} />}
      {activeTab === 'policy' && <PolicyTab customers={customers} carriers={carriers} />}
      {activeTab === 'savings' && <SavingsTab customers={customers} />}
    </div>
  );
}
