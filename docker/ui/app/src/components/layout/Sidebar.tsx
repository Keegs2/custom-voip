import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { cn } from '../../utils/cn';

interface NavItem {
  label: string;
  to: string;
  color: string;
  icon: React.ReactNode;
}

/* ─── SVG Icons (Heroicons outline, 18×18) ──────────────── */

const IconRCF = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ width: 18, height: 18 }}>
    <path d="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconAPI = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ width: 18, height: 18 }}>
    <path d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconTrunk = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ width: 18, height: 18 }}>
    <path d="M5.25 14.25h13.5m-13.5 0a3 3 0 0 1-3-3m3 3a3 3 0 1 0 0 6h13.5a3 3 0 1 0 0-6m-16.5-3a3 3 0 0 1 3-3h13.5a3 3 0 0 1 3 3m-19.5 0a4.5 4.5 0 0 1 .9-2.7L5.737 5.1a3.375 3.375 0 0 1 2.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 0 1 .9 2.7m0 0a3 3 0 0 1-3 3m0 3h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Zm-3 6h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconIVR = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ width: 18, height: 18 }}>
    <path d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25a2.25 2.25 0 0 1-2.25-2.25v-2.25Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconDocs = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ width: 18, height: 18 }}>
    <path d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconAdmin = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ width: 18, height: 18 }}>
    <path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7 7 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a7 7 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a7 7 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a7 7 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const productNavItems: NavItem[] = [
  { label: 'RCF',         icon: <IconRCF />,   to: '/rcf',      color: '#4ade80' },
  { label: 'SIP Trunks', icon: <IconTrunk />, to: '/trunks',   color: '#fbbf24' },
  { label: 'API Calling', icon: <IconAPI />,   to: '/api-dids', color: '#c084fc' },
  { label: 'IVR Builder', icon: <IconIVR />,   to: '/ivr',      color: '#22d3ee' },
  { label: 'API Docs',   icon: <IconDocs />,  to: '/docs',     color: '#94a3b8' },
];

interface SidebarNavItemProps {
  item: NavItem;
  onNavigate?: () => void;
}

function SidebarNavItem({ item, onNavigate }: SidebarNavItemProps) {
  return (
    <NavLink
      to={item.to}
      onClick={onNavigate}
      className="block no-underline"
      style={({ isActive }) => ({
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 14px',
        borderRadius: 10,
        fontSize: '0.875rem',
        fontWeight: isActive ? 600 : 500,
        letterSpacing: '-0.01em',
        cursor: 'pointer',
        userSelect: 'none',
        transition: 'background 0.15s, color 0.15s, box-shadow 0.15s',
        textDecoration: 'none',
        // Active: filled pill with accent glow; inactive: muted
        color: isActive ? '#f1f5f9' : '#64748b',
        background: isActive
          ? `linear-gradient(135deg, ${item.color}22 0%, ${item.color}10 100%)`
          : 'transparent',
        boxShadow: isActive
          ? `0 0 0 1px ${item.color}35, 0 2px 12px -4px ${item.color}40`
          : 'none',
      })}
    >
      {({ isActive }) => (
        <>
          {/* Icon container */}
          <span
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              background: isActive
                ? `linear-gradient(135deg, ${item.color}30 0%, ${item.color}18 100%)`
                : 'rgba(255,255,255,0.04)',
              border: isActive
                ? `1px solid ${item.color}40`
                : '1px solid rgba(255,255,255,0.06)',
              color: isActive ? item.color : '#475569',
              transition: 'background 0.15s, border-color 0.15s, color 0.15s',
            }}
          >
            {item.icon}
          </span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.label}
          </span>
          {/* Active indicator dot */}
          {isActive && (
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: '50%',
                background: item.color,
                flexShrink: 0,
                boxShadow: `0 0 6px ${item.color}`,
              }}
            />
          )}
        </>
      )}
    </NavLink>
  );
}

