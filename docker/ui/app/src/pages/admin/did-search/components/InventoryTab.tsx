/**
 * InventoryTab — the admin full-inventory view: stat tiles, a filterable +
 * paginated table of every DID, Bandwidth sync, and assign/unassign actions.
 *
 * Holds its own filter/pagination/modal-target state and reads data through the
 * feature hooks. React #310: all hooks sit unconditionally at the top.
 */

import { useCallback, useState } from 'react';
import { Phone, CheckCircle, Users, Clock, RefreshCw, Plus } from 'lucide-react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { Button } from '../../../../components/ui/Button';
import { fmt } from '../../../../utils/format';
import type { DidInventoryItem, DidStatus, DidAllocatedEnv } from '../../../../types/didInventory';
import { PAGE_SIZE } from '../types';
import { useDidStats, useInventoryData, useSyncInventory } from '../hooks';
import {
  panelToolbar, countText, countStrong, tableWrap, table, th, td, didCell, dash,
} from '../styles';
import { StatTile } from './StatTile';
import { FilterBar } from './FilterBar';
import { StatusBadge, ProductPill, EnvBadge } from './Chips';
import { Spinner, LoadingRow, EmptyRow } from './states';
import { AssignModal } from './AssignModal';
import { UnassignModal } from './UnassignModal';
import { SetEnvModal } from './SetEnvModal';
import { AddDidModal } from './AddDidModal';

const COLS = 8;

export function InventoryTab() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<DidStatus | ''>('');
  const [stateFilter, setStateFilter] = useState('');
  const [envFilter, setEnvFilter] = useState<DidAllocatedEnv | ''>('');
  const [offset, setOffset] = useState(0);
  const [assignTarget, setAssignTarget] = useState<DidInventoryItem | null>(null);
  const [unassignTarget, setUnassignTarget] = useState<DidInventoryItem | null>(null);
  const [envTarget, setEnvTarget] = useState<DidInventoryItem | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const { data: stats, isLoading: statsLoading } = useDidStats();
  const { filteredItems, total, isLoading, isFetching, hasFilters } = useInventoryData({
    search, statusFilter, stateFilter, envFilter, offset,
  });
  const syncMutation = useSyncInventory();

  // Filters that hit the server reset pagination; env is client-side, so it does not.
  const onSearch = useCallback((v: string) => { setSearch(v); setOffset(0); }, []);
  const onStatus = useCallback((v: DidStatus | '') => { setStatusFilter(v); setOffset(0); }, []);
  const onState = useCallback((v: string) => { setStateFilter(v); setOffset(0); }, []);
  const onEnv = useCallback((v: DidAllocatedEnv | '') => setEnvFilter(v), []);

  const statValue = (n: number | undefined) => (statsLoading ? '—' : (n ?? 0));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Stat tiles */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <StatTile label="Total Numbers" value={statValue(stats?.total)} accent={GLASS.blue} icon={<Phone size={17} />} index={0} />
        <StatTile label="Available" value={statValue(stats?.available)} accent={GLASS.cyan} icon={<CheckCircle size={17} />} index={1} />
        <StatTile label="Assigned" value={statValue(stats?.assigned)} accent={GLASS.success} icon={<Users size={17} />} index={2} />
        <StatTile label="Reserved" value={statValue(stats?.reserved)} accent={GLASS.warning} icon={<Clock size={17} />} index={3} />
      </div>

      {/* Table panel */}
      <GlassPanel padding={0} blur={20}>
        <div style={panelToolbar}>
          <div style={countText}>
            {isFetching ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <Spinner /> Loading…
              </span>
            ) : (
              <span>
                <strong style={countStrong}>{total.toLocaleString()}</strong> numbers
                {hasFilters && ' (filtered)'}
                {envFilter && ` · showing ${filteredItems.length.toLocaleString()} on this page`}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Button
              variant="ghost"
              size="sm"
              icon={<Plus size={13} />}
              onClick={() => setAddOpen(true)}
            >
              Add DID
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw size={13} />}
              loading={syncMutation.isPending}
              onClick={() => syncMutation.mutate()}
            >
              Sync from Bandwidth
            </Button>
          </div>
        </div>

        <FilterBar
          search={search}
          onSearchChange={onSearch}
          statusFilter={statusFilter}
          onStatusChange={onStatus}
          stateFilter={stateFilter}
          onStateChange={onState}
          showEnv
          envFilter={envFilter}
          onEnvChange={onEnv}
        />

        <div style={tableWrap}>
          <table style={table}>
            <thead>
              <tr>
                <th style={th()}>DID</th>
                <th style={th()}>City</th>
                <th style={th()}>State</th>
                <th style={th()}>Status</th>
                <th style={th()}>Product</th>
                <th style={th()}>Environment</th>
                <th style={th()}>Customer</th>
                <th style={th(true)}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <LoadingRow colSpan={COLS} />
              ) : filteredItems.length === 0 ? (
                <EmptyRow colSpan={COLS} message={`No numbers found${hasFilters ? ' matching those filters' : ''}`} />
              ) : (
                filteredItems.map((item) => (
                  <tr key={item.id}>
                    <td style={td()}><span style={didCell}>{fmt(item.did)}</span></td>
                    <td style={td({ muted: true })}>{item.city ?? '—'}</td>
                    <td style={td({ muted: true })}>{item.state ?? '—'}</td>
                    <td style={td()}><StatusBadge status={item.status} /></td>
                    <td style={td()}>{item.product_type ? <ProductPill type={item.product_type} /> : <span style={dash}>—</span>}</td>
                    <td style={td()}>
                      <button
                        type="button"
                        onClick={() => setEnvTarget(item)}
                        title="Change owning environment"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          background: 'none',
                          border: 'none',
                          padding: 0,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        <EnvBadge env={item.allocated_env} />
                      </button>
                    </td>
                    <td style={td({ muted: true })}>{item.customer_name ?? <span style={dash}>—</span>}</td>
                    <td style={td({ right: true })}>
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                        {item.status === 'available' && (
                          <Button size="xs" variant="primary" onClick={() => setAssignTarget(item)}>Assign</Button>
                        )}
                        {item.status === 'assigned' && (
                          <Button size="xs" variant="danger" onClick={() => setUnassignTarget(item)}>Unassign</Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div style={{ ...panelToolbar, borderBottom: 'none', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <span style={{ ...countText, color: GLASS.textFaint }}>
              Showing {Math.min(offset + PAGE_SIZE, total).toLocaleString()} of {total.toLocaleString()}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button size="xs" variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                Previous
              </Button>
              <Button size="xs" variant="ghost" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </GlassPanel>

      {/* Modals */}
      <AssignModal
        did={assignTarget}
        open={assignTarget !== null}
        onClose={() => setAssignTarget(null)}
        onSuccess={() => setAssignTarget(null)}
      />
      <UnassignModal
        did={unassignTarget}
        open={unassignTarget !== null}
        onClose={() => setUnassignTarget(null)}
        onSuccess={() => setUnassignTarget(null)}
      />
      <SetEnvModal
        did={envTarget}
        open={envTarget !== null}
        onClose={() => setEnvTarget(null)}
      />
      <AddDidModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
