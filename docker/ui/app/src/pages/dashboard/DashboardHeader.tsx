/**
 * DashboardHeader — the page's one bold element: a compact granite band with
 * the account identity on the left and the product switcher + primary action
 * on the right.
 *
 *   Remote call forwarding
 *   Granite Crag   ● Active · Customer since March 2026     [ Call forwarding | SIP Trunking Soon | … ]  [+ Request numbers]
 *
 * Granite gradient, inner top highlight, a soft cobalt radial glow and a 2px
 * azure light-line along the bottom edge (account-dashboard.css). The
 * switcher is a segmented pill driven by products.ts: available products are
 * pressable, the rest are dimmed with a "Soon" tag (aria-disabled, still
 * focusable so the roadmap is discoverable by keyboard).
 */
import type { CSSProperties } from 'react';
import type { AccountType, CustomerStatus } from '../../types/customer';
import { DASHBOARD_PRODUCTS, isProductAvailable, type DashboardProductId } from './products';

const STATUS_WORD: Record<CustomerStatus, string> = {
  active: 'Active',
  suspended: 'Suspended',
  closed: 'Closed',
};

export interface DashboardHeaderProps {
  name: string;
  status: CustomerStatus | null;
  since: string | null;
  accountType: AccountType | null;
  /** Staff previewing this account in "View as Customer". */
  previewing: boolean;
  activeProduct: DashboardProductId | null;
  onSelectProduct: (id: DashboardProductId) => void;
  /** Primary action label, or null to hide it. */
  actionLabel: string | null;
  onAction: () => void;
}

export function DashboardHeader({
  name,
  status,
  since,
  accountType,
  previewing,
  activeProduct,
  onSelectProduct,
  actionLabel,
  onAction,
}: DashboardHeaderProps) {
  const statusTone = status === 'active' ? 'on' : status ? 'off' : null;
  const kicker = DASHBOARD_PRODUCTS.find((p) => p.id === activeProduct)?.title ?? 'Your account';

  return (
    <header className="ad-header ad-rise" style={{ '--i': 0 } as CSSProperties}>
      <div className="ad-header-glow" aria-hidden="true" />

      <div className="ad-header-id">
        <p className="ad-header-kicker">
          {kicker}
          {previewing && <span className="ad-preview-tag">Staff preview</span>}
        </p>
        <h1 className="ad-header-name">{name}</h1>
        <div className="ad-header-meta">
          {status && statusTone && (
            <span className={`ad-header-status ad-header-status-${statusTone}`}>
              <span className="ad-dot" aria-hidden="true" />
              {STATUS_WORD[status]}
            </span>
          )}
          {since && <span>Customer since {since}</span>}
        </div>
      </div>

      <div className="ad-header-tools">
        <div className="ad-switch-scroll">
          <div className="ad-switch" role="group" aria-label="Product">
            {DASHBOARD_PRODUCTS.map((p) => {
              const available = isProductAvailable(p, accountType);
              const active = p.id === activeProduct;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`ad-switch-opt${active ? ' ad-switch-opt-active' : ''}${available ? '' : ' ad-switch-opt-soon'}`}
                  aria-pressed={active}
                  aria-disabled={!available || undefined}
                  title={available ? undefined : p.live ? `${p.label} isn’t on this account` : `${p.label} — coming soon`}
                  onClick={() => {
                    if (available) onSelectProduct(p.id);
                  }}
                >
                  {p.label}
                  {!p.live && <span className="ad-soon">Soon</span>}
                </button>
              );
            })}
          </div>
        </div>

        {actionLabel && (
          <button type="button" className="ad-btn ad-btn-glow" onClick={onAction}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path d="M8 3v10M3 8h10" strokeLinecap="round" />
            </svg>
            {actionLabel}
          </button>
        )}
      </div>
    </header>
  );
}
