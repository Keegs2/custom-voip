import { useState, useEffect, useCallback } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { cn } from '../../utils/cn';
import { useAuth } from '../../contexts/AuthContext';
import { useSoftphone } from '../../contexts/SoftphoneContext';
import { useChat } from '../../contexts/ChatContext';
import { PresenceIndicator } from '../softphone/PresenceIndicator';
import type { PresenceStatus } from '../../types/softphone';
import {
  IconRCF, IconTrunk, IconAPI, IconIVR, IconDocs,
  IconAdmin, IconSignal, IconTroubleshoot, IconVoicemail,
} from '../icons/ProductIcons';
import { FolderOpen, Package, MessageCircle, Shield, ChevronDown, Phone } from 'lucide-react';

/* ─── Types ───────────────────────────────────────────────── */

interface NavItemDef {
  label: string;
  to: string;
  color: string;
  icon: React.ReactNode;
  accountTypes?: string[];
  adminOnly?: boolean;
}

/* ─── Presence config ─────────────────────────────────────── */

const PRESENCE_OPTIONS: { value: PresenceStatus; label: string; color: string }[] = [
  { value: 'available', label: 'Available',      color: '#22c55e' },
  { value: 'away',      label: 'Away',           color: '#f59e0b' },
  { value: 'busy',      label: 'Busy',           color: '#ef4444' },
  { value: 'dnd',       label: 'Do Not Disturb', color: '#ef4444' },
  { value: 'offline',   label: 'Appear Offline', color: '#64748b' },
];

/* ─── Icons ───────────────────────────────────────────────── */

const IconSignOut = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ width: 14, height: 14 }}>
    <path d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/* ─── Nav item definitions ────────────────────────────────── */

const allProductNavItems: NavItemDef[] = [
  { label: 'RCF',         icon: <IconRCF size={18} />,   to: '/rcf',           color: '#4ade80', accountTypes: ['rcf', 'hybrid'] },
  { label: 'SIP Trunks',  icon: <IconTrunk size={18} />, to: '/trunks',        color: '#fbbf24', accountTypes: ['trunk', 'hybrid'] },
  { label: 'API Calling', icon: <IconAPI size={18} />,   to: '/api-dids',      color: '#c084fc', adminOnly: true },
  { label: 'IVR Builder', icon: <IconIVR size={18} />,   to: '/ivr',           color: '#22d3ee', accountTypes: ['ucaas', 'hybrid'] },
  { label: 'API Docs',    icon: <IconDocs size={18} />,  to: '/documentation', color: '#94a3b8' },
];

/* ─── localStorage helpers ────────────────────────────────── */

const LS_KEY = 'sidebar_groups_open';

function loadGroupState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function saveGroupState(state: Record<string, boolean>): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    // ignore quota errors
  }
}

/* ─── SidebarNavItem ──────────────────────────────────────── */

interface SidebarNavItemProps {
  item: NavItemDef;
  onNavigate?: () => void;
  badge?: number;
  badgeColor?: string;
}

