import { NavLink, Outlet, useLocation } from 'react-router-dom';

interface AdminTab {
  label: string;
  to: string;
}

const adminTabs: AdminTab[] = [
  { label: 'Customers', to: '/admin/customers' },
  { label: 'CDRs',      to: '/admin/cdrs' },
  { label: 'Rates',     to: '/admin/rates' },
  { label: 'Tiers',     to: '/admin/tiers' },
  { label: 'Carriers',  to: '/admin/carriers' },
  { label: 'SIPp Test', to: '/admin/sipp' },
  { label: 'Homer',     to: '/admin/homer' },
];

const ADMIN_ACCENT = '#3b82f6';

export function AdminPage() {
  const location = useLocation();
  const isAdminRoot = location.pathname === '/admin' || location.pathname === '/admin/';

  return (
    <div>
      {/* Page header */}
      <div
        style={{
          marginBottom: 32,
          paddingBottom: 28,
          borderBottom: '1px solid rgba(42,47,69,0.6)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          {/* Admin icon badge */}
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: `linear-gradient(135deg, ${ADMIN_ACCENT}20 0%, ${ADMIN_ACCENT}10 100%)`,
              border: `1px solid ${ADMIN_ACCENT}30`,
              color: ADMIN_ACCENT,
              flexShrink: 0,
            }}
            aria-hidden="true"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ width: 22, height: 22 }}>
              <path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7 7 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a7 7 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a7 7 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a7 7 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>

          <div>
            <h1
              style={{
                fontSize: '1.75rem',
                fontWeight: 800,
                letterSpacing: '-0.025em',
                color: '#e2e8f0',
                lineHeight: 1.15,
                margin: 0,
              }}
            >
              Administration
            </h1>
          </div>
        </div>
        <p
          style={{
            fontSize: '0.9rem',
            color: '#718096',
            lineHeight: 1.6,
            maxWidth: 560,
            marginTop: 4,
          }}
        >
          Manage customers, billing, carriers, and platform configuration
        </p>
      </div>

      {/* Tab nav */}
      <nav
        style={{
          display: 'flex',
          gap: 0,
          borderBottom: '1px solid rgba(42,47,69,0.6)',
          marginBottom: 32,
          overflowX: 'auto',
        }}
        role="tablist"
        aria-label="Admin sections"
      >
        {adminTabs.map((tab) => {
          const isActive =
            location.pathname === tab.to ||
            (tab.to === '/admin/customers' && isAdminRoot);

          return (
            <NavLink
              key={tab.to}
              to={tab.to}
              role="tab"
              aria-selected={isActive}
              style={{
                padding: '10px 18px',
                fontSize: '0.875rem',
                fontWeight: isActive ? 600 : 500,
                whiteSpace: 'nowrap',
                textDecoration: 'none',
                borderBottom: `2px solid ${isActive ? ADMIN_ACCENT : 'transparent'}`,
                marginBottom: -1,
                color: isActive ? ADMIN_ACCENT : '#718096',
                transition: 'color 0.15s, border-color 0.15s',
                position: 'relative',
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  (e.currentTarget as HTMLAnchorElement).style.color = '#cbd5e0';
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  (e.currentTarget as HTMLAnchorElement).style.color = '#718096';
                }
              }}
            >
              {/* Active tab glow dot */}
              {isActive && (
                <span
                  style={{
                    position: 'absolute',
                    bottom: -1,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    width: 4,
                    height: 4,
                    borderRadius: '50%',
                    background: ADMIN_ACCENT,
                    boxShadow: `0 0 6px ${ADMIN_ACCENT}`,
                  }}
                />
              )}
              {tab.label}
            </NavLink>
          );
        })}
      </nav>

      <Outlet />
    </div>
  );
}
