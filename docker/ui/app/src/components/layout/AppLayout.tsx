import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';

export function AppLayout() {
  return (
    <div className="min-h-screen bg-[#0f1117]">
      <Sidebar />
      {/* Main content — offset by sidebar width on desktop.
          The sidebar is fixed (out of flow), so we push content with ml-[240px]
          directly on the main element. On mobile the sidebar collapses so no margin. */}
      <main className="min-h-screen md:ml-[240px]">
        <div className="p-6 pb-16 max-w-[1600px]">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
