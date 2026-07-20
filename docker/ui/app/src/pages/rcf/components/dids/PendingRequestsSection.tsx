/**
 * PendingRequestsSection — the customer's reserved/pending DID requests awaiting
 * admin approval. Renders nothing when there are no pending items.
 */

import { GLASS } from '../../../../components/glass/glass';
import { fmt } from '../../../../utils/format';
import type { DidInventoryItem } from '../../../../types/didInventory';
import { fmtAssignedDate } from '../../utils';
import { DidCard, DidSectionHeader, DidStatusBadge, DidTh } from './shared';

export function PendingRequestsSection({ items }: { items: DidInventoryItem[] }) {
  if (items.length === 0) return null;

  return (
    <DidCard delay={80}>
      <DidSectionHeader title="Pending Requests" count={items.length} countLabel="pending" />
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 440 }}>
          <thead>
            <tr>
              <DidTh>DID</DidTh><DidTh>City</DidTh><DidTh>State</DidTh><DidTh>Requested</DidTh><DidTh>Status</DidTh>
            </tr>
          </thead>
          <tbody>
            {items.map((item, idx) => (
              <tr key={item.id} style={{ borderBottom: idx < items.length - 1 ? '1px solid rgba(59,130,246,0.06)' : 'none' }}>
                <td style={{ padding: '12px 16px' }}>
                  <div style={{ fontSize: '0.88rem', fontWeight: 700, color: GLASS.text, fontFamily: 'monospace', letterSpacing: '0.02em' }}>{fmt(item.did)}</div>
                </td>
                <td style={{ padding: '12px 16px' }}><span style={{ fontSize: '0.82rem', color: GLASS.textMuted }}>{item.city ?? '—'}</span></td>
                <td style={{ padding: '12px 16px' }}><span style={{ fontSize: '0.82rem', color: GLASS.textMuted, fontWeight: 600 }}>{item.state ?? '—'}</span></td>
                <td style={{ padding: '12px 16px' }}><span style={{ fontSize: '0.78rem', color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>{fmtAssignedDate(item.assigned_at)}</span></td>
                <td style={{ padding: '12px 16px' }}><DidStatusBadge status={item.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DidCard>
  );
}
