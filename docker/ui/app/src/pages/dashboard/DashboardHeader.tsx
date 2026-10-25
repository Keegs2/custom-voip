/**
 * DashboardHeader — the page's one bold element: a compact granite band with
 * the identity on the left and the tools (scope picker, product switcher,
 * actions) on the right.
 *
 *   Remote call forwarding  [Staff]
 *   Granite Crag   ● Active · Customer since March 2026     [Viewing ▾] [ Call forwarding | SIP Trunking Soon ]  [+ Manage numbers]
 *
 * Granite gradient, inner top highlight, a soft cobalt radial glow and a 2px
 * azure light-line along the bottom edge (account-dashboard.css). The band
 * is dark in BOTH themes: the frame reads the page theme's --t-band-* set,
 * and the two content columns are pinned with data-force-theme="dark" so
 * every token inside (and the native <select> popup) is the dark set. The
 * switcher is a segmented pill driven by products.ts: available products are
 * pressable, the rest are dimmed with a "Soon" tag (aria-disabled, still
 * focusable so the roadmap is discoverable by keyboard). A product with its
 * own page that the account has switched on (`products.links`, e.g. Visual
 * Voicemail) is a plain link to that page instead.
 *
 * Used by every dashboard audience (tenant, staff preview, admin) and by the
 * admin /rcf console, which passes no switcher and its own metrics.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { AccountType, CustomerStatus } from '../../types/customer';
import { DASHBOARD_PRODUCTS, isProductAvailable, type DashboardProductId } from './products';

const STATUS_WORD: Record<CustomerStatus, string> = {
  active: 'Active',
  suspended: 'Suspended',
  closed: 'Closed',
};

export interface HeaderAction {
  label: string;
  onClick: () => void;
  /** Glyph before the label; defaults to a plus. */
  icon?: ReactNode;
}

export interface ProductSwitch {
  accountType: AccountType | null;
  active: DashboardProductId | null;
  onSelect: (id: DashboardProductId) => void;
  /**
   * Products with their own page (products.ts `href`) that are switched on
   * for this account, with the route each opens — e.g. Visual Voicemail →
   * /voicemail when GET /v1/voicemail/summary says `enabled`. Rendered as a
   * link (no "Soon", never the active panel). Absent = none.
   */
  links?: Partial<Record<DashboardProductId, string>>;
}

export interface DashboardHeaderProps {
  name: string;
  status: CustomerStatus | null;
  since: string | null;
  /** Small line above the name; defaults to the active product's title. */
  kicker?: string;
  /** Amber staff tag after the kicker ("Staff", "Staff preview"), or null. */
  tag?: string | null;
  /** Extra meta after status / since (e.g. "4 customers"). */
  meta?: ReactNode;
  /** Scope picker (admin), first in the tools row. */
  scope?: ReactNode;
  /** Product switcher, or omit to hide it. */
  products?: ProductSwitch;
  /** Primary action (azure glow button), or null. */
  action?: HeaderAction | null;
  /** Secondary action (quiet glass button), or null. */
  secondary?: HeaderAction | null;
  /** Extra content under the identity (e.g. the console's figures). */
  children?: ReactNode;
}

function PlusGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path d="M8 3v10M3 8h10" strokeLinecap="round" />
    </svg>
  );
}

export function DashboardHeader({
  name,
  status,
  since,
  kicker,
  tag = null,
  meta,
  scope,
  products,
  action = null,
  secondary = null,
  children,
}: DashboardHeaderProps) {
  const statusTone = status === 'active' ? 'on' : status ? 'off' : null;
  const kickerText =
    kicker ?? DASHBOARD_PRODUCTS.find((p) => p.id === products?.active)?.title ?? 'Your account';

  return (
    <header className="ad-header ad-rise" style={{ '--i': 0 } as CSSProperties}>
      <div className="ad-header-glow" aria-hidden="true" />

      <div className="ad-header-id" data-force-theme="dark">
        <p className="ad-header-kicker">
          {kickerText}
          {tag && <span className="ad-preview-tag">{tag}</span>}
        </p>
        <h1 className="ad-header-name">{name}</h1>
        {(status || since || meta) && (
          <div className="ad-header-meta">
            {status && statusTone && (
              <span className={`ad-header-status ad-header-status-${statusTone}`}>
                <span className="ad-dot" aria-hidden="true" />
                {STATUS_WORD[status]}
              </span>
            )}
            {since && <span>Customer since {since}</span>}
            {meta}
          </div>
        )}
        {children}
      </div>

      <div className="ad-header-tools" data-force-theme="dark">
        {scope}

        {products && (
          <div className="ad-switch-scroll">
            <div className="ad-switch" role="group" aria-label="Product">
              {DASHBOARD_PRODUCTS.map((p) => {
                const linkTo = p.href ? products.links?.[p.id] : undefined;
                if (linkTo) {
                  return (
                    <Link key={p.id} to={linkTo} className="ad-switch-opt ad-switch-opt-link" title={`Open ${p.label}`}>
                      {p.label}
                      <svg className="ad-switch-go" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M5 11 11 5M11 5H6M11 5v5" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </Link>
                  );
                }
                const available = isProductAvailable(p, products.accountType);
                const active = p.id === products.active;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`ad-switch-opt${active ? ' ad-switch-opt-active' : ''}${available ? '' : ' ad-switch-opt-soon'}`}
                    aria-pressed={active}
                    aria-disabled={!available || undefined}
                    title={available ? undefined : p.live ? `${p.label} isn’t on this account` : `${p.label} — coming soon`}
                    onClick={() => {
                      if (available) products.onSelect(p.id);
                    }}
                  >
                    {p.label}
                    {!p.live && <span className="ad-soon">Soon</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {(secondary || action) && (
          <div className="ad-header-actions">
            {secondary && (
              <button type="button" className="ad-btn ad-btn-glass" onClick={secondary.onClick}>
                {secondary.icon}
                {secondary.label}
              </button>
            )}
            {action && (
              <button type="button" className="ad-btn ad-btn-glow" onClick={action.onClick}>
                {action.icon ?? <PlusGlyph />}
                {action.label}
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
