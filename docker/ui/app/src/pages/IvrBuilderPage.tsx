import { PortalHeader } from './RcfPage';
import { useAuth } from '../contexts/AuthContext';
import { IconIVR } from '../components/icons/ProductIcons';

export function IvrBuilderPage() {
  useAuth(); // ensure authenticated
  return (
    <div>
      <PortalHeader
        icon={<IconIVR size={24} />}
        title="IVR Builder"
        subtitle="Visual drag-and-drop IVR flow designer."
        badgeVariant="rcf"
      />

      <div
        className="glass-surface"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '80px 24px',
          textAlign: 'center',
          borderRadius: 20,
        }}
      >
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 24,
            background: 'linear-gradient(135deg, rgba(59,130,246,0.15) 0%, rgba(59,130,246,0.05) 100%)',
            border: '1px solid rgba(59,130,246,0.25)',
            color: '#60a5fa',
            boxShadow: '0 0 24px rgba(59,130,246,0.18)',
          }}
        >
          <IconIVR size={32} />
        </div>

        <h2 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>
          Coming in Phase 2
        </h2>
        <p style={{ fontSize: '0.9rem', color: '#718096', maxWidth: 420, lineHeight: 1.6 }}>
          Visual IVR flow builder with drag-and-drop nodes, DTMF menus,
          time-based routing, and webhook integration are under active development.
        </p>
        <div
          style={{
            marginTop: 24,
            padding: '8px 16px',
            borderRadius: 8,
            background: 'rgba(59,130,246,0.08)',
            border: '1px solid rgba(59,130,246,0.2)',
            color: '#60a5fa',
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
