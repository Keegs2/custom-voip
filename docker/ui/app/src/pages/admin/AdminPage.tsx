import { NavLink, Outlet, useLocation } from 'react-router-dom';

interface AdminTab {
  label: string;
  to: string;
}

const adminTabs: AdminTab[] = [
  { label: 'Customers',       to: '/admin/customers' },
  { label: 'Customer Trunks', to: '/admin/trunks' },
  { label: 'Carrier Trunks',  to: '/admin/carriers' },
  { label: 'CDRs',            to: '/admin/cdrs' },
  { label: 'Rates',           to: '/admin/rates' },
  { label: 'Tiers',           to: '/admin/tiers' },
  { label: 'SIPp Test',       to: '/admin/sipp' },
];

const ADMIN_ACCENT = '#3b82f6';

export function AdminPage() {
  const location = useLocation();
  const isAdminRoot = location.pathname === '/admin' || location.pathname === '/admin/';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', paddingTop: 8 }}>

      {/* ── Centered header ── */}
      <div
        style={{
          marginBottom: 28,
          paddingTop: 8,
          paddingBottom: 28,
          borderBottom: '1px solid rgba(42,47,69,0.6)',
          textAlign: 'center',
        }}
      >
        {/* Icon badge — centered */}
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 14,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: `linear-gradient(135deg, ${ADMIN_ACCENT}20 0%, ${ADMIN_ACCENT}10 100%)`,
            border: `1px solid ${ADMIN_ACCENT}30`,
            color: ADMIN_ACCENT,
            marginBottom: 14,
          }}
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            style={{ width: 22, height: 22 }}
          >
            <path
              d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7 7 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a7 7 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a7 7 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a7 7 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        {/* Title */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 6 }}>
          <h1
            style={{
              fontSize: '1.5rem',
              fontWeight: 800,
              letterSpacing: '-0.02em',
              color: '#e2e8f0',
              lineHeight: 1.15,
              margin: 0,
            }}
          >
            Administration
          </h1>
        </div>

        {/* Subtitle */}
        <p style={{ fontSize: '0.82rem', color: '#718096', margin: 0, marginLeft: 'auto', marginRight: 'auto' }}>
          Platform management and configuration
        </p>
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
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: 4,
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
                  padding: '8px 18px',
                  fontSize: '0.85rem',
                  fontWeight: isActive ? 600 : 500,
                  whiteSpace: 'nowrap',
                  textDecoration: 'none',
                  borderRadius: 8,
                  color: isActive ? '#e2e8f0' : '#718096',
                  background: isActive
                    ? `linear-gradient(135deg, ${ADMIN_ACCENT}22 0%, ${ADMIN_ACCENT}10 100%)`
                    : 'transparent',
                  border: isActive
                    ? `1px solid ${ADMIN_ACCENT}40`
                    : '1px solid transparent',
                  boxShadow: isActive
                    ? `0 0 12px ${ADMIN_ACCENT}18, inset 0 1px 0 rgba(255,255,255,0.04)`
                    : 'none',
                  transition: 'color 0.15s, background 0.15s, border-color 0.15s, box-shadow 0.15s',
                  letterSpacing: isActive ? '0.005em' : undefined,
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
                {/* Active accent dot at bottom */}
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
                      background: ADMIN_ACCENT,
                      boxShadow: `0 0 5px ${ADMIN_ACCENT}`,
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
