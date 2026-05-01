import { NavLink, Outlet, useLocation } from 'react-router-dom';

interface AdminTab {
  label: string;
  to: string;
}

const adminTabs: AdminTab[] = [
  { label: 'Onboarding',      to: '/admin/onboarding'      },
  { label: 'Customers',       to: '/admin/customers'       },
  { label: 'Customer Trunks', to: '/admin/trunks'          },
  { label: 'User Lookup',     to: '/admin/customers/users' },
];

const ACCENT = '#3b82f6';

export function AdminPage() {
  const location = useLocation();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 20 }}>

      {/* ── Glass-morphism header ── */}
      <div
        style={{
          position: 'relative',
          background: 'rgba(19, 21, 29, 0.72)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          border: '1px solid rgba(59,130,246,0.16)',
          borderRadius: 20,
          padding: '32px 36px 28px',
          marginBottom: 28,
          overflow: 'hidden',
          boxShadow: '0 8px 40px -12px rgba(0,0,0,0.55), 0 0 0 1px rgba(59,130,246,0.06)',
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
          {/* Keystone logo with glow */}
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
                src="/keystone_logo.png"
                alt="Keystone"
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
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: ACCENT,
                opacity: 0.8,
                marginBottom: 6,
              }}
            >
              Customer Management
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
              Customer Administration
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
              Manage customer accounts, trunks, and configurations
            </p>
          </div>
        </div>
      </div>

      {/* ── Tab navigation bar ── */}
      <div
        style={{
          background: 'rgba(19,21,29,0.7)',
          border: '1px solid rgba(42,47,69,0.5)',
          borderRadius: 12,
          padding: '6px 8px',
          marginBottom: 24,
          overflowX: 'auto',
        }}
      >
        <nav
          style={{ display: 'flex', justifyContent: 'center', gap: 4 }}
          role="tablist"
          aria-label="Customer management sections"
        >
          {adminTabs.map((tab) => {
            // Exact match, or sub-path match — but exclude cases where
            // a longer tab path is a better match (e.g. /admin/customers
            // should not match when /admin/customers/users is the actual tab).
            const hasMoreSpecificTab = adminTabs.some(
              (other) => other !== tab && other.to.startsWith(tab.to + '/') && location.pathname.startsWith(other.to),
            );
            const isActive = !hasMoreSpecificTab && (
              location.pathname === tab.to ||
              location.pathname.startsWith(tab.to + '/')
            );

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
      <style>{`
        @keyframes adminTabFadeIn {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0);   }
        }
      `}</style>
      <div
        key={location.pathname}
        style={{ animation: 'adminTabFadeIn 0.25s ease both' }}
      >
        <Outlet />
      </div>
    </div>
  );
}
