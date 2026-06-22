/**
 * Educational empty state shown when the user has no calendar connections.
 * Matches the TrunksPage/ProgrammableVoicePage quality bar: headline, 3 "how it works"
 * steps, a privacy reassurance pill, and the two Connect buttons.
 */
import { CalendarDays, Lock } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import type { CalendarProvider } from '../../types/calendar';
import { ALL_PROVIDERS, PROVIDER_META } from './providerMeta';

const ACCENT = '#2dd4bf';

interface CalendarEmptyStateProps {
  onConnect: (provider: CalendarProvider) => void;
  connecting: CalendarProvider | null;
}

function HowItWorksStep({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div style={{ display: 'flex', gap: 14, textAlign: 'left' }}>
      <div
        style={{
          flexShrink: 0,
          width: 30,
          height: 30,
          borderRadius: 9,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(45,212,191,0.12)',
          border: '1px solid rgba(45,212,191,0.3)',
          color: ACCENT,
          fontWeight: 800,
          fontSize: '0.85rem',
        }}
      >
        {n}
      </div>
      <div>
        <div style={{ fontSize: '0.88rem', fontWeight: 700, color: '#e2e8f0', marginBottom: 2 }}>{title}</div>
        <div style={{ fontSize: '0.8rem', color: '#718096', lineHeight: 1.5 }}>{body}</div>
      </div>
    </div>
  );
}

export function CalendarEmptyState({ onConnect, connecting }: CalendarEmptyStateProps) {
  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(30,33,48,0.6) 0%, rgba(19,21,29,0.7) 100%)',
        border: '1px solid rgba(42,47,69,0.5)',
        borderRadius: 18,
        padding: '48px 32px',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          width: 60,
          height: 60,
          borderRadius: 16,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 18,
          background: 'linear-gradient(135deg, rgba(45,212,191,0.15) 0%, rgba(45,212,191,0.05) 100%)',
          border: '1px solid rgba(45,212,191,0.25)',
          color: ACCENT,
        }}
      >
        <CalendarDays size={30} strokeWidth={1.8} />
      </div>

      <h2 style={{ fontSize: '1.3rem', fontWeight: 800, color: '#e2e8f0', marginBottom: 8 }}>
        Bring your calendars together
      </h2>
      <p style={{ fontSize: '0.9rem', color: '#94a3b8', maxWidth: 560, margin: '0 auto 8px', lineHeight: 1.6 }}>
        Connect your Google Calendar and Microsoft 365 (Outlook) accounts to view a single,
        unified schedule right inside Unified Comms. Read-only and private — we never change,
        create, or delete anything on your calendars.
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 22,
          maxWidth: 720,
          margin: '32px auto',
          textAlign: 'left',
        }}
      >
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
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 7,
          padding: '6px 14px',
          borderRadius: 999,
          background: 'rgba(45,212,191,0.08)',
          border: '1px solid rgba(45,212,191,0.22)',
          color: ACCENT,
          fontSize: '0.74rem',
          fontWeight: 600,
          marginBottom: 24,
        }}
      >
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
    </div>
  );
}
