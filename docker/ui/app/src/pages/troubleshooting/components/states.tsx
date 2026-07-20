/**
 * Inner state blocks for the results panel: empty (no search yet), no-results,
 * loading, and error. These render INSIDE the results GlassPanel, so they are
 * plain content blocks (the frosted surface is owned by ResultsPanel).
 */

import { GLASS } from '../../../components/glass/glass';
import { stateWrap, stateIcon, stateText, inlineStateRow, spinner } from '../styles';
import { IconSignal, IconNoResults, IconAlert } from './icons';

export function EmptyState() {
  return (
    <div style={stateWrap}>
      <div style={stateIcon()}>
        <IconSignal />
      </div>
      <p style={stateText}>
        Search for SIP traces by phone number, Call-ID, or date range.
      </p>
    </div>
  );
}

export function NoResultsState() {
  return (
    <div style={stateWrap}>
      <div style={stateIcon(GLASS.textMuted)}>
        <IconNoResults />
      </div>
      <p style={stateText}>No SIP traces found for your search criteria.</p>
    </div>
  );
}

export function LoadingState() {
  return (
    <div style={{ ...inlineStateRow, color: GLASS.textMuted }}>
      <span style={spinner()} />
      Searching SIP traces…
    </div>
  );
}

export function ErrorState({ message }: { message: string | null }) {
  return (
    <div style={{ ...inlineStateRow, color: GLASS.danger }}>
      <IconAlert />
      {message ?? 'Search failed. Is the Homer backend reachable?'}
    </div>
  );
}
