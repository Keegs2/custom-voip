/**
 * ResultsPanel — the frosted results surface: a header (label + count) and the
 * appropriate inner state (loading / error / empty / no-results / table). The
 * single GlassPanel here owns the glass surface for every state below it.
 */

import { GlassPanel } from '../../../components/glass/GlassCard';
import type { CallGroup } from '../types';
import { ResultsTable } from './ResultsTable';
import { EmptyState, NoResultsState, LoadingState, ErrorState } from './states';
import { resultsHeader, resultsHeaderLabel, resultsHeaderCount } from '../styles';

interface ResultsPanelProps {
  hasSearched: boolean;
  isLoading: boolean;
  isError: boolean;
  errorMessage: string | null;
  totalCalls: number;
  totalMessages: number;
  callGroups: CallGroup[];
  correlations: Record<string, string[]>;
  pipelineWarnings: string[];
  startTime: string;
  endTime: string;
}

export function ResultsPanel({
  hasSearched,
  isLoading,
  isError,
  errorMessage,
  totalCalls,
  totalMessages,
  callGroups,
  correlations,
  pipelineWarnings,
  startTime,
  endTime,
}: ResultsPanelProps) {
  return (
    <GlassPanel padding={0} blur={20}>
      <div style={resultsHeader}>
        <span style={resultsHeaderLabel}>Results</span>
        {hasSearched && !isLoading && !isError && (
          <span style={resultsHeaderCount}>
            {totalCalls} {totalCalls === 1 ? 'call' : 'calls'} found ({totalMessages} total messages)
          </span>
        )}
      </div>

      {isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState message={errorMessage} />
      ) : !hasSearched ? (
        <EmptyState />
      ) : callGroups.length === 0 ? (
        <NoResultsState />
      ) : (
        <ResultsTable
          callGroups={callGroups}
          correlations={correlations}
          pipelineWarnings={pipelineWarnings}
          startTime={startTime}
          endTime={endTime}
        />
      )}
    </GlassPanel>
  );
}