export function Sidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();

  const handleBrandClick = () => {
    navigate('/');
    setMobileOpen(false);
  };

  const closeMobile = () => setMobileOpen(false);

  return (
    <>
      {/* Mobile topbar */}
      <div
        style={{
          display: 'none',
          alignItems: 'center',
          gap: 12,
          padding: '0 20px',
          height: 56,
          background: '#0a0c12',
          borderBottom: '1px solid rgba(42, 47, 69, 0.8)',
          position: 'sticky',
          top: 0,
          zIndex: 50,
        }}
        className="md:hidden"
      >
        <button
          type="button"
          onClick={() => setMobileOpen((o) => !o)}
          style={{
            color: '#e2e8f0',
            padding: '6px 8px',
            borderRadius: 8,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontSize: 18,
            lineHeight: 1,
          }}
          aria-label="Toggle navigation"
        >
          ☰
        </button>
        <span
          style={{
            fontSize: '0.875rem',
            fontWeight: 800,
            color: '#e2e8f0',
            letterSpacing: '-0.02em',
            textShadow: '0 0 20px rgba(59, 130, 246, 0.5)',
          }}
        >
          Custom <span style={{ color: '#3b82f6' }}>VoIP</span>
        </span>
      </div>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          onClick={closeMobile}
          aria-hidden="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.65)',
            zIndex: 40,
            backdropFilter: 'blur(4px)',
          }}
          className="md:hidden"
        />
      )}

      {/* Sidebar panel */}
      <aside
        className={cn(
          'fixed top-0 left-0 bottom-0 z-[100]',
          'flex flex-col',
          'md:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        )}
        style={{
          width: 240,
          background: 'linear-gradient(180deg, #0c0e16 0%, #0a0c13 100%)',
          borderRight: '1px solid rgba(42, 47, 69, 0.7)',
          transition: 'transform 250ms ease-in-out',
        }}
        aria-label="Main navigation"
      >
        {/* Brand area */}
        <div
          onClick={handleBrandClick}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && handleBrandClick()}
          style={{
            padding: '28px 20px 22px',
            cursor: 'pointer',
            userSelect: 'none',
            position: 'relative',
          }}
        >
          {/* Subtle blue ambient glow behind the brand */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: 80,
              background: 'radial-gradient(ellipse 140% 100% at 50% 0%, rgba(59,130,246,0.10) 0%, transparent 70%)',
              pointerEvents: 'none',
            }}
          />

          {/* Logo mark + wordmark */}
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Logo mark: small blue diamond */}
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 9,
                background: 'linear-gradient(135deg, #2563eb 0%, #3b82f6 60%, #60a5fa 100%)',
                boxShadow: '0 0 16px rgba(59, 130, 246, 0.45), 0 2px 8px rgba(0,0,0,0.4)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              {/* Phone icon */}
              <svg viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={2} style={{ width: 16, height: 16 }}>
                <path d="M2.25 6.338c0 12.03 9.716 21.75 21.75 21.75" strokeLinecap="round" strokeLinejoin="round" />
                <path d="m2.25 6.338 3.56-3.56a1.5 1.5 0 0 1 2.121 0l2.296 2.296a1.5 1.5 0 0 1 0 2.122l-1.054 1.053c-.226.226-.296.56-.144.849a13.478 13.478 0 0 0 5.636 5.635c.29.153.624.083.85-.143l1.053-1.054a1.5 1.5 0 0 1 2.122 0l2.296 2.296a1.5 1.5 0 0 1 0 2.121l-3.56 3.56" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>

            {/* Text */}
            <div>
              <div
                style={{
                  fontSize: '1rem',
                  fontWeight: 800,
                  letterSpacing: '-0.03em',
                  lineHeight: 1.15,
                  color: '#f1f5f9',
                  textShadow: '0 0 28px rgba(59, 130, 246, 0.35)',
                }}
              >
                Custom <span style={{ color: '#60a5fa' }}>VoIP</span>
              </div>
              <div
                style={{
                  fontSize: '0.625rem',
                  fontWeight: 600,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: '#334155',
                  marginTop: 1,
                }}
              >
                Voice Platform
              </div>
            </div>
          </div>
        </div>

        {/* Divider with gradient fade */}
        <div
          style={{
            margin: '0 16px',
            height: 1,
            background: 'linear-gradient(90deg, transparent, rgba(42, 47, 69, 0.8) 20%, rgba(42, 47, 69, 0.8) 80%, transparent)',
          }}
        />

        {/* Nav */}
        <nav
          style={{
            flex: 1,
            padding: '20px 12px',
            overflowY: 'auto',
          }}
        >
          <div
            style={{
              fontSize: '0.6rem',
              fontWeight: 700,
              color: '#334155',
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              padding: '0 14px',
              marginBottom: 8,
            }}
          >
            Products
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {productNavItems.map((item) => (
              <SidebarNavItem key={item.to} item={item} onNavigate={closeMobile} />
            ))}
          </div>
        </nav>

        {/* Divider before footer */}
        <div
          style={{
            margin: '0 16px',
            height: 1,
            background: 'linear-gradient(90deg, transparent, rgba(42, 47, 69, 0.7) 20%, rgba(42, 47, 69, 0.7) 80%, transparent)',
          }}
        />

        {/* Footer */}
        <div style={{ padding: '14px 12px 18px' }}>
          <NavLink
            to="/admin"
            onClick={closeMobile}
            className="block no-underline"
            style={({ isActive }) => ({
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '9px 14px',
              borderRadius: 10,
              fontSize: '0.875rem',
              fontWeight: isActive ? 600 : 500,
              letterSpacing: '-0.01em',
              cursor: 'pointer',
              userSelect: 'none',
              transition: 'background 0.15s, color 0.15s, box-shadow 0.15s',
              textDecoration: 'none',
              color: isActive ? '#f1f5f9' : '#64748b',
              background: isActive
                ? 'linear-gradient(135deg, rgba(59,130,246,0.18) 0%, rgba(59,130,246,0.08) 100%)'
                : 'transparent',
              boxShadow: isActive
                ? '0 0 0 1px rgba(59,130,246,0.30), 0 2px 12px -4px rgba(59,130,246,0.30)'
                : 'none',
            })}
          >
            {({ isActive }) => (
              <>
                <span
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 8,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    background: isActive
                      ? 'linear-gradient(135deg, rgba(59,130,246,0.30) 0%, rgba(59,130,246,0.18) 100%)'
                      : 'rgba(255,255,255,0.04)',
                    border: isActive
                      ? '1px solid rgba(59,130,246,0.40)'
                      : '1px solid rgba(255,255,255,0.06)',
                    color: isActive ? '#60a5fa' : '#475569',
                    transition: 'background 0.15s, border-color 0.15s, color 0.15s',
                  }}
                >
                  <IconAdmin />
                </span>
                <span style={{ flex: 1 }}>Administration</span>
                {isActive && (
                  <span
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: '50%',
                      background: '#3b82f6',
                      flexShrink: 0,
                      boxShadow: '0 0 6px #3b82f6',
                    }}
                  />
                )}
              </>
            )}
          </NavLink>

          <div
            style={{
              padding: '10px 14px 0',
              fontSize: '0.625rem',
              color: '#1e293b',
              fontWeight: 600,
              letterSpacing: '0.04em',
            }}
          >
            v1.0 &middot; Voice Platform
          </div>
        </div>
      </aside>
    </>
  );
}
