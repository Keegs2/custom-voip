import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { cn } from '../../utils/cn';
import { useAuth } from '../../contexts/AuthContext';
import { ApiError } from '../../api/client';
import {
  IconRCF, IconTrunk, IconAPI, IconIVR, IconDocs,
  IconAdmin, IconSignal, IconTroubleshoot,
} from '../icons/ProductIcons';
import { Package, Shield, ChevronDown, Clock, Eye, EyeOff, Server, BookOpen, Plug } from 'lucide-react';

/* ─── Types ───────────────────────────────────────────────── */

interface NavItemDef {
  label: string;
  to: string;
  color: string;
  icon: React.ReactNode;
  accountTypes?: string[];
  adminOnly?: boolean;
}

/* ─── Nav item definitions ────────────────────────────────── */

const allProductNavItems: NavItemDef[] = [
  { label: 'RCF', icon: <IconRCF size={18} />, to: '/rcf', color: '#4ade80', accountTypes: ['rcf', 'hybrid'] },
];

/* ─── Documentation nav items ─────────────────────────────── */

const docNavItems: NavItemDef[] = [
  { label: 'RCF Docs',     icon: <IconRCF size={18} />,   to: '/docs/rcf',         color: '#4ade80' },
  { label: 'API Reference',icon: <IconDocs size={18} />,  to: '/docs/api',         color: '#3b82f6' },
  { label: 'Integration',  icon: <Plug size={18} strokeWidth={1.6} />, to: '/docs/integration', color: '#f59e0b' },
];

/* ─── Coming Soon item definitions ───────────────────────── */

interface ComingSoonItemDef {
  label: string;
  icon: React.ReactNode;
}

const COMING_SOON_ITEMS: ComingSoonItemDef[] = [
  { label: 'SIP Trunking', icon: <IconTrunk size={18} /> },
  { label: 'API Calling',  icon: <IconAPI size={18} /> },
  { label: 'IVR Builder',  icon: <IconIVR size={18} /> },
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

/* ─── Icons ───────────────────────────────────────────────── */

const IconSignOut = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ width: 14, height: 14 }}>
    <path d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m3 0 3-3m0 0-3-3m3 3H9" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/* ─── Inline button spinner ───────────────────────────────── */

function SpinnerInline() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      style={{ width: 13, height: 13, animation: 'sidebar-spin 0.75s linear infinite', flexShrink: 0 }}
    >
      <style>{`@keyframes sidebar-spin { to { transform: rotate(360deg); } }`}</style>
      <circle cx="12" cy="12" r="9" stroke="rgba(255,255,255,0.25)" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="white" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/* ─── SidebarLoginForm ────────────────────────────────────── */

function SidebarLoginForm() {
  const { login } = useAuth();

  // All hooks declared unconditionally at the top — React #310 prevention
  const [email, setEmail]           = useState('');
  const [password, setPassword]     = useState('');
  const [error, setError]           = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [emailFocused, setEmailFocused] = useState(false);
  const [passFocused, setPassFocused]   = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await login(email.trim(), password);
      // On success the AuthContext updates isAuthenticated → Sidebar re-renders
      // automatically showing the nav. No redirect needed; user stays on the
      // homepage (or wherever they already are).
    } catch (err) {
      if (err instanceof ApiError) {
        setError(
          err.status === 401
            ? 'Invalid email or password.'
            : (err.message || 'An unexpected error occurred.'),
        );
      } else {
        setError('Unable to connect. Check your network.');
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  const inputBase: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    background: 'rgba(13,15,21,0.8)',
    borderRadius: 8,
    padding: '8px 10px',
    fontSize: '0.78rem',
    color: '#e2e8f0',
    outline: 'none',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  };

  return (
    <div style={{ padding: '12px 16px 18px', flexShrink: 0 }}>
      {/* Divider */}
      <div
        style={{
          height: 1,
          marginBottom: 14,
          background: 'linear-gradient(90deg, transparent, rgba(42,47,69,0.7) 20%, rgba(42,47,69,0.7) 80%, transparent)',
        }}
      />

      <p
        style={{
          fontSize: '0.6rem',
          fontWeight: 700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: '#334155',
          marginBottom: 10,
          userSelect: 'none',
        }}
      >
        Sign In
      </p>

      <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* Email */}
        <input
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onFocus={() => setEmailFocused(true)}
          onBlur={() => setEmailFocused(false)}
          placeholder="Email"
          style={{
            ...inputBase,
            border: `1px solid ${emailFocused ? '#3b82f6' : 'rgba(42,47,69,0.8)'}`,
            boxShadow: emailFocused ? '0 0 0 2px rgba(59,130,246,0.12)' : 'none',
          }}
        />

        {/* Password */}
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onFocus={() => setPassFocused(true)}
          onBlur={() => setPassFocused(false)}
          placeholder="Password"
          style={{
            ...inputBase,
            border: `1px solid ${passFocused ? '#3b82f6' : 'rgba(42,47,69,0.8)'}`,
            boxShadow: passFocused ? '0 0 0 2px rgba(59,130,246,0.12)' : 'none',
          }}
        />

        {/* Error */}
        {error && (
          <div
            role="alert"
            style={{
              fontSize: '0.7rem',
              color: '#f87171',
              lineHeight: 1.45,
              padding: '6px 8px',
              borderRadius: 6,
              background: 'rgba(239,68,68,0.07)',
              border: '1px solid rgba(239,68,68,0.18)',
            }}
          >
            {error}
          </div>
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={isSubmitting}
          style={{
            width: '100%',
            padding: '8px 12px',
            borderRadius: 8,
            background: isSubmitting
              ? 'rgba(59,130,246,0.45)'
              : 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)',
            border: 'none',
            color: '#fff',
            fontSize: '0.78rem',
            fontWeight: 700,
            letterSpacing: '-0.01em',
            cursor: isSubmitting ? 'not-allowed' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            boxShadow: isSubmitting
              ? 'none'
              : '0 2px 12px -3px rgba(59,130,246,0.5)',
            transition: 'background 0.15s, box-shadow 0.15s',
          }}
        >
          {isSubmitting ? (
            <>
              <SpinnerInline />
              Signing in…
            </>
          ) : (
            'Sign In'
          )}
        </button>
      </form>
    </div>
  );
}

