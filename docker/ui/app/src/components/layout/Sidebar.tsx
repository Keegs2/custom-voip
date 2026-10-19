import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { cn } from '../../utils/cn';
import { useAuth } from '../../contexts/AuthContext';
import { ApiError } from '../../api/client';
import {
  IconRCF, IconTrunk, IconAPI, IconVoicemail, IconDocs,
  IconSignal, IconTroubleshoot,
} from '../icons/ProductIcons';
import { Package, Shield, ChevronDown, Clock, Eye, EyeOff, BookOpen, BarChart3, LayoutDashboard } from 'lucide-react';
import { CustomerPreviewPicker } from '../preview/CustomerPreviewPicker';
import { API_CALLING_ENABLED } from '../../config/features';
import { canSeeReporting } from '../../utils/reportingAccess';

/* ─── Types ───────────────────────────────────────────────── */

interface NavItemDef {
  label: string;
  to: string;
  color: string;
  icon: React.ReactNode;
  accountTypes?: string[];
  adminOnly?: boolean;
  /** Custom active-match function. When provided, overrides NavLink's default isActive. */
  isActiveFn?: (pathname: string) => boolean;
}

/* ─── Nav item definitions ────────────────────────────────── */

// Live products only. SIP Trunking moved to Coming Soon (2026-10) — the
// /trunks route still works and is reached from its linked Coming Soon row.
const allProductNavItems: NavItemDef[] = [
  { label: 'RCF', icon: <IconRCF size={18} />, to: '/rcf', color: '#3b82f6', accountTypes: ['rcf', 'hybrid'] },
];

/* ─── Dashboard (top-level, above Products) ───────────────── */

// The customer's account home (/dashboard). Shown to every non-support user
// who has an effective customer: tenants, and an admin in "View as Customer"
// once a preview customer is picked. Normal (live) active style, not muted.
const dashboardNavItem: NavItemDef = {
  label: 'Dashboard',
  icon: <LayoutDashboard size={18} />,
  to: '/dashboard',
  color: '#3b82f6',
};

/* ─── Insights nav items ──────────────────────────────────── */

// Customer Reporting — rendered in its own Insights group. Visibility is the
// shared canSeeReporting() rule, identical to the /reporting route guard.
const reportingNavItem: NavItemDef = {
  label: 'Reporting',
  icon: <BarChart3 size={18} />,
  to: '/reporting',
  color: '#3b82f6',
  isActiveFn: (p) => p.startsWith('/reporting'),
};

/* ─── Coming Soon item definitions ───────────────────────── */

interface ComingSoonItemDef {
  label: string;
  icon: React.ReactNode;
  /** When set, the item is a real link to a coming-soon preview page. */
  to?: string;
  /**
   * Custom active-match (linked items only). Without it the row is active on
   * `to` or any sub-path of it (see isSoonItemActive); either way the same
   * rule drives both the row's active style and the group's auto-open.
   */
  isActiveFn?: (pathname: string) => boolean;
  /**
   * When set, only admins and these account types get the LINK; everyone else
   * sees the same darkened row without one (e.g. an RCF-only customer has no
   * trunks page worth opening).
   */
  linkAccountTypes?: string[];
}

// RCF is the only LIVE product (gated by account_type in allProductNavItems).
// Everything here is pre-launch or de-prioritised and renders DARKENED: each
// row still links to its real page (routes keep working — SIP Trunking hosts
// the owner's test customer, the docs stay readable), but none competes with
// live nav. Like the group itself, these show for ALL non-support
// authenticated users regardless of account_type.
// API Calling is RETIRED (2026-09): its item is kept but only listed while
// API_CALLING_ENABLED is true (the /api-dids route redirects when it is off).
const COMING_SOON_ITEMS: ComingSoonItemDef[] = [
  { label: 'SIP Trunking', icon: <IconTrunk size={18} />, to: '/trunks', linkAccountTypes: ['trunk', 'hybrid'] },
  ...(API_CALLING_ENABLED
    ? [{ label: 'API Calling', icon: <IconAPI size={18} />, to: '/api-dids' }]
    : []),
  { label: 'Visual Voicemail', icon: <IconVoicemail size={18} />, to: '/voicemail' },
  {
    label: 'Guides',
    icon: <BookOpen size={18} />,
    to: '/docs/guides',
    isActiveFn: (p) => p === '/docs/guides' || p.startsWith('/docs/guides/'),
  },
  {
    label: 'API Reference',
    icon: <IconDocs size={18} />,
    to: '/docs/api',
    isActiveFn: (p) => p === '/docs/api' || p.startsWith('/docs/api/'),
  },
];

