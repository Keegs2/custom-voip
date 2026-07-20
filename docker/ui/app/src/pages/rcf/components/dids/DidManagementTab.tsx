/**
 * DIDManagementTab — composition root for the DID self-serve tab: My Numbers
 * (assigned), Pending Requests, and Available Numbers, plus the request/release
 * confirmation modals. All inventory data + mutations come from
 * `useDidManagement`.
 */

import type { DashboardTab } from '../../types';
import { useDidManagement } from '../../hooks';
import { MyNumbersSection } from './MyNumbersSection';
import { PendingRequestsSection } from './PendingRequestsSection';
import { AvailableNumbersSection } from './AvailableNumbersSection';
import { RequestModal, ReleaseModal } from './modals';

interface DIDManagementTabProps {
  customerId: number | undefined;
  onSwitchTab: (tab: DashboardTab) => void;
}

export function DIDManagementTab({ customerId, onSwitchTab }: DIDManagementTabProps) {
  const dm = useDidManagement(customerId);

  return (
    <>
      <RequestModal did={dm.requestTarget} onConfirm={dm.confirmRequest} onCancel={() => dm.setRequestTarget(null)} isPending={dm.requestPending} />
      <ReleaseModal did={dm.releaseTarget} onConfirm={dm.confirmRelease} onCancel={() => dm.setReleaseTarget(null)} isPending={dm.releasePending} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <MyNumbersSection
          items={dm.assignedItems}
          isLoading={dm.myLoading}
          isError={dm.myError}
          onRelease={dm.setReleaseTarget}
          onSwitchToNumbers={() => onSwitchTab('numbers')}
        />
        <PendingRequestsSection items={dm.pendingItems} />
        <AvailableNumbersSection
          items={dm.availItems}
          isLoading={dm.availLoading}
          isError={dm.availError}
          onRequest={dm.setRequestTarget}
          requestingDid={dm.requestingDid}
        />
      </div>
    </>
  );
}