/* ─── ComingSoonNavItem ───────────────────────────────────── */

function ComingSoonNavItem({ item }: { item: ComingSoonItemDef }) {
  return (
    <div
      title="Coming Soon"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 10px 5px 14px',
        borderRadius: 10,
        fontSize: '0.76rem',
        fontWeight: 500,
        letterSpacing: '-0.01em',
        color: '#64748b',
        opacity: 0.45,
        cursor: 'default',
        userSelect: 'none',
      }}
    >
      {/* Icon swatch */}
      <span
        style={{
          width: 24,
          height: 24,
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.06)',
          color: '#475569',
        }}
      >
        {item.icon}
      </span>

      {/* Label */}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {item.label}
      </span>

      {/* "Soon" badge */}
      <span
        style={{
          fontSize: '0.55rem',
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: '#818cf8',
          background: 'rgba(99,102,241,0.15)',
          border: '1px solid rgba(99,102,241,0.25)',
          borderRadius: 999,
          padding: '2px 7px',
          lineHeight: 1.6,
          flexShrink: 0,
        }}
      >
        Soon
      </span>
    </div>
  );
}

/* ─── SidebarNavItem ──────────────────────────────────────── */

interface SidebarNavItemProps {
  item: NavItemDef;
  onNavigate?: () => void;
  small?: boolean;
}

