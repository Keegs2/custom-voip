import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { cn } from '../../utils/cn';

interface AdminTab {
  label: string;
  to: string;
}

const adminTabs: AdminTab[] = [
  { label: 'Customers', to: '/admin/customers' },
  { label: 'CDRs',      to: '/admin/cdrs' },
  { label: 'Rates',     to: '/admin/rates' },
  { label: 'Tiers',     to: '/admin/tiers' },
  { label: 'Carriers',  to: '/admin/carriers' },
  { label: 'SIPp Test', to: '/admin/sipp' },
  { label: 'Homer',     to: '/admin/homer' },
];

export function AdminPage() {
  const location = useLocation();
  const isAdminRoot = location.pathname === '/admin' || location.pathname === '/admin/';

  return (
    <div>
      {/* Page header */}
      <div className="mb-6 pb-5 border-b border-[#2a2f45]/70">
        <h1 className="text-xl font-semibold tracking-tight text-[#e2e8f0]">
          Administration
        </h1>
        <p className="text-sm text-[#718096] mt-1">
          Manage customers, billing, carriers, and platform configuration
        </p>
      </div>

      {/* Tab nav */}
      <nav
        className="flex gap-0 border-b border-[#2a2f45]/70 mb-8 overflow-x-auto"
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
                'px-4 py-2.5 text-sm font-medium whitespace-nowrap no-underline',
                'border-b-2 -mb-px transition-all duration-150',
                'focus-visible:outline-none',
                isActive
                  ? 'text-[#3b82f6] border-[#3b82f6]'
                  : 'text-[#718096] border-transparent hover:text-[#cbd5e0] hover:border-[#363c57]',
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
