import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { cn } from '../../utils/cn';
import { useAuth } from '../../contexts/AuthContext';
import { useSoftphone } from '../../contexts/SoftphoneContext';
import { useChat } from '../../contexts/ChatContext';
import { PresenceIndicator } from '../softphone/PresenceIndicator';
import type { PresenceStatus } from '../../types/softphone';

interface NavItem {
  label: string;
  to: string;
  color: string;
  icon: React.ReactNode;
}

/* ─── SVG Icons (Heroicons outline, 18×18) ──────────────── */

import {
  IconRCF, IconTrunk, IconAPI, IconIVR, IconDocs,
  IconAdmin, IconSignal, IconTroubleshoot, IconVoicemail,
} from '../icons/ProductIcons';
import { FolderOpen } from 'lucide-react';

const PRESENCE_OPTIONS: { value: PresenceStatus; label: string; color: string }[] = [
  { value: 'available', label: 'Available',      color: '#22c55e' },
  { value: 'away',      label: 'Away',           color: '#f59e0b' },
  { value: 'busy',      label: 'Busy',           color: '#ef4444' },
  { value: 'dnd',       label: 'Do Not Disturb', color: '#ef4444' },
  { value: 'offline',   label: 'Appear Offline', color: '#64748b' },
];

const IconSignOut = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ width: 14, height: 14 }}>
    <path d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

interface NavItemDef extends NavItem {
  /** Which account_types can see this item. undefined = everyone */
  accountTypes?: string[];
  /** Only admins can see this item */
  adminOnly?: boolean;
}

