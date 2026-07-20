/**
 * AvailableTab — browse unassigned DIDs. Admins can assign directly; customers
 * request a number. Holds its own filter + modal-target state and reads data
 * through the feature hooks.
 *
 * React #310: all hooks sit unconditionally at the top.
 */

import { useCallback, useState } from 'react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { Button } from '../../../../components/ui/Button';
import { fmt } from '../../../../utils/format';
import type { DidInventoryItem } from '../../../../types/didInventory';
import { useAvailableData, useRequestDid } from '../hooks';
import {
  panelToolbar, countText, countStrong, tableWrap, table, th, td, didCell,
} from '../styles';
import { FilterBar } from './FilterBar';
import { EnvBadge } from './Chips';
import { LoadingRow, EmptyRow } from './states';
import { AssignModal } from './AssignModal';

const COLS = 7;

interface AvailableTabProps {
  isAdmin: boolean;
}

export function AvailableTab({ isAdmin }: AvailableTabProps) {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [assignTarget, setAssignTarget] = useState<DidInventoryItem | null>(null);

  const { items, isLoading } = useAvailableData(search, stateFilter);
  const requestMutation = useRequestDid();

  const onSearch = useCallback((v: string) => setSearch(v), []);
  const onState = useCallback((v: string) => setStateFilter(v), []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <GlassPanel padding={0} blur={20}>
        <div style={panelToolbar}>
          <div style={countText}>
            <strong style={countStrong}>{items.length.toLocaleString()}</strong> available numbers
          </div>
        </div>

        <FilterBar
          search={search}
          onSearchChange={onSearch}
          statusFilter=""
          onStatusChange={() => undefined}
          stateFilter={stateFilter}
          onStateChange={onState}
          placeholder="Search area code, city, rate center…"
          hideStatus
        />

        <div style={tableWrap}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th()}>DID</th>
                <th style={th()}>City</th>
                <th style={th()}>State</th>
                <th style={th()}>LATA</th>
                <th style={th()}>Rate Center</th>
                <th style={th()}>Environment</th>
                <th style={th(true)}>Action</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <LoadingRow colSpan={COLS} />
              ) : items.length === 0 ? (
                <EmptyRow colSpan={COLS} message={`No available numbers${search || stateFilter ? ' matching those filters' : ''}`} />
              ) : (
                items.map((item) => (
                  <tr key={item.id}>
                    <td style={td()}><span style={didCell}>{fmt(item.did)}</span></td>
                    <td style={td({ muted: true })}>{item.city ?? '—'}</td>
                    <td style={td({ muted: true })}>{item.state ?? '—'}</td>
                    <td style={td({ muted: true })}>{item.lata ?? '—'}</td>
                    <td style={td({ muted: true })}>{item.rate_center ?? '—'}</td>
                    <td style={td()}><EnvBadge env={item.allocated_env} /></td>
                    <td style={td({ right: true })}>
                      {isAdmin ? (
                        <Button size="xs" variant="primary" onClick={() => setAssignTarget(item)}>Assign</Button>
                      ) : (
                        <Button
                          size="xs"
                          variant="primary"
                          loading={requestMutation.isPending}
                          onClick={() => requestMutation.mutate(item.did)}
                        >
                          Request
                        </Button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </GlassPanel>

      {/* Assign modal — admin only */}
      {isAdmin && (
        <AssignModal
          did={assignTarget}
          open={assignTarget !== null}
          onClose={() => setAssignTarget(null)}
          onSuccess={() => setAssignTarget(null)}
        />
      )}
    </div>
  );
}
