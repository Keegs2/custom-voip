import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { cn } from '../../utils/cn';

interface NavItem {
  label: string;
  icon: string;
  to: string;
}

const productNavItems: NavItem[] = [
  { label: 'RCF',         icon: '📞', to: '/rcf' },
  { label: 'API Calling', icon: '🔗', to: '/api-dids' },
  { label: 'SIP Trunks', icon: '🏗️', to: '/trunks' },
  { label: 'IVR Builder', icon: '🎛️', to: '/ivr' },
  { label: 'API Docs',   icon: '📖', to: '/docs' },
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
          'flex items-center gap-[11px] px-5 py-[10px] cursor-pointer select-none',
          'text-[0.9rem] font-medium border-l-[3px] no-underline',
          'transition-[color,background,border-color] duration-150',
          isActive
            ? 'text-[#3b82f6] bg-[rgba(59,130,246,0.08)] border-l-[#3b82f6]'
            : 'text-[#718096] border-l-transparent hover:text-[#e2e8f0] hover:bg-white/[0.03]',
        )
      }
    >
      <span className="text-[1rem] w-[18px] text-center flex-shrink-0 leading-none">
        {item.icon}
      </span>
      {item.label}
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
      <div className="md:hidden flex items-center gap-3 px-5 py-[14px] bg-[#0d0f15] border-b border-[#2a2f45] sticky top-0 z-50">
        <button
          type="button"
          onClick={() => setMobileOpen((o) => !o)}
          className="bg-none border-none cursor-pointer text-[#e2e8f0] text-[1.3rem] leading-none p-1"
          aria-label="Toggle navigation"
        >
          ☰
        </button>
        <span className="text-[1rem] font-bold text-[#e2e8f0]">Custom VoIP</span>
      </div>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={closeMobile}
          aria-hidden="true"
        />
      )}

      {/* Sidebar panel */}
      <aside
        className={cn(
          'fixed top-0 left-0 bottom-0 w-[240px] z-[100]',
          'bg-[#0d0f15] border-r border-[#2a2f45]',
          'flex flex-col transition-transform duration-[250ms] ease-in-out',
          // Desktop: always visible
          'md:translate-x-0',
          // Mobile: slide in/out
          mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        )}
        aria-label="Main navigation"
      >
        {/* Brand */}
        <div
          className="px-5 pt-6 pb-5 border-b border-[#2a2f45] cursor-pointer select-none"
          onClick={handleBrandClick}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && handleBrandClick()}
        >
          <div
            className="text-[1.15rem] font-extrabold tracking-[-0.2px] text-[#e2e8f0]"
            style={{ textShadow: '0 0 22px rgba(59, 130, 246, 0.5)' }}
          >
            Custom <span className="text-[#3b82f6]">VoIP</span>
          </div>
          <div className="text-[0.72rem] text-[#718096] mt-[3px] tracking-[0.3px]">
            Voice Platform
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-3 overflow-y-auto">
          <div className="text-[0.65rem] font-bold text-[#718096] uppercase tracking-[1px] px-5 pt-4 pb-1.5">
            Products
          </div>
          {productNavItems.map((item) => (
            <SidebarNavItem key={item.to} item={item} onNavigate={closeMobile} />
          ))}
        </nav>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-[#2a2f45]">
          <NavLink
            to="/admin"
            onClick={closeMobile}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-[11px] text-[0.9rem] font-medium no-underline',
                'transition-colors duration-150',
                isActive ? 'text-[#3b82f6]' : 'text-[#718096] hover:text-[#e2e8f0]',
              )
            }
          >
            <span className="text-[1rem] w-[18px] text-center flex-shrink-0 leading-none">⚙️</span>
            Administration
          </NavLink>
        </div>
      </aside>
    </>
  );
}
