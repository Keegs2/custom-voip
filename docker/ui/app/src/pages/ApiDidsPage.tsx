import { PortalHeader } from './RcfPage';
import { useAuth } from '../contexts/AuthContext';
import { IconAPI } from '../components/icons/ProductIcons';

export function ApiDidsPage() {
  const { user } = useAuth();
  return (
    <div>
      <PortalHeader
        icon={<IconAPI size={24} />}
        title="API Calling"
        subtitle="Programmable voice with webhook-driven call control."
        badgeVariant="api"
        userEmail={user?.email}
      />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '80px 24px',
          textAlign: 'center',
          background: 'linear-gradient(135deg, rgba(30,33,48,0.6) 0%, rgba(19,21,29,0.7) 100%)',
          border: '1px solid rgba(42,47,69,0.4)',
          borderRadius: 16,
        }}
      >
        {/* Icon */}
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 24,
            background: 'linear-gradient(135deg, rgba(168,85,247,0.15) 0%, rgba(168,85,247,0.05) 100%)',
            border: '1px solid rgba(168,85,247,0.25)',
            color: '#a855f7',
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ width: 32, height: 32 }}>
            <path d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        <h2 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>
          Coming in Phase 2
        </h2>
        <p style={{ fontSize: '0.9rem', color: '#718096', maxWidth: 420, lineHeight: 1.6 }}>
          Programmable voice APIs with webhook-driven call control, real-time event callbacks,
          and full DTMF/recording support are under active development.
        </p>
        <div
          style={{
            marginTop: 24,
            padding: '8px 16px',
            borderRadius: 8,
            background: 'rgba(168,85,247,0.08)',
            border: '1px solid rgba(168,85,247,0.2)',
            color: '#c084fc',
            fontSize: '0.8rem',
            fontWeight: 600,
            letterSpacing: '0.02em',
          }}
        >
          Under Construction
        </div>
      </div>
    </div>
  );
}
