/**
 * Educational empty state shown when the user has no calendar connections.
 * Frosted glass panel: headline, 3 "how it works" steps, a privacy reassurance
 * pill, and the two Connect buttons.
 */
import { CalendarDays, Lock } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import type { CalendarProvider } from '../../../types/calendar';
import { ALL_PROVIDERS, PROVIDER_META } from '../providerMeta';
import {
  emptyIcon,
  emptyLead,
  emptyTitle,
  privacyPill,
  stepBadge,
  stepsGrid,
} from '../styles';

interface CalendarEmptyStateProps {
  onConnect: (provider: CalendarProvider) => void;
  connecting: CalendarProvider | null;
}

function HowItWorksStep({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div style={{ display: 'flex', gap: 14, textAlign: 'left' }}>
      <div style={stepBadge()}>{n}</div>
      <div>
        <div style={{ fontSize: '0.88rem', fontWeight: 700, color: GLASS.text, marginBottom: 2 }}>{title}</div>
        <div style={{ fontSize: '0.8rem', color: GLASS.textMuted, lineHeight: 1.5 }}>{body}</div>
      </div>
    </div>
  );
}

export function CalendarEmptyState({ onConnect, connecting }: CalendarEmptyStateProps) {
  return (
    <GlassPanel radius={22} padding="48px 32px" style={{ textAlign: 'center' }}>
      <div style={emptyIcon()}>
        <CalendarDays size={30} strokeWidth={1.8} />
      </div>

      <h2 style={emptyTitle}>Bring your calendars together</h2>
      <p style={emptyLead}>
        Connect your Google Calendar and Microsoft 365 (Outlook) accounts to view a single,
        unified schedule right inside Unified Comms. Read-only and private — we never change,
        create, or delete anything on your calendars.
      </p>

      <div style={stepsGrid}>
        <HowItWorksStep
          n={1}
          title="Connect securely"
          body="Sign in with Google or Microsoft. We use OAuth — your password is never shared with us, and you can revoke access at any time."
        />
        <HowItWorksStep
          n={2}
          title="Read-only sync"
          body="We request the minimum read-only scopes and pull your events on demand. Nothing on your calendar is ever modified."
        />
        <HowItWorksStep
          n={3}
          title="Disconnect anytime"
          body="One click removes the connection and revokes our access. We store encrypted tokens only — never your event contents."
        />
      </div>

      {/* Privacy reassurance pill */}
      <div style={privacyPill()}>
        <Lock size={12} strokeWidth={2} />
        Tokens encrypted at rest · read-only scopes · no event data stored
      </div>

      <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
        {ALL_PROVIDERS.map((provider) => {
          const meta = PROVIDER_META[provider];
          return (
            <Button
              key={provider}
              variant="primary"
              loading={connecting === provider}
              onClick={() => onConnect(provider)}
              icon={
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: '50%',
                    background: meta.color,
                    display: 'inline-block',
                  }}
                />
              }
            >
              Connect {meta.label}
            </Button>
          );
        })}
      </div>
    </GlassPanel>
  );
}
