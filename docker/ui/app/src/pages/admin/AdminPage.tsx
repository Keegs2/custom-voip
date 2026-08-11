/**
 * AdminPage — the Customer Management tab shell (/admin).
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` classes in index.css) —
 * this shell OWNS the paper canvas (`dl-scope` + `dl-shell`), the quiet
 * breadcrumb header, and the centered `dl-tabs` rail. Child routes render
 * into the <Outlet/> below the rail and must NOT re-apply `dl-scope`
 * themselves — they contribute toolbars/panels/tables only.
 */

import { NavLink, Outlet, useLocation } from 'react-router-dom';

interface AdminTab {
  label: string;
  to: string;
}

const adminTabs: AdminTab[] = [
  { label: 'Onboarding',      to: '/admin/onboarding'      },
  { label: 'Customers',       to: '/admin/customers'       },
  { label: 'Customer Trunks', to: '/admin/trunks'          },
  { label: 'User Lookup',     to: '/admin/customers/users' },
];

export function AdminPage() {
  const location = useLocation();

  return (
    <div className="dl-scope">
      <div className="dl-shell">
        {/* ── Quiet page header ── */}
        <header className="dl-header fx-load">
          <div className="dl-header-id">
            <div className="dl-crumb">
              <span>Customer Management</span>
              <span className="dl-crumb-sep" aria-hidden="true">/</span>
              <span>Granite CRAG</span>
            </div>
            <h1 className="dl-title">Customer Administration</h1>
            <p className="dl-sub">
              Manage customer accounts, trunks, and configurations.
            </p>
          </div>
        </header>

        {/* ── Tab rail ── */}
        <nav
          className="dl-tabs fx-load fx-load-d1"
          role="tablist"
          aria-label="Customer management sections"
        >
          {adminTabs.map((tab) => {
            // Exact match, or sub-path match — but exclude cases where
            // a longer tab path is a better match (e.g. /admin/customers
            // should not match when /admin/customers/users is the actual tab).
            const hasMoreSpecificTab = adminTabs.some(
              (other) => other !== tab && other.to.startsWith(tab.to + '/') && location.pathname.startsWith(other.to),
            );
            const isActive = !hasMoreSpecificTab && (
              location.pathname === tab.to ||
              location.pathname.startsWith(tab.to + '/')
            );

            return (
              <NavLink
                key={tab.to}
                to={tab.to}
                role="tab"
                aria-selected={isActive}
                className={isActive ? 'dl-tab dl-tab-active' : 'dl-tab'}
                style={{ textDecoration: 'none' }}
              >
                {tab.label}
              </NavLink>
            );
          })}
        </nav>

        {/* ── Page content — remount per route for the entry fade ── */}
        <div key={location.pathname} className="fx-load fx-load-d2">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
