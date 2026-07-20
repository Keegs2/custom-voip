/**
 * Glass loading / error / warning states for the Calendar page. All frosted, all
 * driven by props.
 */

import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import { bannerStyle, spinner, stateIcon } from '../styles';
import { PROVIDER_META } from '../providerMeta';
import type { ProviderResult } from '../../../types/calendar';

/** Centered glass spinner shown while the connections query is loading. */
export function CalendarLoading() {
  return (
    <GlassPanel padding="48px 40px">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          color: GLASS.textMuted,
          fontSize: '0.875rem',
        }}
      >
        <span style={spinner()} /> Loading your calendars…
      </div>
    </GlassPanel>
  );
}

/** Glass error card shown when the connections query itself fails. */
export function ConnectionsErrorCard() {
  return (
    <GlassPanel padding="40px 32px" accent={GLASS.danger}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 12 }}>
        <div style={stateIcon(GLASS.danger)}>
          <svg viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" style={{ width: 26, height: 26 }}>
            <path d="M11 7v5M11 15.5v.01" />
            <circle cx="11" cy="11" r="9" />
          </svg>
        </div>
        <div style={{ fontSize: '1rem', fontWeight: 700, color: GLASS.text }}>
          Unable to load your calendar connections
        </div>
        <div style={{ fontSize: '0.85rem', color: GLASS.textMuted, maxWidth: 360, lineHeight: 1.5 }}>
          Please try refreshing the page.
        </div>
      </div>
    </GlassPanel>
  );
}

/** Inline amber banner for non-reauth provider partial-failures. */
export function ProviderWarningBanner({ warnings }: { warnings: ProviderResult[] }) {
  if (warnings.length === 0) return null;
  return (
    <div style={bannerStyle(GLASS.warning)}>
      {warnings
        .map((p) => `${PROVIDER_META[p.provider].short} events are temporarily unavailable`)
        .join(' · ')}
      .
    </div>
  );
}
