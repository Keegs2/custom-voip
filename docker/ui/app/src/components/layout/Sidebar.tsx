import { useState, useEffect, useCallback, type CSSProperties, type FormEvent } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { cn } from '../../utils/cn';
import { useAuth } from '../../contexts/AuthContext';
import { ApiError } from '../../api/client';
import {
  IconRCF, IconTrunk, IconAPI, IconVoicemail, IconDocs,
  IconSignal, IconTroubleshoot,
} from '../icons/ProductIcons';
import { Package, Shield, ChevronDown, Clock, Eye, EyeOff, BookOpen, BarChart3, LayoutDashboard, LogOut, Menu, X } from 'lucide-react';
import { CustomerPreviewPicker } from '../preview/CustomerPreviewPicker';
import { API_CALLING_ENABLED } from '../../config/features';
import { canSeeReporting } from '../../utils/reportingAccess';
import { staffScope, tenantScope, useVoicemailSummary } from '../../pages/voicemail/voicemailData';
import { T } from '../../styles/theme';
import { ThemeToggle } from './ThemeToggle';

/* ─────────────────────────────────────────────────────────────
   Every colour here is a theme token: the rows, groups, banner and
   footer are classes in styles/app-shell.css (`sb-*`), and the only
   inline colour is each row's product accent (`--sb-accent`, a
   --t-sb-accent-* token). Light = a white daylight panel; dark = the
   original dark shell. See docker/ui/CLAUDE.md "Theming".
   ───────────────────────────────────────────────────────────── */

/* ─── Types ───────────────────────────────────────────────── */

/** Product accent of a live nav row (active wash, icon, dot). */
type SidebarAccent = 'azure' | 'green' | 'amber';

const ACCENT_VAR: Record<SidebarAccent, string> = {
  azure: T.sbAccentAzure,
  green: T.sbAccentGreen,
  amber: T.sbAccentAmber,
};

interface NavItemDef {
  label: string;
  to: string;
  accent: SidebarAccent;
  icon: React.ReactNode;
  accountTypes?: string[];
  adminOnly?: boolean;
  /** Custom active-match function. When provided, overrides NavLink's default isActive. */
  isActiveFn?: (pathname: string) => boolean;
  /** Small count pill after the label (e.g. unread voicemail); hidden at 0. */
  badge?: number;
}

/* ─── Nav item definitions ────────────────────────────────── */

// Live products only. SIP Trunking moved to Coming Soon (2026-10) — the
// /trunks route still works and is reached from its linked Coming Soon row.
const allProductNavItems: NavItemDef[] = [
  { label: 'RCF', icon: <IconRCF size={18} />, to: '/rcf', accent: 'azure', accountTypes: ['rcf', 'hybrid'] },
];

// Visual Voicemail is live per ACCOUNT, not per account type: it joins
// Products (and leaves Coming Soon) when GET /voicemail/summary says the
// effective customer has it switched on, and always for platform admins
// (their /voicemail is the staff console). Any account type can have it.
const voicemailNavItem: NavItemDef = {
  label: 'Visual Voicemail',
  icon: <IconVoicemail size={18} />,
  to: '/voicemail',
  accent: 'azure',
};
const VOICEMAIL_SOON_LABEL = 'Visual Voicemail';

/* ─── Dashboard (top-level, above Products) ───────────────── */

// The account home (/dashboard). Shown to platform admins (the admin
// dashboard: All customers + a dropdown per customer) and to every
// non-support user with an effective customer: tenants, and an admin in
// "View as Customer" once a preview customer is picked. Normal (live) active
// style, not muted.
const dashboardNavItem: NavItemDef = {
  label: 'Dashboard',
  icon: <LayoutDashboard size={18} />,
  to: '/dashboard',
  accent: 'azure',
};

/* ─── Insights nav items ──────────────────────────────────── */