function SidebarNavItem({ item, onNavigate, small }: SidebarNavItemProps) {
  return (
    <NavLink
      to={item.to}
      onClick={onNavigate}
      className="block no-underline"
      style={({ isActive }) => ({
        display: 'flex',
        alignItems: 'center',
        gap: small ? 8 : 10,
        padding: small ? '5px 10px 5px 14px' : '7px 10px',
        borderRadius: 10,
        overflow: 'hidden',
        fontSize: small ? '0.76rem' : '0.825rem',
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
              width: small ? 24 : 28,
              height: small ? 24 : 28,
              borderRadius: small ? 6 : 7,
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
          {/* Active dot */}
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

/* ─── CollapsibleGroup ────────────────────────────────────── */

interface CollapsibleGroupProps {
  id: string;
  label: string;
  icon: React.ReactNode;
  isOpen: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
  /** When provided: first click expands the group (if collapsed), second click navigates here. */
  to?: string;
}

function CollapsibleGroup({ id, label, icon, isOpen, onToggle, children, to }: CollapsibleGroupProps) {
  const navigate = useNavigate();

  const handleClick = () => {
    if (to && isOpen) {
      // Group is already open — navigate to the landing page
      navigate(to);
    } else {
      // Collapsed or no `to` — just toggle
      onToggle(id);
    }
  };

  return (
    <div style={{ marginBottom: 4 }}>
      {/* Group header */}
      <button
        type="button"
        onClick={handleClick}
        aria-expanded={isOpen}
        title={to && isOpen ? `Go to ${label}` : undefined}
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
        {/* Small arrow indicator when this group is navigable and expanded */}
        {to && isOpen && (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              width: 10,
              height: 10,
              flexShrink: 0,
              color: '#3b82f6',
              opacity: 0.7,
              transition: 'opacity 0.15s',
            }}
          >
            <path d="M4 12 12 4M12 4H5M12 4v7" />
          </svg>
        )}
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

/* ─── SubGroupLabel — simple static divider, not collapsible ── */

function SubGroupLabel({ label }: { label: string }) {
  return (
    <div
      style={{
        padding: '6px 10px 2px',
        fontSize: '0.52rem',
        fontWeight: 700,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: 'rgba(71, 85, 105, 0.6)',
        marginTop: 8,
        userSelect: 'none',
      }}
    >
      {label}
    </div>
  );
}

/* ─── Sidebar ─────────────────────────────────────────────── */

export function Sidebar() {
  // All hooks must be declared unconditionally at the top, before any
  // derived values, conditionals, or early returns — React tracks hooks by
  // call order and will throw error #310 if the count changes between renders.
  const [mobileOpen, setMobileOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>(() => {
    const stored = loadGroupState();
    return {
      products:          stored.products          ?? true,
      comingSoon:        stored.comingSoon        ?? false,
      documentation:     stored.documentation     ?? true,
      administration:    stored.administration    ?? false,
    };
  });
  const navigate = useNavigate();
  const location = useLocation();
  const { user, isAuthenticated, isAdmin, isActualAdmin, customerViewMode, toggleCustomerView, logout } = useAuth();

  /* ── Access flags ──────────────────────────────────────── */

  const isSupport = user?.role === 'readonly';
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

    const productPaths = productNavItems.map((i) => i.to);
    const adminPaths   = ['/admin', '/call-quality', '/admin/platform', '/troubleshooting'];
    const docPaths     = docNavItems.map((i) => i.to);
    const inProducts = productPaths.some((p) => path === p || path.startsWith(p + '/'));
    const inAdmin    = adminPaths.some((p) => path === p || path.startsWith(p + '/'));
    const inDocs     = docPaths.some((p) => path === p || path.startsWith(p + '/'));

    setGroupOpen((prev) => {
      const next = { ...prev };
      if (inProducts && !prev.products)       next.products       = true;
      if (inAdmin    && !prev.administration) next.administration = true;
      if (inDocs     && !prev.documentation)  next.documentation  = true;
      if (next.products       === prev.products &&
          next.administration === prev.administration &&
          next.documentation  === prev.documentation) {
        return prev;
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

  /* ── Admin items ───────────────────────────────────────── */

  const customersItem: NavItemDef   = { label: 'Customer Management', to: '/admin/customers', color: '#60a5fa', icon: <IconAdmin /> };
  const platformItem: NavItemDef    = { label: 'Platform Management', to: '/admin/platform',  color: '#60a5fa', icon: <Server size={15} strokeWidth={1.7} /> };
  const callQualityItem: NavItemDef = { label: 'Call Quality',        to: '/call-quality',    color: '#22c55e', icon: <IconSignal size={17} /> };
  const troubleItem: NavItemDef     = { label: 'Troubleshooting',     to: '/troubleshooting', color: '#fbbf24', icon: <IconTroubleshoot size={17} /> };

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
          &#9776;
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
          borderRight: customerViewMode
            ? '1px solid rgba(245, 158, 11, 0.35)'
            : '1px solid rgba(42, 47, 69, 0.7)',
          transition: 'transform 250ms ease-in-out, border-color 0.2s ease',
        }}
        aria-label="Main navigation"
      >
        {/* ── Customer view banner ────────────────────────── */}
        {customerViewMode && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              padding: '6px 14px',
              background: 'rgba(245, 158, 11, 0.12)',
              borderBottom: '1px solid rgba(245, 158, 11, 0.35)',
              flexShrink: 0,
            }}
          >
            <Eye size={11} style={{ color: '#f59e0b', flexShrink: 0 }} />
            <span
              style={{
                fontSize: '0.6rem',
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: '#f59e0b',
              }}
            >
              Viewing as Customer
            </span>
          </div>
        )}

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
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <img
              src="/keystone_logo.png"
              alt="Granite Keystone"
              style={{
                height: 40,
                width: 'auto',
                flexShrink: 0,
                filter: 'drop-shadow(0 0 4px rgba(59, 130, 246, 0.2))',
                transition: 'filter 0.3s ease',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLImageElement).style.filter =
                  'drop-shadow(0 0 8px rgba(59, 130, 246, 0.5)) drop-shadow(0 0 16px rgba(59, 130, 246, 0.2))';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLImageElement).style.filter =
                  'drop-shadow(0 0 4px rgba(59, 130, 246, 0.2))';
              }}
            />
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

        {/* ── Scrollable nav area (authenticated only) ────── */}
        {isAuthenticated && (
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
                <SidebarNavItem key={item.to} item={item} onNavigate={closeMobile} small />
              ))}
            </CollapsibleGroup>

            {/* ── GROUP 2: Coming Soon ──────────────────────── */}
            <div style={{ height: 6 }} />
            <CollapsibleGroup
              id="comingSoon"
              label="Coming Soon"
              icon={<Clock size={11} strokeWidth={2.5} />}
              isOpen={groupOpen.comingSoon}
              onToggle={toggleGroup}
            >
              {COMING_SOON_ITEMS.map((item) => (
                <ComingSoonNavItem key={item.label} item={item} />
              ))}
            </CollapsibleGroup>

            {/* ── GROUP 3: Documentation ───────────────────── */}
            <div style={{ height: 6 }} />
            <CollapsibleGroup
              id="documentation"
              label="Documentation"
              icon={<BookOpen size={11} strokeWidth={2.5} />}
              isOpen={groupOpen.documentation}
              onToggle={toggleGroup}
            >
              {docNavItems.map((item) => (
                <SidebarNavItem key={item.to} item={item} onNavigate={closeMobile} small />
              ))}
            </CollapsibleGroup>

            {/* ── GROUP 4: Administration (admin + support) ─ */}
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
                  {/* ── Customers sub-group (admin only) ──── */}
                  {isAdmin && (
                    <>
                      <SubGroupLabel label="Customers" />
                      <SidebarNavItem item={customersItem} onNavigate={closeMobile} small />
                      <SidebarNavItem item={platformItem}  onNavigate={closeMobile} small />
                    </>
                  )}

                  {/* ── Support sub-group (admin + readonly) */}
                  <SubGroupLabel label="Support" />
                  <SidebarNavItem item={callQualityItem} onNavigate={closeMobile} small />
                  <SidebarNavItem item={troubleItem}     onNavigate={closeMobile} small />
                </CollapsibleGroup>
              </>
            )}
          </nav>
        )}

        {/* Spacer when unauthenticated so the login form stays at the bottom */}
        {!isAuthenticated && <div style={{ flex: 1 }} />}

        {/* ── Authenticated bottom section ─────────────────── */}
        {isAuthenticated && (
          <>
            {/* Divider before user footer */}
            <div
              style={{
                margin: '0 16px',
                height: 1,
                flexShrink: 0,
                background: 'linear-gradient(90deg, transparent, rgba(42, 47, 69, 0.7) 20%, rgba(42, 47, 69, 0.7) 80%, transparent)',
              }}
            />

            {/* ── Customer view toggle (admin only) ───────── */}
            {isActualAdmin && (
              <div style={{ padding: '8px 16px 2px', flexShrink: 0 }}>
                <button
                  type="button"
                  onClick={toggleCustomerView}
                  title={customerViewMode ? 'Return to admin view' : 'Preview the app as a customer'}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '6px 10px',
                    borderRadius: 8,
                    background: customerViewMode
                      ? 'rgba(245, 158, 11, 0.10)'
                      : 'transparent',
                    border: customerViewMode
                      ? '1px solid rgba(245, 158, 11, 0.30)'
                      : '1px solid rgba(42, 47, 69, 0.4)',
                    cursor: 'pointer',
                    transition: 'background 0.15s, border-color 0.15s',
                  }}
                  onMouseEnter={(e) => {
                    if (!customerViewMode) {
                      e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                      e.currentTarget.style.borderColor = 'rgba(42,47,69,0.7)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!customerViewMode) {
                      e.currentTarget.style.background = 'transparent';
                      e.currentTarget.style.borderColor = 'rgba(42,47,69,0.4)';
                    }
                  }}
                >
                  {/* Icon */}
                  {customerViewMode
                    ? <EyeOff size={13} style={{ color: '#f59e0b', flexShrink: 0 }} />
                    : <Eye    size={13} style={{ color: '#475569', flexShrink: 0 }} />
                  }

                  {/* Label */}
                  <span
                    style={{
                      flex: 1,
                      textAlign: 'left',
                      fontSize: '0.75rem',
                      fontWeight: 500,
                      color: customerViewMode ? '#f59e0b' : '#475569',
                      letterSpacing: '-0.01em',
                      transition: 'color 0.15s',
                    }}
                  >
                    {customerViewMode ? 'Exit Customer View' : 'View as Customer'}
                  </span>

                  {/* Active pill */}
                  {customerViewMode && (
                    <span
                      style={{
                        fontSize: '0.55rem',
                        fontWeight: 700,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        color: '#f59e0b',
                        background: 'rgba(245,158,11,0.15)',
                        border: '1px solid rgba(245,158,11,0.30)',
                        borderRadius: 999,
                        padding: '2px 6px',
                        lineHeight: 1.6,
                        flexShrink: 0,
                      }}
                    >
                      ON
                    </span>
                  )}
                </button>
              </div>
            )}

            {/* ── User profile footer ──────────────────────── */}
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
                  {/* Avatar */}
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
          </>
        )}

        {/* ── Unauthenticated: compact login form ──────────── */}
        {!isAuthenticated && <SidebarLoginForm />}
      </aside>
    </>
  );
}
