import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { cn } from '../../utils/cn';

interface NavItem {
  label: string;
  icon: string;
  to: string;
  color: string;
}

const productNavItems: NavItem[] = [
  { label: 'RCF',         icon: '📞', to: '/rcf',      color: '#4ade80' },
  { label: 'API Calling', icon: '🔗', to: '/api-dids', color: '#c084fc' },
  { label: 'SIP Trunks', icon: '🏗️', to: '/trunks',   color: '#fbbf24' },
  { label: 'IVR Builder', icon: '🎛️', to: '/ivr',      color: '#22d3ee' },
  { label: 'API Docs',   icon: '📖', to: '/docs',     color: '#94a3b8' },
];

interface SidebarNavItemProps {
  item: NavItem;
  onNavigate?: () => void;
}

function SidebarNavItem({ item, onNavigate }: SidebarNavItemProps) {
  return (
    <NavLink
      to={item.to}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'group flex items-center gap-3 px-3 py-2.5 cursor-pointer select-none',
          'text-sm font-medium rounded-lg no-underline',
          'transition-all duration-200',
          isActive
            ? 'text-[#e2e8f0] bg-[rgba(59,130,246,0.1)] shadow-[inset_3px_0_0_#3b82f6]'
            : 'text-[#718096] hover:text-[#cbd5e0] hover:bg-white/[0.05]',
        )
      }
    >
      <span className="text-base w-5 text-center flex-shrink-0 leading-none">
        {item.icon}
      </span>
      <span className="truncate">{item.label}</span>
    </NavLink>
  );
}

export function Sidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();

  const handleBrandClick = () => {
    navigate('/');
    setMobileOpen(false);
  };

  const closeMobile = () => setMobileOpen(false);

  return (
    <>
      {/* Mobile topbar */}
      <div className="md:hidden flex items-center gap-3 px-5 py-3.5 bg-[#0d0f15] border-b border-[#2a2f45] sticky top-0 z-50">
        <button
          type="button"
          onClick={() => setMobileOpen((o) => !o)}
          className="text-[#e2e8f0] text-xl leading-none p-1 rounded hover:bg-white/[0.06] transition-colors"
          aria-label="Toggle navigation"
        >
          ☰
        </button>
        <span
          className="text-sm font-extrabold text-[#e2e8f0] tracking-tight"
          style={{ textShadow: '0 0 20px rgba(59, 130, 246, 0.5)' }}
        >
          Custom <span className="text-[#3b82f6]">VoIP</span>
        </span>
      </div>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-40 md:hidden backdrop-blur-sm"
          onClick={closeMobile}
          aria-hidden="true"
        />
      )}

      {/* Sidebar panel */}
      <aside
        className={cn(
          'fixed top-0 left-0 bottom-0 w-[240px] z-[100]',
          'bg-[#0d0f15] border-r border-[#2a2f45]/80',
          'flex flex-col transition-transform duration-[250ms] ease-in-out',
          'md:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        )}
        aria-label="Main navigation"
      >
        {/* Brand */}
        <div
          className="px-3 pt-6 pb-5 cursor-pointer select-none"
          onClick={handleBrandClick}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && handleBrandClick()}
        >
          <div
            className="text-xl font-extrabold tracking-tight text-[#e2e8f0] px-3"
            style={{ textShadow: '0 0 32px rgba(59, 130, 246, 0.5)' }}
          >
            Custom <span className="text-[#3b82f6]">VoIP</span>
          </div>
          <div className="text-[0.7rem] text-[#4a5568] mt-1 px-3 tracking-widest font-semibold uppercase">
            Voice Platform
          </div>
        </div>

        {/* Divider */}
        <div className="mx-3 h-px bg-[#2a2f45]/60" />

        {/* Nav */}
        <nav className="flex-1 px-3 py-5 overflow-y-auto">
          <div className="text-[0.6rem] font-bold text-[#4a5568] uppercase tracking-[1.5px] px-3 mb-3">
            Products
          </div>
          <div className="flex flex-col gap-0.5">
            {productNavItems.map((item) => (
              <SidebarNavItem key={item.to} item={item} onNavigate={closeMobile} />
            ))}
          </div>
        </nav>

        {/* Footer */}
        <div className="mt-auto px-3 py-4 border-t border-[#2a2f45]/60">
          <NavLink
            to="/admin"
            onClick={closeMobile}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium no-underline',
                'transition-all duration-200',
                isActive
                  ? 'text-[#e2e8f0] bg-[rgba(59,130,246,0.1)] shadow-[inset_3px_0_0_#3b82f6]'
                  : 'text-[#718096] hover:text-[#cbd5e0] hover:bg-white/[0.05]',
              )
            }
          >
            <span className="text-base w-5 text-center flex-shrink-0 leading-none">⚙️</span>
            <span>Administration</span>
          </NavLink>
          <div className="px-3 pt-3 text-[0.65rem] text-[#4a5568] font-medium">
            v1.0 &middot; Voice Platform
          </div>
        </div>
      </aside>
    </>
  );
}
