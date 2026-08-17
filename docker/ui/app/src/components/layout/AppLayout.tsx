import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { SidebarCollapseTab } from './SidebarCollapse';
import { useSidebarCollapse } from './useSidebarCollapse';
import { useAuth } from '../../contexts/AuthContext';
import { cn } from '../../utils/cn';

export function AppLayout() {
  // Hooks first, unconditionally — React #310 guard (see CLAUDE.md §13).
  const { isAuthenticated, isLoading } = useAuth();
  const { collapsed, toggleCollapsed } = useSidebarCollapse();

  // The sidebar (and its 240px offset) only exists for signed-in users.
  // Signed-out visitors can only ever reach '/' inside this layout —
  // RequireAuth redirects every other route there — so they get a
  // full-width canvas and the landing page handles sign-in itself.
  const showSidebar = isAuthenticated && !isLoading;
  const sidebarOpen = showSidebar && !collapsed;

  return (
    <div className="min-h-screen bg-[#0f1117]">
      {showSidebar && <Sidebar collapsed={collapsed} />}

      {/* Collapse/expand tab — shared with TroubleshootingPage via
          SidebarCollapse.tsx (state persists under `sidebar_collapsed`). */}
      {showSidebar && (
        <SidebarCollapseTab collapsed={collapsed} onToggle={toggleCollapsed} />
      )}

      {/* Main content — offset by the fixed sidebar width when signed in and
          expanded; the margin animates in sync with the sidebar slide */}
      <main
        className={cn(
          'min-h-screen flex flex-col app-main',
          sidebarOpen && 'app-main--sidebar',
        )}
      >
        {/* Inner wrapper: fills the full width between the sidebar (if any) and the right edge */}
        <div
          className="flex-1 flex flex-col py-8 pb-20"
          style={{ width: '100%', paddingLeft: 'clamp(24px, 3vw, 48px)', paddingRight: 'clamp(24px, 3vw, 48px)' }}
        >
          <Outlet />
        </div>
      </main>
    </div>
  );
}
