import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';

export function AppLayout() {
  return (
    <div className="min-h-screen bg-[#0f1117]">
      <Sidebar />
      {/* Main content — offset by sidebar width on md+ */}
      <main
        className="min-h-screen"
        style={{ marginLeft: 'clamp(0px, 240px, 240px)' }}
      >
        {/* Inner wrapper: max-width + responsive padding */}
        <div className="max-w-[1400px] mx-auto px-6 py-6 md:px-8 md:py-8 pb-16">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
