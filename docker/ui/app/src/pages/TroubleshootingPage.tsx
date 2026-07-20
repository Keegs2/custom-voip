/**
 * TroubleshootingPage — native SIP-trace search (no Homer iframe).
 *
 * This is a FULL-SCREEN route that renders its OWN <Sidebar> outside AppLayout,
 * so the app-wide liquid-glass backdrop is NOT present — this page mounts its own
 * <GlassBackground/> and owns the spacing standard locally (see styles.pageColumn).
 *
 * Architecture (per docs/FRONTEND_GLASS_REFACTOR.md): this file is the THIN page —
 * composition + top-level form state only. The search mutation + call grouping
 * live in ./troubleshooting/hooks; styles in ./troubleshooting/styles; the dumb
 * presentational pieces in ./troubleshooting/components.
 *
 * React #310: every hook sits unconditionally at the top, before any return.
 */

import { useCallback, useState } from 'react';
import { Sidebar } from '../components/layout/Sidebar';
import { GlassBackground } from '../components/glass/GlassBackground';
import { GLASS } from '../components/glass/glass';
import type { HomerSearchParams } from '../api/homer';
import { useSipSearch } from './troubleshooting/hooks';
import { isoOffset, stripPlus } from './troubleshooting/format';
import { pageMain, pageColumn } from './troubleshooting/styles';
import { Hero } from './troubleshooting/components/Hero';
import { SearchForm } from './troubleshooting/components/SearchForm';
import { ResultsPanel } from './troubleshooting/components/ResultsPanel';

export function TroubleshootingPage() {
  // ── ALL hooks unconditionally at the top (React #310) ──────────────────────
  const [fromUser, setFromUser] = useState('');
  const [toUser, setToUser] = useState('');
  const [callId, setCallId] = useState('');
  const [startTime, setStartTime] = useState(() => isoOffset(-24));
  const [endTime, setEndTime] = useState(() => isoOffset(0));
  const [validationError, setValidationError] = useState<string | null>(null);

  const search = useSipSearch();

  const handleSearch = useCallback(() => {
    // Validation: at least one of From, To, or Call-ID must be filled.
    if (!fromUser.trim() && !toUser.trim() && !callId.trim()) {
      setValidationError('Enter at least one of From, To, or Call-ID to search.');
      return;
    }
    setValidationError(null);

    const params: HomerSearchParams = {
      start_time: new Date(startTime).toISOString(),
      end_time: new Date(endTime).toISOString(),
    };
    if (fromUser.trim()) params.from_user = stripPlus(fromUser);
    if (toUser.trim()) params.to_user = stripPlus(toUser);
    if (callId.trim()) params.call_id = callId.trim();

    search.run(params);
  }, [fromUser, toUser, callId, startTime, endTime, search]);

  const handleClear = useCallback(() => {
    setFromUser('');
    setToUser('');
    setCallId('');
    setStartTime(isoOffset(-24));
    setEndTime(isoOffset(0));
    setValidationError(null);
    search.reset();
  }, [search]);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen" style={{ background: GLASS.bg, position: 'relative' }}>
      {/* Full-screen page: mount the ambient backdrop ourselves (no AppLayout). */}
      <GlassBackground />
      <Sidebar />

      {/* sidebar-offset = the 240px sidebar offset, applied ONLY at md+ (below md
          the Sidebar is off-canvas; see pageMain's note in styles.ts). */}
      <main className="sidebar-offset" style={pageMain}>
        <div style={pageColumn}>
          <Hero />

          <SearchForm
            fromUser={fromUser}
            toUser={toUser}
            callId={callId}
            startTime={startTime}
            endTime={endTime}
            validationError={validationError}
            isLoading={search.isLoading}
            onFromUser={setFromUser}
            onToUser={setToUser}
            onCallId={setCallId}
            onStartTime={setStartTime}
            onEndTime={setEndTime}
            onSearch={handleSearch}
            onClear={handleClear}
          />

          <ResultsPanel
            hasSearched={search.hasSearched}
            isLoading={search.isLoading}
            isError={search.isError}
            errorMessage={search.errorMessage}
            totalCalls={search.totalCalls}
            totalMessages={search.totalMessages}
            callGroups={search.callGroups}
            correlations={search.correlations}
            pipelineWarnings={search.pipelineWarnings}
            startTime={startTime}
            endTime={endTime}
          />
        </div>
      </main>
    </div>
  );
}
