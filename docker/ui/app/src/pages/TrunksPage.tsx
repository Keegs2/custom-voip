import { PortalHeader } from './RcfPage';
import { useAuth } from '../contexts/AuthContext';
import { IconTrunk } from '../components/icons/ProductIcons';

export function TrunksPage() {
  const { user } = useAuth();
  return (
    <div>
      <PortalHeader
        icon={<IconTrunk size={24} />}
        title={user?.customer_name ? `${user.customer_name}'s SIP Trunks` : 'SIP Trunks'}
        subtitle="Enterprise SIP trunking with IP-based authentication and channel management."
        badgeVariant="trunk"
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
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 24,
            background: 'linear-gradient(135deg, rgba(251,191,36,0.15) 0%, rgba(251,191,36,0.05) 100%)',
            border: '1px solid rgba(251,191,36,0.25)',
            color: '#fbbf24',
          }}
        >
          <IconTrunk size={32} />
        </div>

        <h2 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#e2e8f0', marginBottom: 8 }}>
          Coming in Phase 2
        </h2>
        <p style={{ fontSize: '0.9rem', color: '#718096', maxWidth: 420, lineHeight: 1.6 }}>
          SIP trunk provisioning with IP-based authentication, per-trunk channel limits,
          CPS enforcement, and real-time trunk monitoring are under active development.
        </p>
        <div
          style={{
            marginTop: 24,
            padding: '8px 16px',
            borderRadius: 8,
            background: 'rgba(251,191,36,0.08)',
            border: '1px solid rgba(251,191,36,0.2)',
            color: '#fbbf24',
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
