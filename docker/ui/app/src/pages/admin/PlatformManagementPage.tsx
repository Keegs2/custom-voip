import { useLocation, NavLink, Outlet } from 'react-router-dom';

interface PlatformTab {
  label: string;
  to: string;
}

const platformTabs: PlatformTab[] = [
  { label: 'Carrier Trunks', to: '/admin/platform/carriers' },
  { label: 'CDRs',           to: '/admin/platform/cdrs'     },
  { label: 'Rates',          to: '/admin/platform/rates'    },
  { label: 'Tiers',          to: '/admin/platform/tiers'    },
  { label: 'Testing',        to: '/admin/platform/sipp'     },
  { label: 'DID Search',     to: '/admin/platform/dids'     },
];

const ACCENT = '#3b82f6';

export function PlatformManagementPage() {
  const location = useLocation();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 20 }}>

      {/* ── Glass-morphism header ── */}
      <div
        className="glass-header"
        style={{
          padding: '32px 36px 28px',
          marginBottom: 28,
          overflow: 'hidden',
        }}
      >
        {/* Top accent gradient line */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 48,
            right: 48,
            height: 2,
            background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.7), transparent)',
            borderRadius: '0 0 2px 2px',
          }}
        />

        {/* Corner radial glow */}
        <div
          style={{
            position: 'absolute',
            top: -60,
            right: -60,
            width: 280,
            height: 280,
            background: 'radial-gradient(circle, rgba(59,130,246,0.07) 0%, transparent 70%)',
            pointerEvents: 'none',
          }}
        />

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 24, position: 'relative' }}>
          {/* CRAG logo with glow */}
          <div style={{ flexShrink: 0 }}>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: 14,
                background: 'linear-gradient(135deg, rgba(59,130,246,0.18) 0%, rgba(59,130,246,0.08) 100%)',
                border: '1px solid rgba(59,130,246,0.28)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 0 24px rgba(59,130,246,0.20)',
              }}
            >
              <img
                src="/crag.png"
                alt="CRAG"
                style={{
                  width: 40,
                  height: 40,
                  objectFit: 'contain',
                  filter: 'drop-shadow(0 0 8px rgba(59,130,246,0.55)) brightness(1.1)',
                }}
              />
            </div>
          </div>

          {/* Title block */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: '0.6rem',
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: ACCENT,
                opacity: 0.8,
                marginBottom: 6,
              }}
            >
              Platform Management
            </div>
            <h1
              style={{
                fontSize: 'clamp(1.2rem, 2.5vw, 1.55rem)',
                fontWeight: 800,
                color: '#e2e8f0',
                letterSpacing: '-0.025em',
                lineHeight: 1.15,
                margin: '0 0 8px',
              }}
            >
              Platform Configuration
            </h1>
            <p
              style={{
                fontSize: '0.85rem',
                color: '#718096',
                lineHeight: 1.65,
                margin: 0,
                maxWidth: 500,
              }}
            >
              Carrier trunks, CDR management, rates, tiers, and testing tools
            </p>
          </div>
        </div>
      </div>

      {/* ── Tab navigation bar ── */}
      <div
        className="glass-surface"
        style={{
          borderRadius: 12,
          padding: '6px 8px',
          marginBottom: 24,
          overflowX: 'auto',
        }}
      >
        <nav
          style={{ display: 'flex', justifyContent: 'center', gap: 4 }}
          role="tablist"
          aria-label="Platform sections"
        >
          {platformTabs.map((tab) => {
            const isActive = location.pathname === tab.to || location.pathname.startsWith(tab.to + '/');

            return (
              <NavLink
                key={tab.to}
                to={tab.to}
                role="tab"
                aria-selected={isActive}
                style={{
                  padding: '8px 18px',
                  fontSize: '0.85rem',
                  fontWeight: isActive ? 600 : 500,
                  whiteSpace: 'nowrap',
                  textDecoration: 'none',
                  borderRadius: 8,
                  color: isActive ? '#e2e8f0' : '#718096',
                  background: isActive
                    ? `linear-gradient(135deg, ${ACCENT}22 0%, ${ACCENT}10 100%)`
                    : 'transparent',
                  border: isActive
                    ? `1px solid ${ACCENT}40`
                    : '1px solid transparent',
                  boxShadow: isActive
                    ? `0 0 12px ${ACCENT}18, inset 0 1px 0 rgba(255,255,255,0.04)`
                    : 'none',
                  transition: 'color 0.15s, background 0.15s, border-color 0.15s, box-shadow 0.15s',
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    const el = e.currentTarget as HTMLAnchorElement;
                    el.style.color = '#cbd5e0';
                    el.style.background = 'rgba(255,255,255,0.04)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    const el = e.currentTarget as HTMLAnchorElement;
                    el.style.color = '#718096';
                    el.style.background = 'transparent';
                  }
                }}
              >
                {isActive && (
                  <span
                    style={{
                      position: 'absolute',
                      bottom: 3,
                      left: '50%',
                      transform: 'translateX(-50%)',
                      width: 3,
                      height: 3,
                      borderRadius: '50%',
                      background: ACCENT,
                      boxShadow: `0 0 5px ${ACCENT}`,
                    }}
                    aria-hidden="true"
                  />
                )}
                {tab.label}
              </NavLink>
            );
          })}
        </nav>
      </div>

      {/* ── Page content ── */}
      <Outlet />
    </div>
  );
}
