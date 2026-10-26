/**
 * MyAccountPage — the customer's self-service account console.
 *
 * Tabs: Overview (account + products beside the estimated bill), Users &
 * Access (read-only team roster), Products (per-product provisioning lists),
 * and Your Account (the signed-in user's profile + password, PUT /auth/me —
 * absorbed the retired standalone /account page). The tabs live in
 * `pages/my-account/`; this file is the route entry, the header and the rail.
 *
 * Whose account: a tenant's own (self-scoped endpoints). An admin in "View
 * as Customer" with a preview customer picked sees THAT customer's account
 * (staff endpoints, `my-account/myAccountData.ts` — the admin's own
 * `customer_id` is null, §4) and their own profile under Your Account. Staff
 * with no customer (admin normal view, support) get the "No customer
 * account" notice and Your Account.
 *
 * Number counts are holistic when the API sends `counts.numbers` (every
 * product's numbers, config/products.ts names them): one header figure per
 * product, a Voicemail section on Products when the account has mailbox
 * numbers. Without it (an older API) the page shows the legacy counts.
 *
 * Layout (docker/ui/CLAUDE.md §20): a one-row CompactHeader, the tab rail,
 * then each tab balanced and compact; rarely-used detail (bill line
 * breakdown, inactive users, the password form) sits in expandable rows.
 *
 * React #310: every hook in every component is called unconditionally at the
 * top of its function, before any early return.
 */
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AlertTriangle, Boxes, IdCard, ShieldCheck, Users } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { ApiError } from '../api/client';
import { API_CALLING_ENABLED } from '../config/features';
import { productMix, productTag } from '../config/products';
import type { MyCustomer } from '../types/account';
import { CompactHeader, type HeaderStat } from '../components/layout/kit';
import { Spinner } from '../components/ui/Spinner';
import { SELF_SCOPE, useAccountRecord, type AccountScope } from './my-account/myAccountData';
import { Section } from './my-account/parts';
import { OverviewTab } from './my-account/OverviewTab';
import { TeamTab } from './my-account/TeamTab';
import { ProductsTab } from './my-account/ProductsTab';
import { SecurityTab } from './my-account/SecurityTab';
import '../styles/my-account.css';

/* ═════════════════ Tab rail ═════════════════ */

type Tab = 'overview' | 'team' | 'products' | 'security';

interface TabDef {
  id: Tab;
  label: string;
  icon: ReactNode;
}

const TABS: readonly TabDef[] = [
  { id: 'overview', label: 'Overview', icon: <IdCard size={15} strokeWidth={1.8} /> },
  { id: 'team', label: 'Users & Access', icon: <Users size={15} strokeWidth={1.8} /> },
  { id: 'products', label: 'Products', icon: <Boxes size={15} strokeWidth={1.8} /> },
  { id: 'security', label: 'Your Account', icon: <ShieldCheck size={15} strokeWidth={1.8} /> },
];

function AccountTabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = (i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
    onChange(TABS[next].id);
    refs.current[next]?.focus();
  };

  return (
    <div className="dl-tabs dl-tabs-scroll ma-tabs fx-load fx-load-d1" role="tablist" aria-label="My Account">
      {TABS.map((t, i) => {
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={`ma-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-controls={isActive ? `ma-panel-${t.id}` : undefined}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={isActive ? 'dl-tab dl-tab-active' : 'dl-tab'}
          >
            <span className="ma-tab-icon" aria-hidden="true">
              {t.icon}
            </span>
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/* ═════════════════ Header figures ═════════════════ */

function headerStats(customer: MyCustomer | undefined): HeaderStat[] {
  const counts = customer?.counts;
  if (!counts) return [];
  const stats: HeaderStat[] = [];
  const byProduct = counts.numbers?.by_product;
  if (byProduct) {
    // One figure per product with numbers: "RCF numbers", "Voicemail numbers", …
    for (const m of productMix(byProduct)) stats.push({ label: `${productTag(m.product)} numbers`, value: m.count.toLocaleString() });
  } else if (counts.rcf > 0) {
    stats.push({ label: 'RCF numbers', value: counts.rcf.toLocaleString() });
  }
  if (counts.trunks > 0) stats.push({ label: 'SIP trunks', value: counts.trunks.toLocaleString() });
  if (API_CALLING_ENABLED && counts.api_dids > 0) stats.push({ label: 'API DIDs', value: counts.api_dids.toLocaleString() });
  return stats;
}

/* ═════════════════ Page ═════════════════ */

export function MyAccountPage() {
  // ── ALL hooks unconditionally at the top — React #310 guard ──
  const { user, refreshUser, isActualAdmin, customerViewMode, effectiveCustomer } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>('overview');

  // An admin previewing a customer reads that customer through the staff
  // endpoints; everyone else reads their own account.
  const previewId = isActualAdmin && customerViewMode && effectiveCustomer ? effectiveCustomer.id : null;
  const scope = useMemo<AccountScope>(
    () => (previewId !== null ? { kind: 'staff', customerId: previewId } : SELF_SCOPE),
    [previewId],
  );
  const { data: customer, isLoading, isError, error } = useAccountRecord(scope);

  // ── Early returns only after all hooks ──
  if (!user) return null;

  const noCustomer = isError && error instanceof ApiError && error.status === 404;
  const stats = isLoading ? [] : headerStats(customer);
  const staff = scope.kind === 'staff';

  const panel = (id: Tab, content: ReactNode) => (
    <div role="tabpanel" id={`ma-panel-${id}`} aria-labelledby={`ma-tab-${id}`} className="fx-load fx-load-d2">
      {content}
    </div>
  );
  const notice = <NoCustomerNotice noCustomer={noCustomer} onOpenAccount={() => setActiveTab('security')} />;

  return (
    <div className="dl-scope ma-scope">
      <div className="dl-shell ma-shell">
        <CompactHeader
          className="ma-head fx-load"
          crumb={
            <>
              <span>My Account</span>
              <span className="dl-crumb-sep" aria-hidden="true">
                /
              </span>
              <span>Granite CRAG</span>
              {staff && <span className="ma-staff-tag">Staff preview</span>}
            </>
          }
          title={customer ? customer.name : 'My Account'}
          subtitle="Your organization, users, products, and sign-in security in one place."
          stats={stats}
          statsLabel="Account totals"
        />

        {isLoading ? (
          <div className="ma-page-loading">
            <Spinner size="lg" />
            <span>Loading your account…</span>
          </div>
        ) : (
          <>
            <AccountTabBar active={activeTab} onChange={setActiveTab} />

            {/* Overview / Team / Products depend on the customer record. */}
            {activeTab === 'overview' && panel('overview', customer ? <OverviewTab customer={customer} scope={scope} /> : notice)}
            {activeTab === 'team' && panel('team', <TeamTab scope={scope} />)}
            {activeTab === 'products' && panel('products', customer ? <ProductsTab customer={customer} scope={scope} /> : notice)}
            {activeTab === 'security' && panel('security', <SecurityTab user={user} onRefresh={refreshUser} />)}
          </>
        )}
      </div>
    </div>
  );
}

/** Friendly notice when the caller has no customer record (404) or the load failed. */
function NoCustomerNotice({ noCustomer, onOpenAccount }: { noCustomer: boolean; onOpenAccount: () => void }) {
  return (
    <Section
      id="ma-nocustomer"
      title={noCustomer ? 'No customer account' : 'Unable to load account'}
      subtitle={noCustomer ? 'Your login is not associated with a customer' : 'Please try again shortly'}
      icon={<AlertTriangle size={16} strokeWidth={1.8} />}
    >
      <div className="dl-banner dl-banner-warn ma-notice">
        <AlertTriangle size={18} aria-hidden="true" />
        <span>
          {noCustomer
            ? 'This account is not linked to a customer. You can still manage your profile and password under Your Account.'
            : 'We could not load your account details right now. Your profile and password are still available under Your Account.'}
        </span>
        <button type="button" className="dl-btn dl-btn-ghost ma-notice-btn" onClick={onOpenAccount}>
          Open Your Account
        </button>
      </div>
    </Section>
  );
}