const allProductNavItems: NavItemDef[] = [
  { label: 'RCF',         icon: <IconRCF size={18} />,   to: '/rcf',      color: '#4ade80', accountTypes: ['rcf', 'hybrid'] },
  { label: 'SIP Trunks', icon: <IconTrunk size={18} />, to: '/trunks',   color: '#fbbf24', accountTypes: ['trunk', 'hybrid'] },
  { label: 'API Calling', icon: <IconAPI size={18} />,   to: '/api-dids', color: '#c084fc', adminOnly: true },
  { label: 'IVR Builder', icon: <IconIVR size={18} />,   to: '/ivr',      color: '#22d3ee', accountTypes: ['ucaas', 'hybrid'] },
  { label: 'API Docs',   icon: <IconDocs size={18} />,  to: '/documentation', color: '#94a3b8' },
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
  const [showPresenceMenu, setShowPresenceMenu] = useState(false);
  const navigate = useNavigate();
  const { user, isAdmin, logout } = useAuth();
  const { presence, setPresence, unreadVoicemailCount, credentials } = useSoftphone();
  const { totalUnread: unreadChatCount } = useChat();

  const handleBrandClick = () => {
    navigate('/');
    setMobileOpen(false);
  };

  const closeMobile = () => setMobileOpen(false);

  // Display name: prefer user.name, fall back to email prefix
  const displayName = user?.name || user?.email?.split('@')[0] || '';
  const displayEmail = user?.email ?? '';

  // UCaaS access: admins (no account_type) always get it; ucaas customers always get it;
  // api/trunk/hybrid customers only when ucaas_enabled is true; rcf never.
  const hasUcaas =
    user?.role === 'admin' ||
    user?.account_type === 'ucaas' ||
    (user?.account_type !== 'rcf' && user?.ucaas_enabled === true);

  // Filter nav items based on role and account_type
  const isSupport = user?.role === 'readonly';
  const productNavItems = allProductNavItems.filter((item) => {
    // Admins and support see all products
    if (isAdmin || isSupport) return true;
    // Admin-only items hidden for regular customer users
    if (item.adminOnly) return false;
    // If item has accountTypes restriction, check the user's account_type
    if (item.accountTypes && user?.account_type) {
      return item.accountTypes.includes(user.account_type);
    }
    // No restriction — show to all
    return !item.accountTypes;
  });
  // Customer users see their customer name as a context label
  const contextLabel = user?.customer_name ?? null;

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

          {/* Communications (Chat, Voicemail) — Chat requires UCaaS access only;
              Voicemail additionally requires a phone extension.
              Never shown to RCF customers. */}
          {hasUcaas && (
            <>
              <div
                style={{
                  fontSize: '0.6rem',
                  fontWeight: 700,
                  color: '#334155',
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                  padding: '0 14px',
                  marginTop: 16,
                  marginBottom: 8,
                }}
              >
                Communications
              </div>

              {/* Chat — visible to all UCaaS users; does not require an extension */}
              <NavLink
                to="/chat"
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
                      {/* Chat bubble icon */}
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} style={{ width: 16, height: 16 }}>
                        <path d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    <span style={{ flex: 1 }}>Chat</span>
                    {/* Unread badge */}
                    {unreadChatCount > 0 && (
                      <span
                        style={{
                          minWidth: 18,
                          height: 18,
                          borderRadius: 9,
                          background: '#3b82f6',
                          color: '#fff',
                          fontSize: '0.6rem',
                          fontWeight: 700,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: '0 4px',
                          flexShrink: 0,
                          letterSpacing: '0.02em',
                        }}
                      >
                        {unreadChatCount > 99 ? '99+' : unreadChatCount}
                      </span>
                    )}
                    {isActive && unreadChatCount === 0 && (
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

              {/* Conferences — visible to all UCaaS users */}
              <NavLink
                to="/conference"
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
                    ? 'linear-gradient(135deg, rgba(34,197,94,0.14) 0%, rgba(34,197,94,0.07) 100%)'
                    : 'transparent',
                  boxShadow: isActive
                    ? '0 0 0 1px rgba(34,197,94,0.25), 0 2px 12px -4px rgba(34,197,94,0.25)'
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
                          ? 'linear-gradient(135deg, rgba(34,197,94,0.28) 0%, rgba(34,197,94,0.16) 100%)'
                          : 'rgba(255,255,255,0.04)',
                        border: isActive
                          ? '1px solid rgba(34,197,94,0.38)'
                          : '1px solid rgba(255,255,255,0.06)',
                        color: isActive ? '#4ade80' : '#475569',
                        transition: 'background 0.15s, border-color 0.15s, color 0.15s',
                      }}
                    >
                      {/* Video camera icon */}
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} style={{ width: 16, height: 16 }}>
                        <path d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    <span style={{ flex: 1 }}>Conferences</span>
                    {isActive && (
                      <span
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: '50%',
                          background: '#4ade80',
                          flexShrink: 0,
                          boxShadow: '0 0 6px #4ade80',
                        }}
                      />
                    )}
                  </>
                )}
              </NavLink>

              {/* Documents — visible to all UCaaS users */}
              <NavLink
                to="/documents"
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
                    ? 'linear-gradient(135deg, rgba(251,191,36,0.14) 0%, rgba(251,191,36,0.07) 100%)'
                    : 'transparent',
                  boxShadow: isActive
                    ? '0 0 0 1px rgba(251,191,36,0.25), 0 2px 12px -4px rgba(251,191,36,0.25)'
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
                          ? 'linear-gradient(135deg, rgba(251,191,36,0.28) 0%, rgba(251,191,36,0.16) 100%)'
                          : 'rgba(255,255,255,0.04)',
                        border: isActive
                          ? '1px solid rgba(251,191,36,0.38)'
                          : '1px solid rgba(255,255,255,0.06)',
                        color: isActive ? '#fbbf24' : '#475569',
                        transition: 'background 0.15s, border-color 0.15s, color 0.15s',
                      }}
                    >
                      <FolderOpen size={15} strokeWidth={1.8} />
                    </span>
                    <span style={{ flex: 1 }}>Documents</span>
                    {isActive && (
                      <span
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: '50%',
                          background: '#fbbf24',
                          flexShrink: 0,
                          boxShadow: '0 0 6px #fbbf24',
                        }}
                      />
                    )}
                  </>
                )}
              </NavLink>

              {/* Voicemail — requires a phone extension in addition to UCaaS access */}
              {credentials && (
                <NavLink
                  to="/voicemail"
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
                      ? 'linear-gradient(135deg, rgba(99,102,241,0.18) 0%, rgba(99,102,241,0.08) 100%)'
                      : 'transparent',
                    boxShadow: isActive
                      ? '0 0 0 1px rgba(99,102,241,0.30), 0 2px 12px -4px rgba(99,102,241,0.30)'
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
                            ? 'linear-gradient(135deg, rgba(99,102,241,0.30) 0%, rgba(99,102,241,0.18) 100%)'
                            : 'rgba(255,255,255,0.04)',
                          border: isActive
                            ? '1px solid rgba(99,102,241,0.40)'
                            : '1px solid rgba(255,255,255,0.06)',
                          color: isActive ? '#818cf8' : '#475569',
                          transition: 'background 0.15s, border-color 0.15s, color 0.15s',
                        }}
                      >
                        <IconVoicemail size={16} />
                      </span>
                      <span style={{ flex: 1 }}>Voicemail</span>
                      {/* Unread badge */}
                      {unreadVoicemailCount > 0 && (
                        <span
                          style={{
                            minWidth: 18,
                            height: 18,
                            borderRadius: 9,
                            background: '#ef4444',
                            color: '#fff',
                            fontSize: '0.6rem',
                            fontWeight: 700,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: '0 4px',
                            flexShrink: 0,
                            letterSpacing: '0.02em',
                          }}
                        >
                          {unreadVoicemailCount > 99 ? '99+' : unreadVoicemailCount}
                        </span>
                      )}
                      {isActive && unreadVoicemailCount === 0 && (
                        <span
                          style={{
                            width: 5,
                            height: 5,
                            borderRadius: '50%',
                            background: '#818cf8',
                            flexShrink: 0,
                            boxShadow: '0 0 6px #818cf8',
                          }}
                        />
                      )}
                    </>
                  )}
                </NavLink>
              )}
            </>
          )}
        </nav>

        {/* Divider before footer */}
        <div
          style={{
            margin: '0 16px',
            height: 1,
            background: 'linear-gradient(90deg, transparent, rgba(42, 47, 69, 0.7) 20%, rgba(42, 47, 69, 0.7) 80%, transparent)',
          }}
        />

        {/* Footer nav links */}
        <div style={{ padding: '14px 12px 0' }}>
          {/* Administration — only visible to admins */}
          {isAdmin && (
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
          )}

          {/* Call Quality — admins and support only */}
          {(isAdmin || user?.role === 'readonly') && <NavLink
            to="/call-quality"
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
              marginTop: isAdmin ? 4 : 0,
              color: isActive ? '#f1f5f9' : '#64748b',
              background: isActive
                ? 'linear-gradient(135deg, rgba(34,197,94,0.18) 0%, rgba(34,197,94,0.08) 100%)'
                : 'transparent',
              boxShadow: isActive
                ? '0 0 0 1px rgba(34,197,94,0.30), 0 2px 12px -4px rgba(34,197,94,0.30)'
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
                      ? 'linear-gradient(135deg, rgba(34,197,94,0.30) 0%, rgba(34,197,94,0.18) 100%)'
                      : 'rgba(255,255,255,0.04)',
                    border: isActive
                      ? '1px solid rgba(34,197,94,0.40)'
                      : '1px solid rgba(255,255,255,0.06)',
                    color: isActive ? '#22c55e' : '#475569',
                    transition: 'background 0.15s, border-color 0.15s, color 0.15s',
                  }}
                >
                  <IconSignal size={18} />
                </span>
                <span style={{ flex: 1 }}>Call Quality</span>
                {isActive && (
                  <span
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: '50%',
                      background: '#22c55e',
                      flexShrink: 0,
                      boxShadow: '0 0 6px #22c55e',
                    }}
                  />
                )}
              </>
            )}
          </NavLink>}

          {/* DID Lookup — admins only */}
          {isAdmin && (
            <NavLink
              to="/admin/did-search"
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
                marginTop: 4,
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
                    {/* Magnifying glass + phone composite icon */}
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.7} style={{ width: 16, height: 16 }}>
                      <circle cx="8.5" cy="8.5" r="5" />
                      <path d="m13 13 3.5 3.5" strokeLinecap="round" />
                      <path d="M6.5 7.5c.5-.8 1.3-1 2-1" strokeLinecap="round" />
                    </svg>
                  </span>
                  <span style={{ flex: 1 }}>DID Lookup</span>
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
          )}

          {/* User Lookup — admins only */}
          {isAdmin && (
            <NavLink
              to="/admin/user"
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
                marginTop: 4,
                color: isActive ? '#f1f5f9' : '#64748b',
                background: isActive
                  ? 'linear-gradient(135deg, rgba(168,85,247,0.18) 0%, rgba(168,85,247,0.08) 100%)'
                  : 'transparent',
                boxShadow: isActive
                  ? '0 0 0 1px rgba(168,85,247,0.30), 0 2px 12px -4px rgba(168,85,247,0.30)'
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
                        ? 'linear-gradient(135deg, rgba(168,85,247,0.30) 0%, rgba(168,85,247,0.18) 100%)'
                        : 'rgba(255,255,255,0.04)',
                      border: isActive
                        ? '1px solid rgba(168,85,247,0.40)'
                        : '1px solid rgba(255,255,255,0.06)',
                      color: isActive ? '#c084fc' : '#475569',
                      transition: 'background 0.15s, border-color 0.15s, color 0.15s',
                    }}
                  >
                    {/* Person + magnifying glass icon */}
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.7} style={{ width: 16, height: 16 }}>
                      <circle cx="8" cy="6" r="3.5" />
                      <path d="M2 17c0-3 2.5-5 6-5" strokeLinecap="round" />
                      <circle cx="14.5" cy="14.5" r="3" />
                      <path d="m17.5 17.5 1.5 1.5" strokeLinecap="round" />
                    </svg>
                  </span>
                  <span style={{ flex: 1 }}>User Lookup</span>
                  {isActive && (
                    <span
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: '50%',
                        background: '#a855f7',
                        flexShrink: 0,
                        boxShadow: '0 0 6px #a855f7',
                      }}
                    />
                  )}
                </>
              )}
            </NavLink>
          )}

          {/* Troubleshooting — admins and support only */}
          {(isAdmin || user?.role === 'readonly') && <NavLink
            to="/troubleshooting"
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
              marginTop: 4,
              color: isActive ? '#f1f5f9' : '#64748b',
              background: isActive
                ? 'linear-gradient(135deg, rgba(245,158,11,0.18) 0%, rgba(245,158,11,0.08) 100%)'
                : 'transparent',
              boxShadow: isActive
                ? '0 0 0 1px rgba(245,158,11,0.30), 0 2px 12px -4px rgba(245,158,11,0.30)'
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
                      ? 'linear-gradient(135deg, rgba(245,158,11,0.30) 0%, rgba(245,158,11,0.18) 100%)'
                      : 'rgba(255,255,255,0.04)',
                    border: isActive
                      ? '1px solid rgba(245,158,11,0.40)'
                      : '1px solid rgba(255,255,255,0.06)',
                    color: isActive ? '#fbbf24' : '#475569',
                    transition: 'background 0.15s, border-color 0.15s, color 0.15s',
                  }}
                >
                  <IconTroubleshoot size={18} />
                </span>
                <span style={{ flex: 1 }}>Troubleshooting</span>
                {isActive && (
                  <span
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: '50%',
                      background: '#f59e0b',
                      flexShrink: 0,
                      boxShadow: '0 0 6px #f59e0b',
                    }}
                  />
                )}
              </>
            )}
          </NavLink>}
        </div>

        {/* Divider before user profile */}
        <div
          style={{
            margin: '12px 16px 0',
            height: 1,
            background: 'linear-gradient(90deg, transparent, rgba(42, 47, 69, 0.6) 20%, rgba(42, 47, 69, 0.6) 80%, transparent)',
          }}
        />

        {/* User profile section */}
        <div style={{ padding: '12px 16px 18px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 10px',
              borderRadius: 10,
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid rgba(42,47,69,0.4)',
              position: 'relative',
            }}
          >
            {/* Avatar circle with presence indicator overlay */}
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <div
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: '50%',
                  background: 'linear-gradient(135deg, rgba(59,130,246,0.30) 0%, rgba(59,130,246,0.15) 100%)',
                  border: '1px solid rgba(59,130,246,0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.7rem',
                  fontWeight: 700,
                  color: '#60a5fa',
                  letterSpacing: '0.02em',
                  textTransform: 'uppercase',
                }}
                aria-hidden="true"
              >
                {displayName.charAt(0) || '?'}
              </div>
              {/* Presence dot — clickable for all UCaaS users (presence is user-level, not extension-level) */}
              {hasUcaas ? (
                <button
                  type="button"
                  onClick={() => setShowPresenceMenu((v) => !v)}
                  aria-label="Change presence status"
                  aria-haspopup="listbox"
                  aria-expanded={showPresenceMenu}
                  style={{
                    position: 'absolute',
                    bottom: -1,
                    right: -1,
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    display: 'flex',
                  }}
                >
                  <PresenceIndicator status={presence} size={9} />
                </button>
              ) : null}

              {/* Presence dropdown */}
              {showPresenceMenu && hasUcaas && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: 36,
                    left: 0,
                    background: '#1e2435',
                    border: '1px solid rgba(255,255,255,0.10)',
                    borderRadius: 10,
                    boxShadow: '0 -8px 24px rgba(0,0,0,0.6)',
                    zIndex: 200,
                    minWidth: 164,
                    overflow: 'hidden',
                  }}
                  role="listbox"
                  aria-label="Presence status"
                >
                  {PRESENCE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      role="option"
                      aria-selected={presence === opt.value}
                      onClick={() => {
                        void setPresence(opt.value);
                        setShowPresenceMenu(false);
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        width: '100%',
                        padding: '8px 12px',
                        background: presence === opt.value ? 'rgba(255,255,255,0.06)' : 'transparent',
                        border: 'none',
                        color: '#e2e8f0',
                        fontSize: '0.8rem',
                        cursor: 'pointer',
                        textAlign: 'left',
                        transition: 'background 0.12s',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = presence === opt.value ? 'rgba(255,255,255,0.06)' : 'transparent'; }}
                    >
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: opt.color, flexShrink: 0 }} />
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Name + email */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  color: '#94a3b8',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  lineHeight: 1.3,
                }}
              >
                {displayName}
              </div>
              {contextLabel ? (
                <div
                  style={{
                    fontSize: '0.65rem',
                    color: '#334155',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    marginTop: 1,
                  }}
                >
                  {contextLabel}
                </div>
              ) : (
                <div
                  style={{
                    fontSize: '0.65rem',
                    color: '#334155',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    marginTop: 1,
                  }}
                >
                  {displayEmail}
                </div>
              )}
            </div>

            {/* Sign out button */}
            <button
              type="button"
              onClick={logout}
              title="Sign out"
              aria-label="Sign out"
              style={{
                flexShrink: 0,
                width: 26,
                height: 26,
                borderRadius: 7,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'transparent',
                border: '1px solid rgba(42,47,69,0.5)',
                color: '#475569',
                cursor: 'pointer',
                transition: 'color 0.15s, background 0.15s, border-color 0.15s',
                padding: 0,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = '#f87171';
                e.currentTarget.style.background = 'rgba(239,68,68,0.08)';
                e.currentTarget.style.borderColor = 'rgba(239,68,68,0.25)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = '#475569';
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.borderColor = 'rgba(42,47,69,0.5)';
              }}
            >
              <IconSignOut />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