// Customer Reporting — rendered in its own Insights group. Visibility is the
// shared canSeeReporting() rule, identical to the /reporting route guard.
const reportingNavItem: NavItemDef = {
  label: 'Reporting',
  icon: <BarChart3 size={18} />,
  to: '/reporting',
  accent: 'azure',
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

// RCF is live (gated by account_type in allProductNavItems); Visual Voicemail
// is live per account (see voicemailNavItem) and drops out of this list when
// it is. Everything here is pre-launch or de-prioritised and renders DARKENED: each
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

/* ─── Brand lockup — the landing nav's cube mark + wide wordmark ── */

/**
 * The transparent cube cut-out (crag-mark.*) + "GRANITE CRAG" set wide,
 * as on the landing page's top nav. Legible on the white light-theme
 * panel and on the dark shell alike (the old /crag.png is a dark square).
 */
function BrandLockup() {
  return (
    <>
      <picture>
        <source srcSet="/crag-mark.webp" type="image/webp" />
        <img src="/crag-mark.png" alt="" className="sb-brand-mark" width={32} height={32} decoding="async" />
      </picture>
      <span className="sb-wordmark">
        <span className="sb-wordmark-dim">GRANITE</span> CRAG
      </span>
    </>
  );
}

/* ─── Inline button spinner ───────────────────────────────── */

function SpinnerInline() {
  // Ring + arc in the label colour (currentColor = white on the azure button).
  return (
    <svg viewBox="0 0 24 24" fill="none" className="sb-spin" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity={0.25} strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
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

  return (
    <div className="sb-login">
      <p className="sb-login-title">Sign In</p>

      <form onSubmit={handleSubmit} noValidate className="sb-login-form">
        <input
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          aria-label="Email"
          className="sb-login-field"
        />

        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          aria-label="Password"
          className="sb-login-field"
        />

        {error && (
          <div role="alert" className="sb-login-error">
            {error}
          </div>
        )}

        <button type="submit" disabled={isSubmitting} className="sb-login-submit">
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
 * quiet "Soon" pill — see .sb-soon-row in styles/app-shell.css) so it reads as
 * subordinate to live nav items. No product accent anywhere: the linked
 * variant gets only a faint neutral hover lift, and even its active state
 * (you are on the preview page) is a quiet neutral wash, never the live
 * gradient + glow + dot.
 */
function ComingSoonNavItem({ item, onNavigate }: { item: ComingSoonItemDef; onNavigate?: () => void }) {
  // Hook first — above the linked/static branch (React #310 rule).
  const { pathname } = useLocation();
  const isActive = isSoonItemActive(item, pathname);

  // Linked variant — a real NavLink to the product's coming-soon preview page.
  if (item.to) {
    return (
      <NavLink
        to={item.to}
        onClick={onNavigate}
        title={`${item.label} — coming soon (preview)`}
        aria-current={isActive ? 'page' : undefined}
        className={cn('sb-soon-row sb-soon-row--link', isActive && 'sb-soon-row--active')}
      >
        <span className="sb-soon-icon">{item.icon}</span>
        <span className="sb-nav-label">{item.label}</span>
        <SoonBadge />
      </NavLink>
    );
  }

  // Static variant — no page yet; non-interactive.
  return (
    <div title={`${item.label} — coming soon`} className="sb-soon-row">
      <span className="sb-soon-icon">{item.icon}</span>
      <span className="sb-nav-label">{item.label}</span>
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
  // The row's product accent, consumed by every active/hover rule in CSS.
  const accentStyle = { '--sb-accent': ACCENT_VAR[item.accent] } as CSSProperties;

  return (
    <NavLink
      to={item.to}
      end={!item.isActiveFn}
      onClick={onNavigate}
      className={({ isActive: routerActive }) =>
        cn(
          'sb-nav-row',
          small && 'sb-nav-row--small',
          (customActive ?? routerActive) && 'sb-nav-row--active',
        )
      }
      style={accentStyle}
    >
      {({ isActive: routerActive }) => {
        const isActive = customActive ?? routerActive;
        return (
          <>
            <span className="sb-nav-icon">{item.icon}</span>
            <span className="sb-nav-label">{item.label}</span>
            {item.badge !== undefined && item.badge > 0 && (
              <span className="sb-count" aria-label={`${item.badge} unread`}>
                {item.badge > 99 ? '99+' : item.badge}
              </span>
            )}
            {isActive && <span className="sb-dot" aria-hidden="true" />}
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
    <div className="sb-group">
      {/* Group header — resting/hover colours live in CSS (.sb-group-head) */}
      <button
        type="button"
        onClick={handleClick}
        aria-expanded={isOpen}
        title={to && isOpen ? `Go to ${label}` : undefined}
        className={muted ? 'sb-group-head sb-group-head--muted' : 'sb-group-head'}
      >
        <span className="sb-group-head-icon">{icon}</span>
        <span className="sb-group-head-label">{label}</span>
        {/* Small arrow indicator when this group is navigable and expanded */}
        {to && isOpen && (
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="sb-group-go"
            aria-hidden="true"
          >
            <path d="M4 12 12 4M12 4H5M12 4v7" />
          </svg>
        )}
        <ChevronDown
          size={12}
          strokeWidth={2.5}
          aria-hidden="true"
          className={cn('sb-group-chevron', !isOpen && 'sb-group-chevron--closed')}
        />
      </button>

      {/* Animated content panel */}
      <div className={cn('sb-group-panel', !isOpen && 'sb-group-panel--closed')}>
        <div className="sb-group-list">
          {children}
        </div>
      </div>
    </div>
  );
}

/* ─── SubGroupLabel — simple static divider, not collapsible ── */

function SubGroupLabel({ label }: { label: string }) {
  return <div className="sb-subhead">{label}</div>;
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
  const showDashboard = !isSupport && (isAdmin || effectiveCustomer !== null);

  /* ── Product items filtered by role/account_type ───────── */

  // The account type the customer nav follows: the tenant's own, or — for an
  // admin in customer view — the previewed customer's (the admin user itself
  // has account_type null, which used to hide RCF and the whole group).
  const effectiveAccountType = isAdmin ? null : (effectiveCustomer?.account_type ?? user?.account_type ?? null);

  // Voicemail summary for the account the customer nav follows: a tenant's
  // own (no customer_id — the API scopes it), or the previewed customer for
  // an admin in customer view. Same cache key as the /voicemail page. Admins
  // in normal view and support never ask (admins always see it; the API
  // answers 403 to support). A failed call (e.g. the API predates
  // voicemail) just leaves it in Coming Soon.
  const voicemailScope = !effectiveCustomer
    ? null
    : isActualAdmin
      ? staffScope(effectiveCustomer.id)
      : tenantScope(effectiveCustomer.id);
  const voicemailSummary = useVoicemailSummary(
    voicemailScope ?? staffScope('all'),
    isAuthenticated && !isSupport && !isAdmin && voicemailScope !== null,
  );
  const voicemailLive = !isSupport && (isAdmin || (voicemailScope !== null && voicemailSummary.data?.enabled === true));
  const voicemailUnread = !isAdmin && voicemailLive ? (voicemailSummary.data?.unread_count ?? 0) : 0;

  const productNavItems = [
    ...allProductNavItems,
    ...(voicemailLive ? [{ ...voicemailNavItem, badge: voicemailUnread }] : []),
  ].filter((item) => {
    if (isAdmin) return true;
    if (item.adminOnly) return false;
    if (item.accountTypes && effectiveAccountType) {
      return item.accountTypes.includes(effectiveAccountType);
    }
    return !item.accountTypes;
  });
  // Coming Soon without Visual Voicemail once it is live for this viewer.
  const soonItems = voicemailLive
    ? COMING_SOON_ITEMS.filter((i) => i.label !== VOICEMAIL_SOON_LABEL)
    : COMING_SOON_ITEMS;
  // Never render an empty Products header (e.g. trunk-only accounts).
  const showProducts = !isSupport && productNavItems.length > 0;

  // Auto-expand group when current route lives inside it
  useEffect(() => {
    const path = location.pathname;

    const productPaths = productNavItems.map((i) => i.to);
    const adminPaths   = ['/admin', '/call-quality', '/troubleshooting', '/cdrs'];
    const inProducts = productPaths.some((p) => path === p || path.startsWith(p + '/'));
    const inAdmin    = adminPaths.some((p) => path === p || path.startsWith(p + '/'));
    const inSoon     = soonItems.some((i) => isSoonItemActive(i, path));
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

  // Escape closes the mobile drawer.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

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
    label: 'Calls & Quality', to: '/cdrs', accent: 'green', icon: <IconSignal size={17} />,
    // Light up on either alias of the merged page.
    isActiveFn: (p) => p.startsWith('/cdrs') || p.startsWith('/call-quality'),
  };
  const callQualityItem: NavItemDef = { label: 'Call Quality',        to: '/call-quality',    accent: 'green', icon: <IconSignal size={17} /> };
  const troubleItem: NavItemDef     = { label: 'Troubleshooting',     to: '/troubleshooting', accent: 'amber', icon: <IconTroubleshoot size={17} /> };

  /* ─────────────────────────────────────────────────────── */

  return (
    <>
      {/* Mobile topbar (<768px): menu, brand, theme toggle */}
      <div className="sb-topbar">
        <button
          type="button"
          onClick={() => setMobileOpen((o) => !o)}
          className="sb-iconbtn"
          aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={mobileOpen}
        >
          {mobileOpen
            ? <X size={20} strokeWidth={2} aria-hidden="true" />
            : <Menu size={20} strokeWidth={2} aria-hidden="true" />}
        </button>
        <button type="button" onClick={handleBrandClick} className="sb-brand" aria-label="Granite CRAG — home">
          <BrandLockup />
        </button>
        {isAuthenticated && <ThemeToggle placement="topbar" />}
      </div>

      {/* Mobile overlay */}
      {mobileOpen && <div onClick={closeMobile} aria-hidden="true" className="sb-scrim" />}

      {/* Sidebar panel */}
      <aside
        className={cn(
          'sb app-sidebar fixed top-0 left-0 bottom-0 z-[100]',
          'flex flex-col',
          'md:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
          // Desktop collapse — applied ≥768px only (see app-shell.css). Uses
          // `transform` so it composes with the Tailwind `translate` classes
          // above instead of fighting them.
          collapsed && 'app-sidebar--collapsed',
          customerViewMode && 'sb--customer-view',
        )}
        aria-label="Main navigation"
      >
        {/* ── Customer view banner ────────────────────────── */}
        {customerViewMode && (
          <div className="sb-banner">
            <div className="sb-banner-head">
              <Eye size={11} aria-hidden="true" style={{ flexShrink: 0 }} />
              <span className="sb-banner-title">Viewing as Customer</span>
            </div>
            {/* Which customer the customer pages show (admin preview only). */}
            {isActualAdmin && <CustomerPreviewPicker tone="dark" label="Customer" />}
          </div>
        )}

        {/* ── Brand area ─────────────────────────────────── */}
        <button type="button" onClick={handleBrandClick} className="sb-brand" aria-label="Granite CRAG — home">
          <BrandLockup />
        </button>

        <div className="sb-divider" aria-hidden="true" />

        {/* ── Unauthenticated: sign-in form ─────────────────── */}
        {!isAuthenticated && (
          <div className="sb-scroll" style={{ display: 'flex', flexDirection: 'column' }}>
            <SidebarLoginForm />
          </div>
        )}

        {/* ── Scrollable nav area (authenticated only) ────── */}
        {isAuthenticated && (
          <nav className="sb-scroll sb-nav" aria-label="Sections">
            {/* ── Dashboard — the account home (admin: all customers), top-level ─ */}
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
            {!isSupport && soonItems.length > 0 && (
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
                  {soonItems.map((item) => {
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
            <div className="sb-divider" aria-hidden="true" />

            {/* ── Customer view toggle (admin only) ───────── */}
            {isActualAdmin && (
              <div className="sb-viewas-wrap">
                <button
                  type="button"
                  onClick={toggleCustomerView}
                  title={customerViewMode ? 'Return to admin view' : 'Preview the app as a customer'}
                  aria-pressed={customerViewMode}
                  className={cn('sb-viewas', customerViewMode && 'sb-viewas--on')}
                >
                  {customerViewMode
                    ? <EyeOff size={13} className="sb-viewas-glyph" aria-hidden="true" />
                    : <Eye    size={13} className="sb-viewas-glyph" aria-hidden="true" />}
                  <span className="sb-viewas-label">
                    {customerViewMode ? 'Exit Customer View' : 'View as Customer'}
                  </span>
                  {customerViewMode && <span className="sb-viewas-pill">ON</span>}
                </button>
              </div>
            )}

            {/* ── User profile footer ──────────────────────── */}
            <div className="sb-footer">
              <div className="sb-user">
                {/* Clickable area: avatar + name — THE entry to /my-account */}
                <NavLink
                  to="/my-account"
                  onClick={closeMobile}
                  title="My account"
                  aria-label="My account"
                  className={({ isActive }) => cn('sb-account-link', isActive && 'sb-account-link--active')}
                >
                  <div className="sb-avatar" aria-hidden="true">
                    {displayName.charAt(0) || '?'}
                  </div>
                  <div className="sb-user-text">
                    <div className="sb-name">{displayName}</div>
                    <div className="sb-meta">{contextLabel ?? displayEmail}</div>
                  </div>
                </NavLink>

                {/* Account actions: light/dark + sign out */}
                <div className="sb-user-actions">
                  <ThemeToggle placement="sidebar" />
                  <button type="button" onClick={logout} className="sb-action sb-signout">
                    <LogOut size={13} strokeWidth={2} aria-hidden="true" />
                    Sign out
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

      </aside>
    </>
  );
}