function SidebarNavItem({ item, onNavigate, badge, badgeColor }: SidebarNavItemProps) {
  return (
    <NavLink
      to={item.to}
      onClick={onNavigate}
      className="block no-underline"
      style={({ isActive }) => ({
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '7px 10px',
        borderRadius: 10,
        overflow: 'hidden',
        fontSize: '0.825rem',
        fontWeight: isActive ? 600 : 500,
        letterSpacing: '-0.01em',
        cursor: 'pointer',
        userSelect: 'none',
        transition: 'background 0.15s, color 0.15s, border-color 0.15s, box-shadow 0.15s',
        textDecoration: 'none',
        color: isActive ? '#f1f5f9' : '#64748b',
        background: isActive
          ? `linear-gradient(135deg, ${item.color}22 0%, ${item.color}10 100%)`
          : 'transparent',
        border: isActive
          ? `1px solid ${item.color}40`
          : '1px solid transparent',
        boxShadow: isActive
          ? `0 2px 12px -4px ${item.color}40`
          : 'none',
      })}
    >
      {({ isActive }) => (
        <>
          <span
            style={{
              width: 28,
              height: 28,
              borderRadius: 7,
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
          {/* Unread badge */}
          {badge !== undefined && badge > 0 && (
            <span
              style={{
                minWidth: 17,
                height: 17,
                borderRadius: 9,
                background: badgeColor ?? '#3b82f6',
                color: '#fff',
                fontSize: '0.575rem',
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 4px',
                flexShrink: 0,
                letterSpacing: '0.02em',
              }}
            >
              {badge > 99 ? '99+' : badge}
            </span>
          )}
          {/* Active dot when no badge */}
          {isActive && (badge === undefined || badge === 0) && (
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

/* ─── CollapsibleGroup ────────────────────────────────────── */

interface CollapsibleGroupProps {
  id: string;
  label: string;
  icon: React.ReactNode;
  isOpen: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}

function CollapsibleGroup({ id, label, icon, isOpen, onToggle, children }: CollapsibleGroupProps) {
  return (
    <div style={{ marginBottom: 4 }}>
      {/* Group header */}
      <button
        type="button"
        onClick={() => onToggle(id)}
        aria-expanded={isOpen}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          width: '100%',
          padding: '5px 10px',
          borderRadius: 7,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          userSelect: 'none',
          color: '#475569',
          fontSize: '0.6rem',
          fontWeight: 700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          transition: 'background 0.15s, color 0.15s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
          e.currentTarget.style.color = '#64748b';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = '#475569';
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', color: 'inherit' }}>{icon}</span>
        <span style={{ flex: 1, textAlign: 'left' }}>{label}</span>
        <ChevronDown
          size={12}
          strokeWidth={2.5}
          style={{
            flexShrink: 0,
            transition: 'transform 0.2s ease',
            transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
          }}
        />
      </button>

      {/* Animated content panel */}
      <div
        style={{
          overflow: 'hidden',
          maxHeight: isOpen ? 600 : 0,
          opacity: isOpen ? 1 : 0,
          transition: 'max-height 0.25s ease, opacity 0.2s ease',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, paddingTop: 2 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

/* ─── Sidebar ─────────────────────────────────────────────── */

export function Sidebar() {
  // All hooks must be declared unconditionally at the top, before any
  // derived values, conditionals, or early returns — React tracks hooks by
  // call order and will throw error #310 if the count changes between renders.
  const [mobileOpen, setMobileOpen] = useState(false);
  const [showPresenceMenu, setShowPresenceMenu] = useState(false);
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>(() => {
    // Lazy initializer: reads localStorage once on mount. hasUcaas is not yet
    // computed here, so we default communications to true and let the
    // auto-expand useEffect below sync it on the first render.
    const stored = loadGroupState();
    return {
      products:       stored.products       ?? true,
      communications: stored.communications ?? true,
      administration: stored.administration ?? false,
    };
  });
  const navigate = useNavigate();
  const location = useLocation();
  const { user, isAdmin, logout } = useAuth();
  const { presence, setPresence, unreadVoicemailCount, credentials } = useSoftphone();
  const { totalUnread: unreadChatCount } = useChat();

  /* ── Access flags ──────────────────────────────────────── */

  const isSupport = user?.role === 'readonly';
  const hasUcaas =
    user?.role === 'admin' ||
    user?.account_type === 'ucaas' ||
    (user?.account_type !== 'rcf' && user?.ucaas_enabled === true);

  const showAdmin = isAdmin || isSupport;

  /* ── Product items filtered by role/account_type ───────── */

  const productNavItems = allProductNavItems.filter((item) => {
    if (isAdmin || isSupport) return true;
    if (item.adminOnly) return false;
    if (item.accountTypes && user?.account_type) {
      return item.accountTypes.includes(user.account_type);
    }
    return !item.accountTypes;
  });

  // Auto-expand group when current route lives inside it
  useEffect(() => {
    const path = location.pathname;

    const productPaths  = productNavItems.map((i) => i.to);
    const commPaths     = ['/chat', '/conference', '/documents', '/voicemail'];
    const adminPaths    = ['/admin', '/call-quality', '/admin/did-search', '/admin/user', '/troubleshooting'];

    const inProducts = productPaths.some((p) => path === p || path.startsWith(p + '/'));
    const inComms    = commPaths.some((p) => path === p || path.startsWith(p + '/'));
    const inAdmin    = adminPaths.some((p) => path === p || path.startsWith(p + '/'));

    setGroupOpen((prev) => {
      const next = { ...prev };
      if (inProducts && !prev.products)       next.products       = true;
      if (inComms    && !prev.communications) next.communications = true;
      if (inAdmin    && !prev.administration) next.administration = true;
      if (next.products === prev.products &&
          next.communications === prev.communications &&
          next.administration === prev.administration) {
        return prev; // avoid unnecessary re-render
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  const toggleGroup = useCallback((id: string) => {
    setGroupOpen((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      saveGroupState(next);
      return next;
    });
  }, []);

  /* ── Misc ──────────────────────────────────────────────── */

  const handleBrandClick = () => { navigate('/'); setMobileOpen(false); };
  const closeMobile = () => setMobileOpen(false);

  const displayName  = user?.name || user?.email?.split('@')[0] || '';
  const displayEmail = user?.email ?? '';
  const contextLabel = user?.customer_name ?? null;

  /* ── Communications items ──────────────────────────────── */

  const chatItem: NavItemDef  = { label: 'Chat',        to: '/chat',       color: '#60a5fa', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} style={{ width: 15, height: 15 }}><path d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" strokeLinecap="round" strokeLinejoin="round" /></svg> };
  const confItem: NavItemDef  = { label: 'Conferences', to: '/conference', color: '#4ade80', icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} style={{ width: 15, height: 15 }}><path d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" strokeLinecap="round" strokeLinejoin="round" /></svg> };
  const docsItem: NavItemDef  = { label: 'Documents',   to: '/documents',  color: '#fbbf24', icon: <FolderOpen size={14} strokeWidth={1.8} /> };
  const vmItem: NavItemDef    = { label: 'Voicemail',   to: '/voicemail',  color: '#818cf8', icon: <IconVoicemail size={15} /> };

  /* ── Admin items ───────────────────────────────────────── */

  const customersItem: NavItemDef    = { label: 'Customers',       to: '/admin',             color: '#60a5fa', icon: <IconAdmin /> };
  const callQualityItem: NavItemDef  = { label: 'Call Quality',    to: '/call-quality',      color: '#22c55e', icon: <IconSignal size={17} /> };
  const didLookupItem: NavItemDef    = { label: 'DID Lookup',      to: '/admin/did-search',  color: '#60a5fa', icon: <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.7} style={{ width: 15, height: 15 }}><circle cx="8.5" cy="8.5" r="5" /><path d="m13 13 3.5 3.5" strokeLinecap="round" /><path d="M6.5 7.5c.5-.8 1.3-1 2-1" strokeLinecap="round" /></svg> };
  const userLookupItem: NavItemDef   = { label: 'User Lookup',     to: '/admin/user',        color: '#c084fc', icon: <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.7} style={{ width: 15, height: 15 }}><circle cx="8" cy="6" r="3.5" /><path d="M2 17c0-3 2.5-5 6-5" strokeLinecap="round" /><circle cx="14.5" cy="14.5" r="3" /><path d="m17.5 17.5 1.5 1.5" strokeLinecap="round" /></svg> };
  const troubleItem: NavItemDef      = { label: 'Troubleshooting', to: '/troubleshooting',   color: '#fbbf24', icon: <IconTroubleshoot size={17} /> };

  /* ─────────────────────────────────────────────────────── */

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
        {/* ── Brand area ─────────────────────────────────── */}
        <div
          onClick={handleBrandClick}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && handleBrandClick()}
          style={{
            padding: '22px 20px 16px',
            cursor: 'pointer',
            userSelect: 'none',
            position: 'relative',
            flexShrink: 0,
          }}
        >
          {/* Subtle blue ambient glow */}
          <div
            style={{
              position: 'absolute',
              top: 0, left: 0, right: 0,
              height: 80,
              background: 'radial-gradient(ellipse 140% 100% at 50% 0%, rgba(59,130,246,0.10) 0%, transparent 70%)',
              pointerEvents: 'none',
            }}
          />
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 10 }}>
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
              <Phone size={18} color="white" />
            </div>
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

        {/* Divider */}
        <div
          style={{
            margin: '0 16px',
            height: 1,
            flexShrink: 0,
            background: 'linear-gradient(90deg, transparent, rgba(42, 47, 69, 0.8) 20%, rgba(42, 47, 69, 0.8) 80%, transparent)',
          }}
        />

        {/* ── Scrollable nav area ─────────────────────────── */}
        <nav
          style={{
            flex: 1,
            padding: '12px 16px',
            overflowY: 'auto',
            overflowX: 'visible',
            // Thin scrollbar
            scrollbarWidth: 'thin',
            scrollbarColor: 'rgba(42,47,69,0.6) transparent',
          }}
        >
          {/* ── GROUP 1: Products ───────────────────────── */}
          <CollapsibleGroup
            id="products"
            label="Products"
            icon={<Package size={11} strokeWidth={2.5} />}
            isOpen={groupOpen.products}
            onToggle={toggleGroup}
          >
            {productNavItems.map((item) => (
              <SidebarNavItem key={item.to} item={item} onNavigate={closeMobile} />
            ))}
          </CollapsibleGroup>

          {/* ── GROUP 2: Communications (UCaaS only) ────── */}
          {hasUcaas && (
            <>
              <div style={{ height: 6 }} />
              <CollapsibleGroup
                id="communications"
                label="Communications"
                icon={<MessageCircle size={11} strokeWidth={2.5} />}
                isOpen={groupOpen.communications}
                onToggle={toggleGroup}
              >
                <SidebarNavItem item={chatItem} onNavigate={closeMobile} badge={unreadChatCount} badgeColor="#3b82f6" />
                <SidebarNavItem item={confItem} onNavigate={closeMobile} />
                <SidebarNavItem item={docsItem} onNavigate={closeMobile} />
                {credentials && (
                  <SidebarNavItem item={vmItem} onNavigate={closeMobile} badge={unreadVoicemailCount} badgeColor="#ef4444" />
                )}
              </CollapsibleGroup>
            </>
          )}

          {/* ── GROUP 3: Administration (admin + support) ─ */}
          {showAdmin && (
            <>
              <div style={{ height: 6 }} />
              <CollapsibleGroup
                id="administration"
                label="Administration"
                icon={<Shield size={11} strokeWidth={2.5} />}
                isOpen={groupOpen.administration}
                onToggle={toggleGroup}
              >
                {isAdmin && <SidebarNavItem item={customersItem}   onNavigate={closeMobile} />}
                {isAdmin && <SidebarNavItem item={didLookupItem}   onNavigate={closeMobile} />}
                {isAdmin && <SidebarNavItem item={userLookupItem}  onNavigate={closeMobile} />}
                <SidebarNavItem item={callQualityItem} onNavigate={closeMobile} />
                <SidebarNavItem item={troubleItem}     onNavigate={closeMobile} />
              </CollapsibleGroup>
            </>
          )}
        </nav>

        {/* Divider before user footer */}
        <div
          style={{
            margin: '0 16px',
            height: 1,
            flexShrink: 0,
            background: 'linear-gradient(90deg, transparent, rgba(42, 47, 69, 0.7) 20%, rgba(42, 47, 69, 0.7) 80%, transparent)',
          }}
        />

        {/* ── User profile footer ─────────────────────────── */}
        <div style={{ padding: '12px 16px 18px', flexShrink: 0 }}>
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
            {/* Clickable area: avatar + name — navigates to /account */}
            <NavLink
              to="/account"
              onClick={closeMobile}
              title="Account settings"
              style={({ isActive }) => ({
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flex: 1,
                minWidth: 0,
                textDecoration: 'none',
                borderRadius: 7,
                padding: '2px 4px',
                margin: '-2px -4px',
                background: isActive ? 'rgba(59,130,246,0.08)' : 'transparent',
                transition: 'background 0.15s',
                cursor: 'pointer',
              })}
              onMouseEnter={(e) => {
                const el = e.currentTarget as HTMLAnchorElement;
                if (!el.classList.contains('active')) {
                  el.style.background = 'rgba(255,255,255,0.05)';
                }
              }}
              onMouseLeave={(e) => {
                const el = e.currentTarget as HTMLAnchorElement;
                if (!el.classList.contains('active')) {
                  el.style.background = 'transparent';
                }
              }}
            >
            {/* Avatar + presence dot */}
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
              {hasUcaas && (
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowPresenceMenu((v) => !v); }}
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
              )}

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

              {/* Name + context label */}
              <div style={{ minWidth: 0 }}>
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
                  {contextLabel ?? displayEmail}
                </div>
              </div>
            </NavLink>

            {/* Sign out */}
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
