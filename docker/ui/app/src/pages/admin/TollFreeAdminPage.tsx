/**
 * TollFreeAdminPage — the routed Toll-Free / RespOrg admin page
 * (`/admin/platform/toll-free`, inside the Platform Management shell).
 *
 * THIN page: composition + top-level state only. Built for SCALE — search and
 * pagination are server-side (load-more accumulation); multi-select persists
 * across loaded pages for bulk carrier reassignment. All data + mutations live in
 * `./toll-free/hooks`. React #310: every hook sits unconditionally at the top.
 */

import { useCallback, useState } from 'react';
import { Hash } from 'lucide-react';
import { Pagination } from '../../components/ui/Pagination';
import { GLASS } from '../../components/glass/glass';
import type { Tfn } from '../../types/tollFree';
import {
  useTfnStats,
  useTfnList,
  useCustomerOptions,
  useCarrierOptions,
} from './toll-free/hooks';
import { PAGE_SIZE, emptyTfnFilters, type TfnFilters } from './toll-free/types';
import { TollFreeStatsBar } from './toll-free/components/TollFreeStatsBar';
import { TollFreeControlsBar } from './toll-free/components/TollFreeControlsBar';
import { TfnTable } from './toll-free/components/TfnTable';
import { TableSkeleton, StateCard } from './toll-free/components/states';
import { TfnImportModal } from './toll-free/components/TfnImportModal';
import { ReassignCarrierModal } from './toll-free/components/ReassignCarrierModal';
import { TfnDetailModal } from './toll-free/components/TfnDetailModal';

export function TollFreeAdminPage() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const [draft, setDraft] = useState<TfnFilters>(emptyTfnFilters);
  const [committed, setCommitted] = useState<TfnFilters>(emptyTfnFilters);
  const [offset, setOffset] = useState(0);
  const [resetKey, setResetKey] = useState(0);

  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [showImport, setShowImport] = useState(false);
  const [showReassign, setShowReassign] = useState(false);
  const [detailTfn, setDetailTfn] = useState<string | null>(null);

  const customers = useCustomerOptions();
  const carriers = useCarrierOptions();
  const statsCustomerId = committed.customer_id ? Number(committed.customer_id) : undefined;
  const { data: stats } = useTfnStats(statsCustomerId);
  const { items, total, shownCount, isLoading, isFetching, isError, hasData } = useTfnList({ committed, offset, resetKey });

  const handleSearch = useCallback(() => {
    setCommitted(draft);
    setOffset(0);
    setResetKey((k) => k + 1);
  }, [draft]);

  const handleLoadMore = useCallback(() => setOffset((o) => o + PAGE_SIZE), []);

  const toggleSelect = useCallback((tfn: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tfn)) next.delete(tfn);
      else next.add(tfn);
      return next;
    });
  }, []);

  const toggleAllLoaded = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = items.length > 0 && items.every((t) => next.has(t.tfn));
      if (allSelected) items.forEach((t) => next.delete(t.tfn));
      else items.forEach((t) => next.add(t.tfn));
      return next;
    });
  }, [items]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {stats && <TollFreeStatsBar stats={stats} />}

      <TollFreeControlsBar
        filters={draft}
        onChange={setDraft}
        onSearch={handleSearch}
        searching={isLoading}
        customers={customers}
        carriers={carriers}
        selectedCount={selected.size}
        onReassign={() => setShowReassign(true)}
        onClearSelection={clearSelection}
        onImport={() => setShowImport(true)}
      />

      {isLoading && offset === 0 ? (
        <TableSkeleton />
      ) : isError ? (
        <StateCard
          accent={GLASS.danger}
          icon={<Hash size={26} />}
          title="Couldn't load toll-free numbers"
          body="The request failed. Check your filters and try again."
        />
      ) : hasData ? (
        <>
          <TfnTable rows={items} selected={selected} onToggle={toggleSelect} onToggleAllLoaded={toggleAllLoaded} onView={(t: Tfn) => setDetailTfn(t.tfn)} />
          <Pagination shown={shownCount} total={total} onLoadMore={handleLoadMore} loading={isFetching && offset > 0} />
        </>
      ) : null}

      {showImport && <TfnImportModal customers={customers} carriers={carriers} onClose={() => setShowImport(false)} />}
      {showReassign && (
        <ReassignCarrierModal
          selectedTfns={[...selected]}
          carriers={carriers}
          onDone={clearSelection}
          onClose={() => setShowReassign(false)}
        />
      )}
      {detailTfn && <TfnDetailModal tfn={detailTfn} customers={customers} carriers={carriers} onClose={() => setDetailTfn(null)} />}
    </div>
  );
}