/**
 * True when `pathname` is (or lives under) this Coming Soon row's page. One
 * rule for both the row's active style and the group's auto-open.
 */
function isSoonItemActive(item: ComingSoonItemDef, pathname: string): boolean {
  if (!item.to) return false;
  if (item.isActiveFn) return item.isActiveFn(pathname);
  return pathname === item.to || pathname.startsWith(item.to + '/');
}

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
    <div style={{ padding: '14px 16px 16px', flexShrink: 0 }}>
      <p
        style={{
          fontSize: '0.6rem',
          fontWeight: 600,
          letterSpacing: '0.05em',
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

/** Shared "Soon" pill — muted slate, identical for linked and static items. */
function SoonBadge() {
  return <span className="sb-soon-pill">Soon</span>;
}

/**
 * Pre-launch product row. Deliberately DARKENED at rest (dim icon + label +
 * slate "Soon" pill — see .sb-soon-row in index.css) so it always reads as
 * subordinate to live nav items. No product accent anywhere: the linked
 * variant gets only a faint neutral hover lift, and even its active state
 * (you are on the preview page) is a quiet neutral wash, never the live
 * gradient + glow + dot.
 */
function ComingSoonNavItem({ item, onNavigate }: { item: ComingSoonItemDef; onNavigate?: () => void }) {
  // Hook first — above the linked/static branch (React #310 rule).
  const { pathname } = useLocation();
  const isActive = isSoonItemActive(item, pathname);

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '5px 10px 5px 14px',
    borderRadius: 10,
    overflow: 'hidden',
    fontSize: '0.76rem',
    fontWeight: 500,
    letterSpacing: '-0.01em',
    userSelect: 'none',
    textDecoration: 'none',
  };
  const iconStyle: React.CSSProperties = {
    width: 24,
    height: 24,
    borderRadius: 6,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  };
  const labelStyle: React.CSSProperties = {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };

  // Linked variant — a real NavLink to the product's coming-soon preview page.
  if (item.to) {
    return (
      <NavLink
        to={item.to}
        onClick={onNavigate}
        title={`${item.label} — coming soon (preview)`}
        aria-current={isActive ? 'page' : undefined}
        className={cn('block no-underline sb-soon-row sb-soon-row--link', isActive && 'sb-soon-row--active')}
        style={rowStyle}
      >
        <span className="sb-soon-icon" style={iconStyle}>{item.icon}</span>
        <span style={labelStyle}>{item.label}</span>
        <SoonBadge />
      </NavLink>
    );
  }

  // Static variant — no page yet; non-interactive.
  return (
    <div title={`${item.label} — coming soon`} className="sb-soon-row" style={{ ...rowStyle, cursor: 'default' }}>
      <span className="sb-soon-icon" style={iconStyle}>{item.icon}</span>
      <span style={labelStyle}>{item.label}</span>
      <SoonBadge />
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
  const location = useLocation();
  const customActive = item.isActiveFn ? item.isActiveFn(location.pathname) : undefined;

  return (
    <NavLink
      to={item.to}
      end={!item.isActiveFn}
      onClick={onNavigate}
      className="block no-underline sb-nav-row"
      style={({ isActive: routerActive }) => {
        const isActive = customActive ?? routerActive;
        return {
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
          textDecoration: 'none',
          // Non-active resting/hover colors live in CSS (.sb-nav-row in
          // index.css) so :hover / :focus-visible can restyle them — inline
          // styles would win over the class. Active keeps its exact inline
          // treatment (gradient + border + glow), which also beats the hover
          // tint, so hovering an active item changes nothing.
          ['--sb-accent-tint' as string]: `${item.color}14`,
          color: isActive ? '#f1f5f9' : undefined,
          background: isActive
            ? `linear-gradient(135deg, ${item.color}22 0%, ${item.color}10 100%)`
            : undefined,
          border: isActive
            ? `1px solid ${item.color}40`
            : '1px solid transparent',
          boxShadow: isActive
            ? `0 2px 12px -4px ${item.color}40`
            : 'none',
        };
      }}
    >
      {({ isActive: routerActive }) => {
        const isActive = customActive ?? routerActive;
        return (
          <>
            <span
              className="sb-nav-icon"
              style={{
                width: small ? 24 : 28,
                height: small ? 24 : 28,
                borderRadius: small ? 6 : 7,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                // Non-active swatch colors come from .sb-nav-icon (index.css)
                // so the row's :hover can brighten them; active stays inline.
                ...(isActive
                  ? {
                      background: `linear-gradient(135deg, ${item.color}30 0%, ${item.color}18 100%)`,
                      border: `1px solid ${item.color}40`,
                      color: item.color,
                    }
                  : null),
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
        );
      }}
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
  /** Darkened header for the pre-launch (Coming Soon) group. */
  muted?: boolean;
}

function CollapsibleGroup({ id, label, icon, isOpen, onToggle, children, to, muted = false }: CollapsibleGroupProps) {
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
        // Resting/hover colors live in CSS (.sb-group-head in index.css) so
        // :hover / :focus-visible share one treatment across all nav rows.
        className={muted ? 'sb-group-head sb-group-head--muted' : 'sb-group-head'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          width: '100%',
          padding: '5px 10px',
          borderRadius: 7,
          border: 'none',
          cursor: 'pointer',
          userSelect: 'none',
          fontSize: '0.6rem',
          fontWeight: 600,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
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
        fontWeight: 600,
        letterSpacing: '0.05em',
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

interface SidebarProps {
  /** Desktop collapse (AppLayout owns the state + the toggle tab). Slides the
      sidebar off-canvas at ≥768px only — the mobile drawer is unaffected.
      Defaults to false for standalone users (TroubleshootingPage). */
  collapsed?: boolean;
}

export function Sidebar({ collapsed = false }: SidebarProps) {
  // All hooks must be declared unconditionally at the top, before any
  // derived values, conditionals, or early returns — React tracks hooks by
  // call order and will throw error #310 if the count changes between renders.
  const [mobileOpen, setMobileOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>(() => {
    const stored = loadGroupState();
    return {
      products:          stored.products          ?? true,
      comingSoon:        stored.comingSoon        ?? false,
      insights:          stored.insights          ?? true,
      administration:    stored.administration    ?? false,
    };
  });
  const navigate = useNavigate();
  const location = useLocation();
  const {
    user, isAuthenticated, isAdmin, isActualAdmin, customerViewMode, toggleCustomerView, logout, effectiveCustomer,
  } = useAuth();

  /* ── Access flags ──────────────────────────────────────── */

  const isSupport = user?.role === 'support';
  const isReadonly = user?.role === 'readonly';
  // The Administration group shows for admins (full tree), support (their
  // whole nav — labeled "Support"), and readonly (Call Quality only: the one
  // support tool their role can actually call).
  const showAdmin = isAdmin || isSupport || isReadonly;
  const showReporting = canSeeReporting(user);
  const showDashboard = !isSupport && !isAdmin && effectiveCustomer !== null;

  /* ── Product items filtered by role/account_type ───────── */

  // The account type the customer nav follows: the tenant's own, or — for an
  // admin in customer view — the previewed customer's (the admin user itself
  // has account_type null, which used to hide RCF and the whole group).
  const effectiveAccountType = isAdmin ? null : (effectiveCustomer?.account_type ?? user?.account_type ?? null);

  const productNavItems = allProductNavItems.filter((item) => {
    if (isAdmin) return true;
    if (item.adminOnly) return false;
    if (item.accountTypes && effectiveAccountType) {
      return item.accountTypes.includes(effectiveAccountType);
    }
    return !item.accountTypes;
  });
  // Never render an empty Products header (e.g. trunk-only accounts).
  const showProducts = !isSupport && productNavItems.length > 0;

  // Auto-expand group when current route lives inside it
  useEffect(() => {
    const path = location.pathname;

    const productPaths = productNavItems.map((i) => i.to);
    const adminPaths   = ['/admin', '/call-quality', '/troubleshooting', '/cdrs'];
    const inProducts = productPaths.some((p) => path === p || path.startsWith(p + '/'));
    const inAdmin    = adminPaths.some((p) => path === p || path.startsWith(p + '/'));
    const inSoon     = COMING_SOON_ITEMS.some((i) => isSoonItemActive(i, path));
    const inInsights = path === reportingNavItem.to || path.startsWith(reportingNavItem.to + '/');

    setGroupOpen((prev) => {
      const next = { ...prev };
      if (inProducts && !prev.products)       next.products       = true;
      if (inAdmin    && !prev.administration) next.administration = true;
      if (inSoon     && !prev.comingSoon)     next.comingSoon     = true;
      if (inInsights && !prev.insights)       next.insights       = true;
      if (next.products       === prev.products &&
          next.insights       === prev.insights &&
          next.administration === prev.administration &&
          next.comingSoon     === prev.comingSoon) {
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

  // The merged Calls & Quality page (CDR search + voice-quality analysis in
  // one). Staff enter via /cdrs; the tenant-facing entry keeps the familiar
  // "Call Quality" label via /call-quality — both routes render the same page.
  const callsQualityItem: NavItemDef = {
    label: 'Calls & Quality', to: '/cdrs', color: '#22c55e', icon: <IconSignal size={17} />,
    // Light up on either alias of the merged page.
    isActiveFn: (p) => p.startsWith('/cdrs') || p.startsWith('/call-quality'),
  };
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
          'app-sidebar fixed top-0 left-0 bottom-0 z-[100]',
          'flex flex-col',
          'md:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
          // Desktop collapse — applied ≥768px only (see index.css). Uses
          // `transform` so it composes with the Tailwind `translate` classes
          // above instead of fighting them.
          collapsed && 'app-sidebar--collapsed',
        )}
        style={{
          width: 240,
          background: 'linear-gradient(180deg, #0c0e16 0%, #0a0c13 100%)',
          borderRight: customerViewMode
            ? '1px solid rgba(245, 158, 11, 0.35)'
            : '1px solid rgba(42, 47, 69, 0.7)',
          // `translate` covers the Tailwind mobile-drawer utilities (v4 uses
          // the translate property); `transform` covers the desktop collapse.
          transition: 'transform 200ms ease, translate 250ms ease-in-out, border-color 0.2s ease',
        }}
        aria-label="Main navigation"
      >
        {/* ── Customer view banner ────────────────────────── */}
        {customerViewMode && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 7,
              padding: '7px 14px 10px',
              background: 'rgba(245, 158, 11, 0.12)',
              borderBottom: '1px solid rgba(245, 158, 11, 0.35)',
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <Eye size={11} style={{ color: '#f59e0b', flexShrink: 0 }} />
              <span
                style={{
                  fontSize: '0.6rem',
                  fontWeight: 600,
                  letterSpacing: '0.05em',
                  textTransform: 'uppercase',
                  color: '#f59e0b',
                }}
              >
                Viewing as Customer
              </span>
            </div>
            {/* Which customer the customer pages show (admin preview only). */}
            {isActualAdmin && <CustomerPreviewPicker tone="dark" label="Customer" />}
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
              src="/crag.png"
              alt="Granite CRAG"
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

        {/* ── Unauthenticated: login + request access ──────── */}
        {!isAuthenticated && (
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              overflowX: 'hidden',
              scrollbarWidth: 'thin',
              scrollbarColor: 'rgba(42,47,69,0.6) transparent',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <SidebarLoginForm />
          </div>
        )}

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
            {/* ── Dashboard — the customer's account home, top-level ─ */}
            {showDashboard && (
              <div style={{ marginBottom: 10 }}>
                <SidebarNavItem item={dashboardNavItem} onNavigate={closeMobile} />
              </div>
            )}

            {/* ── GROUP 1: Products (hidden for support staff, and
                 entirely — header too — when the account has no live
                 product, e.g. a trunk-only customer now that SIP Trunking
                 lives in Coming Soon) ─ */}
            {showProducts && (
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
            )}

            {/* ── GROUP 2: Insights — Reporting ─ */}
            {showReporting && (
              <>
                {showProducts && <div style={{ height: 6 }} />}
                <CollapsibleGroup
                  id="insights"
                  label="Insights"
                  icon={<BarChart3 size={11} strokeWidth={2.5} />}
                  isOpen={groupOpen.insights}
                  onToggle={toggleGroup}
                >
                  <SidebarNavItem item={reportingNavItem} onNavigate={closeMobile} small />
                </CollapsibleGroup>
              </>
            )}

            {/* ── GROUP 3: Administration / Support tools ──── */}
            {showAdmin && (
              <>
                {(showProducts || showReporting) && <div style={{ height: 6 }} />}
                <CollapsibleGroup
                  id="administration"
                  label={isSupport ? 'Support' : 'Administration'}
                  icon={<Shield size={11} strokeWidth={2.5} />}
                  isOpen={groupOpen.administration}
                  onToggle={toggleGroup}
                >
                  {/* Customer + platform administration lives in TED (the CRAG
                       console); the former Platform sub-group's last item, the
                       Payments Demo, was removed 2026-09. */}
                  {isSupport ? (
                    /* Support role — its entire nav: the platform-read tools
                       the API grants this role. Calls & Quality is the merged
                       CDR Search + Call Quality page. */
                    <>
                      <SidebarNavItem item={troubleItem}      onNavigate={closeMobile} small />
                      <SidebarNavItem item={callsQualityItem} onNavigate={closeMobile} small />
                    </>
                  ) : (
                    /* ── Support sub-group (admin + readonly) ──
                       Staff get the ONE merged Calls & Quality entry (it
                       replaced the separate CDR Search + Call Quality items);
                       readonly keeps the tenant-facing Call Quality label
                       pointing at the same merged page. Troubleshooting hits
                       admin-gated APIs, so it stays admin-only. */
                    <>
                      <SubGroupLabel label="Support" />
                      {isAdmin
                        ? <SidebarNavItem item={callsQualityItem} onNavigate={closeMobile} small />
                        : <SidebarNavItem item={callQualityItem}  onNavigate={closeMobile} small />}
                      {isAdmin && <SidebarNavItem item={troubleItem} onNavigate={closeMobile} small />}
                    </>
                  )}
                </CollapsibleGroup>
              </>
            )}

            {/* ── LAST GROUP: Coming Soon — always at the bottom, darkened
                 (pre-launch / de-prioritised items — SIP Trunking, Visual
                 Voicemail, Guides, API Reference — must never compete with
                 live nav; each row still links to its working page).
                 Hidden while empty / for support. ─ */}
            {!isSupport && COMING_SOON_ITEMS.length > 0 && (
              <>
                <div className="sb-soon-divider" aria-hidden="true" />
                <CollapsibleGroup
                  id="comingSoon"
                  label="Coming Soon"
                  icon={<Clock size={11} strokeWidth={2.5} />}
                  isOpen={groupOpen.comingSoon}
                  onToggle={toggleGroup}
                  muted
                >
                  {COMING_SOON_ITEMS.map((item) => {
                    const linked = !item.linkAccountTypes || isAdmin
                      || (effectiveAccountType != null && item.linkAccountTypes.includes(effectiveAccountType));
                    return (
                      <ComingSoonNavItem
                        key={item.label}
                        item={linked ? item : { label: item.label, icon: item.icon }}
                        onNavigate={closeMobile}
                      />
                    );
                  })}
                </CollapsibleGroup>
              </>
            )}
          </nav>
        )}

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
                  // Resting/hover colors live in CSS (.sb-viewas in index.css);
                  // the amber customer-view treatment stays inline and wins.
                  className="sb-viewas"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '6px 10px',
                    borderRadius: 8,
                    cursor: 'pointer',
                    ...(customerViewMode
                      ? {
                          background: 'rgba(245, 158, 11, 0.10)',
                          border: '1px solid rgba(245, 158, 11, 0.30)',
                        }
                      : null),
                  }}
                >
                  {/* Icon */}
                  {customerViewMode
                    ? <EyeOff size={13} style={{ color: '#f59e0b', flexShrink: 0 }} />
                    : <Eye    size={13} className="sb-viewas-glyph" style={{ flexShrink: 0 }} />
                  }

                  {/* Label */}
                  <span
                    className="sb-viewas-label"
                    style={{
                      flex: 1,
                      textAlign: 'left',
                      fontSize: '0.75rem',
                      fontWeight: 500,
                      ...(customerViewMode ? { color: '#f59e0b' } : null),
                      letterSpacing: '-0.01em',
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
                {/* Clickable area: avatar + name — THE entry to /my-account */}
                <NavLink
                  to="/my-account"
                  onClick={closeMobile}
                  title="My account"
                  aria-label="My account"
                  // Resting/hover tint lives in CSS (.sb-account-link in
                  // index.css); the active blue wash stays inline and wins.
                  className="sb-account-link"
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
                    background: isActive ? 'rgba(59,130,246,0.08)' : undefined,
                    cursor: 'pointer',
                  })}
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
                  // Resting + red hover colors live in CSS (.sb-signout in
                  // index.css) so keyboard :focus-visible matches hover.
                  className="sb-signout"
                  style={{
                    flexShrink: 0,
                    width: 26,
                    height: 26,
                    borderRadius: 7,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  <IconSignOut />
                </button>
              </div>
            </div>
          </>
        )}

      </aside>
    </>
  );
}
