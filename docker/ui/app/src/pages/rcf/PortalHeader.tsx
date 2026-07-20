/**
 * PortalHeader — a shared, centered page-header block (icon + title + optional
 * email + subtitle) with a per-product accent. It is NOT part of the RCF page
 * itself; it lives here and is re-exported from `pages/RcfPage.tsx` because four
 * other pages (Calendar, ProgrammableVoice, Trunks, Docs) import it from there.
 * Keep the export path stable.
 */

interface PortalHeaderProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  badgeVariant?: 'rcf' | 'api' | 'trunk' | 'calendar';
  userEmail?: string | null;
}

const ACCENT_BY_VARIANT: Record<string, string> = {
  rcf: '#3b82f6',
  api: '#a855f7',
  trunk: '#f59e0b',
  calendar: '#2dd4bf',
};

export function PortalHeader({ icon, title, subtitle, badgeVariant = 'rcf', userEmail }: PortalHeaderProps) {
  const accent = ACCENT_BY_VARIANT[badgeVariant] ?? '#3b82f6';

  return (
    <div style={{ marginBottom: 36, paddingTop: 8, paddingBottom: 28, borderBottom: '1px solid rgba(42,47,69,0.6)', textAlign: 'center' }}>
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 14,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: `linear-gradient(135deg, ${accent}20 0%, ${accent}10 100%)`,
          border: `1px solid ${accent}30`,
          color: accent,
          marginBottom: 14,
        }}
        aria-hidden="true"
      >
        {icon}
      </div>

      <h1 style={{ fontSize: '1.5rem', fontWeight: 800, letterSpacing: '-0.02em', color: '#e2e8f0', lineHeight: 1.15, margin: '0 0 6px' }}>{title}</h1>

      {userEmail && (
        <div style={{ fontSize: '0.78rem', color: accent, fontWeight: 600, letterSpacing: '0.01em', marginBottom: 6 }}>{userEmail}</div>
      )}

      <p style={{ fontSize: '0.85rem', color: '#718096', marginTop: 2, lineHeight: 1.6, maxWidth: 480, marginLeft: 'auto', marginRight: 'auto' }}>{subtitle}</p>
    </div>
  );
}
