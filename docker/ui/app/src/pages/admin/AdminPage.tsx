import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { cn } from '../../utils/cn';

interface AdminTab {
  label: string;
  to: string;
  exact?: boolean;
}

const adminTabs: AdminTab[] = [
  { label: 'Customers',  to: '/admin/customers', exact: true },
  { label: 'CDRs',       to: '/admin/cdrs' },
  { label: 'Rates',      to: '/admin/rates' },
  { label: 'Tiers',      to: '/admin/tiers' },
  { label: 'Carriers',   to: '/admin/carriers' },
  { label: 'SIPp Test',  to: '/admin/sipp' },
  { label: 'Homer',      to: '/admin/homer' },
];

export function AdminPage() {
  const location = useLocation();

  // Show "Customers" as active when on the base /admin path
  const isAdminRoot = location.pathname === '/admin' || location.pathname === '/admin/';

  return (
    <div>
      <div className="mb-7 pb-5 border-b border-[#2a2f45]">
        <h1 className="text-[1.45rem] font-bold tracking-[-0.3px] text-[#e2e8f0]">
          Administration
        </h1>
        <p className="text-[0.82rem] text-[#718096] mt-1">
          Manage customers, billing, carriers, and platform configuration
        </p>
      </div>

      {/* Tab nav */}
      <nav
        className="flex gap-1 border-b border-[#2a2f45] mb-6 overflow-x-auto"
        role="tablist"
        aria-label="Admin sections"
      >
        {adminTabs.map((tab) => {
          const isActive =
            location.pathname === tab.to ||
            (tab.to === '/admin/customers' && isAdminRoot);

          return (
            <NavLink
              key={tab.to}
              to={tab.to}
              role="tab"
              aria-selected={isActive}
              className={cn(
                'px-4 py-2.5 text-[0.88rem] font-semibold whitespace-nowrap no-underline',
                'border-b-2 -mb-px transition-[color,border-color] duration-150',
                isActive
                  ? 'text-[#3b82f6] border-[#3b82f6]'
                  : 'text-[#718096] border-transparent hover:text-[#e2e8f0] hover:border-[#2a2f45]',
              )}
            >
              {tab.label}
            </NavLink>
          );
        })}
      </nav>

      <Outlet />
    </div>
  );
}
