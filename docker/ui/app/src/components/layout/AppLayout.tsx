import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';

export function AppLayout() {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      {/* Main content — offset by sidebar width on desktop */}
      <main className="flex-1 flex flex-col min-h-screen md:ml-[240px]">
        <div className="flex-1 px-9 py-8 pb-16 overflow-y-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
