/**
 * AssignmentsTab — admin view of all assigned DIDs, grouped by customer, with an
 * unassign action per row. Holds its own filter + modal-target state and reads
 * data (already grouped) through the feature hooks.
 *
 * React #310: all hooks sit unconditionally at the top.
 */

import { useCallback, useState } from 'react';
import { Users } from 'lucide-react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { Button } from '../../../../components/ui/Button';
import { fmt } from '../../../../utils/format';
import type { DidInventoryItem } from '../../../../types/didInventory';
import { useAssignmentsData } from '../hooks';
import {
  panelToolbar, countText, countStrong, table, th, td, didCell, dash, notesCell,
  groupHeader, groupName, groupCount, statePad,
} from '../styles';
import { FilterBar } from './FilterBar';
import { ProductPill, EnvBadge } from './Chips';
import { Spinner } from './states';
import { UnassignModal } from './UnassignModal';

export function AssignmentsTab() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [unassignTarget, setUnassignTarget] = useState<DidInventoryItem | null>(null);

  const { groups, count, isLoading, isFetching } = useAssignmentsData(search, stateFilter);

  const onSearch = useCallback((v: string) => setSearch(v), []);
  const onState = useCallback((v: string) => setStateFilter(v), []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <GlassPanel padding={0} blur={20}>
        <div style={panelToolbar}>
          <div style={countText}>
            {isFetching ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <Spinner /> Loading…
              </span>
            ) : (
              <span>
                <strong style={countStrong}>{count.toLocaleString()}</strong> assigned numbers
                {(search || stateFilter) && ' (filtered)'}
              </span>
            )}
          </div>
        </div>

        <FilterBar
          search={search}
          onSearchChange={onSearch}
          statusFilter="assigned"
          onStatusChange={() => undefined}
          stateFilter={stateFilter}
          onStateChange={onState}
          placeholder="Search DID, customer, city…"
          hideStatus
        />

        {isLoading ? (
          <div style={statePad}><Spinner size={20} /></div>
        ) : groups.length === 0 ? (
          <div style={statePad}>No assigned numbers found</div>
        ) : (
          <div>
            {groups.map((group) => (
              <div key={group.name}>
                <div style={groupHeader}>
                  <Users size={13} color={GLASS.accent} />
                  <span style={groupName}>{group.name}</span>
                  <span style={groupCount()}>{group.dids.length}</span>
                </div>

                <table style={table}>
                  <thead>
                    <tr>
                      <th style={th()}>DID</th>
                      <th style={th()}>City / State</th>
                      <th style={th()}>Product</th>
                      <th style={th()}>Environment</th>
                      <th style={th()}>Assigned</th>
                      <th style={th()}>Notes</th>
                      <th style={th(true)}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.dids.map((item) => (
                      <tr key={item.id}>
                        <td style={td()}><span style={didCell}>{fmt(item.did)}</span></td>
                        <td style={td({ muted: true })}>{[item.city, item.state].filter(Boolean).join(', ') || '—'}</td>
                        <td style={td()}>{item.product_type ? <ProductPill type={item.product_type} /> : <span style={dash}>—</span>}</td>
                        <td style={td()}><EnvBadge env={item.allocated_env} /></td>
                        <td style={td({ muted: true })}>{item.assigned_at ? new Date(item.assigned_at).toLocaleDateString() : '—'}</td>
                        <td style={td({ muted: true })}><span style={notesCell}>{item.notes ?? '—'}</span></td>
                        <td style={td({ right: true })}>
                          <Button size="xs" variant="danger" onClick={() => setUnassignTarget(item)}>Unassign</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </GlassPanel>

      <UnassignModal
        did={unassignTarget}
        open={unassignTarget !== null}
        onClose={() => setUnassignTarget(null)}
        onSuccess={() => setUnassignTarget(null)}
      />
    </div>
  );
}
