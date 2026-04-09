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
          'group flex items-center gap-3 px-4 py-2.5 mx-2 cursor-pointer select-none',
          'text-sm font-medium rounded-lg no-underline',
          'transition-all duration-150',
          isActive
            ? 'text-[#e2e8f0] bg-[rgba(59,130,246,0.12)] shadow-[inset_3px_0_0_#3b82f6]'
            : 'text-[#718096] hover:text-[#cbd5e0] hover:bg-white/[0.04]',
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
        <span className="text-sm font-bold text-[#e2e8f0]">Custom VoIP</span>
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
          'bg-[#0d0f15] border-r border-[#2a2f45]',
          'flex flex-col transition-transform duration-[250ms] ease-in-out',
          'md:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        )}
        aria-label="Main navigation"
      >
        {/* Brand */}
        <div
          className="px-5 pt-5 pb-4 border-b border-[#2a2f45] cursor-pointer select-none"
          onClick={handleBrandClick}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && handleBrandClick()}
        >
          <div
            className="text-lg font-extrabold tracking-tight text-[#e2e8f0]"
            style={{ textShadow: '0 0 28px rgba(59, 130, 246, 0.45)' }}
          >
            Custom <span className="text-[#3b82f6]">VoIP</span>
          </div>
          <div className="text-xs text-[#4a5568] mt-0.5 tracking-wide font-medium">
            Voice Platform
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-4 overflow-y-auto">
          <div className="text-[0.65rem] font-bold text-[#4a5568] uppercase tracking-[1.2px] px-6 mb-2">
            Products
          </div>
          <div className="flex flex-col gap-0.5">
            {productNavItems.map((item) => (
              <SidebarNavItem key={item.to} item={item} onNavigate={closeMobile} />
            ))}
          </div>
        </nav>

        {/* Footer */}
        <div className="px-2 py-3 border-t border-[#2a2f45]">
          <NavLink
            to="/admin"
            onClick={closeMobile}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium no-underline',
                'transition-all duration-150',
                isActive
                  ? 'text-[#e2e8f0] bg-[rgba(59,130,246,0.12)] shadow-[inset_3px_0_0_#3b82f6]'
                  : 'text-[#718096] hover:text-[#cbd5e0] hover:bg-white/[0.04]',
              )
            }
          >
            <span className="text-base w-5 text-center flex-shrink-0 leading-none">⚙️</span>
            <span>Administration</span>
          </NavLink>
        </div>
      </aside>
    </>
  );
}
