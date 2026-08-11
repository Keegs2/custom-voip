/**
 * PlatformManagementPage — the Platform Management tab shell (/admin/platform).
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` classes in index.css) —
 * this shell OWNS the paper canvas (`dl-scope` + `dl-shell`), the quiet
 * breadcrumb header, and the centered `dl-tabs` rail. Child routes render
 * into the <Outlet/> below the rail and must NOT re-apply `dl-scope`
 * themselves — they contribute toolbars/panels/tables only.
 */

import { NavLink, Outlet, useLocation } from 'react-router-dom';

interface PlatformTab {
  label: string;
  to: string;
}

const platformTabs: PlatformTab[] = [
  { label: 'Carrier Trunks', to: '/admin/platform/carriers' },
  { label: 'CDRs',           to: '/admin/platform/cdrs'     },
  { label: 'Rates',          to: '/admin/platform/rates'    },
  { label: 'Tiers',          to: '/admin/platform/tiers'    },
  { label: 'STIR/SHAKEN',    to: '/admin/platform/stir'     },
  { label: 'DID Search',     to: '/admin/platform/dids'     },
];

export function PlatformManagementPage() {
  const location = useLocation();

  return (
    <div className="dl-scope">
      <div className="dl-shell">
        {/* ── Quiet page header ── */}
        <header className="dl-header fx-load">
          <div className="dl-header-id">
            <div className="dl-crumb">
              <span>Platform Management</span>
              <span className="dl-crumb-sep" aria-hidden="true">/</span>
              <span>Granite CRAG</span>
            </div>
            <h1 className="dl-title">Platform Configuration</h1>
            <p className="dl-sub">
              Carrier trunks, CDR management, rates, and tiers.
            </p>
          </div>
        </header>

        {/* ── Tab rail ── */}
        <nav
          className="dl-tabs fx-load fx-load-d1"
          role="tablist"
          aria-label="Platform sections"
        >
          {platformTabs.map((tab) => {
            // No platform tab path is a prefix of another, so exact-or-subpath
            // matching is unambiguous here (unlike the Customer Management rail).
            const isActive =
              location.pathname === tab.to ||
              location.pathname.startsWith(tab.to + '/');

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
