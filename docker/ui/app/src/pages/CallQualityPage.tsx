/**
 * CallQualityPage — platform-wide SIP call quality analysis.
 *
 * THIN page: composition + top-level state only. Everything else lives in the
 * co-located feature folder (see docs/FRONTEND_GLASS_REFACTOR.md):
 *   ./call-quality/hooks.ts       → data fetching + derived analytics pipeline
 *   ./call-quality/quality.ts     → pure colour/format/reducer helpers
 *   ./call-quality/styles.ts      → centralised CSSProperties
 *   ./call-quality/components/     → presentational pieces (filter bar, charts,
 *                                    stat tiles, CDR table, detail drawer, states)
 *   ./call-quality/types.ts       → local types
 *
 * Sections: hero → filter bar → quality overview → trend charts → CDR table →
 * slide-out call detail drawer.
 *
 * The ambient GlassBackground is mounted app-wide by AppLayout — this page does
 * NOT mount its own. React #310: every hook sits unconditionally at the top.
 */

import { useCallback, useState } from 'react';
import { GLASS } from '../components/glass/glass';
import { IconSignal } from '../components/icons/ProductIcons';
import type { Cdr } from '../types/cdr';
import { useCallQuality, useReferenceData } from './call-quality/hooks';
import { getDefaultFilters } from './call-quality/quality';
import type { FilterState } from './call-quality/types';
import { heroBadge, heroTitle, heroSubtitle } from './call-quality/styles';
import { FilterBar } from './call-quality/components/FilterBar';
import { QualityOverview } from './call-quality/components/QualityOverview';
import { QualityTrends } from './call-quality/components/QualityTrends';
import { CdrSection } from './call-quality/components/CdrSection';
import { CallDetailPanel } from './call-quality/components/CallDetailPanel';
import { ErrorBanner } from './call-quality/components/states';

export function CallQualityPage() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const [filters, setFilters] = useState<FilterState>(getDefaultFilters);
  const [appliedFilters, setAppliedFilters] = useState<FilterState>(getDefaultFilters);
  const [selectedCdr, setSelectedCdr] = useState<Cdr | null>(null);

  const { customers, trunks } = useReferenceData(filters.customerId);
  const { cdrData, allCdrs, overviewStats, mosPts, plPts, jPts, isLoading, isError, refetch } = useCallQuality(appliedFilters);

  const patchFilters = useCallback((patch: Partial<FilterState>) => {
    setFilters((prev) => {
      const next = { ...prev, ...patch };
      // Changing the customer scope invalidates any selected trunk.
      if ('customerId' in patch && patch.customerId !== prev.customerId) {
        next.trunkId = null;
      }
      return next;
    });
  }, []);

  const handleSelect = useCallback((cdr: Cdr) => {
    setSelectedCdr((prev) => (prev?.uuid === cdr.uuid ? null : cdr));
  }, []);

  const handleClose = useCallback(() => setSelectedCdr(null), []);

  const handleSearch = useCallback(() => {
    setAppliedFilters({ ...filters });
  }, [filters]);

  const handleReset = useCallback(() => {
    const defaults = getDefaultFilters();
    setFilters(defaults);
    setAppliedFilters(defaults);
  }, []);

  // ── Composition only ──────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
      {/* Hero */}
      <header>
        <div style={heroBadge()}>
          <span style={{ display: 'inline-flex', color: GLASS.accent }}><IconSignal size={14} /></span>
          <span style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: GLASS.accent }}>
            Call Quality
          </span>
        </div>
        <h1 style={heroTitle()}>SIP Quality Analysis</h1>
        <p style={heroSubtitle}>
          Platform-wide call quality, RTP diagnostics, and per-call SIP detail. Filter by customer, trunk, number, or date — then drill into any CDR.
        </p>
      </header>

      {/* Filters */}
      <FilterBar
        filters={filters}
        onPatch={patchFilters}
        customers={customers}
        trunks={trunks}
        isLoading={isLoading}
        onSearch={handleSearch}
        onReset={handleReset}
        loadedCount={cdrData ? allCdrs.length : undefined}
        total={cdrData?.total}
      />

      {/* Error */}
      {isError && <ErrorBanner onRetry={refetch} />}

      {/* Quality overview */}
      <QualityOverview stats={overviewStats} isLoading={isLoading} />

      {/* Trend charts */}
      <QualityTrends mosPts={mosPts} plPts={plPts} jPts={jPts} isLoading={isLoading} hasData={allCdrs.length > 0} />

      {/* CDR table */}
      <CdrSection
        cdrs={allCdrs}
        customers={customers}
        isLoading={isLoading}
        onSelect={handleSelect}
        selectedUuid={selectedCdr?.uuid ?? null}
      />

      {/* Detail drawer */}
      {selectedCdr && <CallDetailPanel cdr={selectedCdr} onClose={handleClose} />}
    </div>
  );
}
