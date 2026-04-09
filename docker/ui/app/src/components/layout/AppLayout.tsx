import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';

export function AppLayout() {
  return (
    <div className="min-h-screen bg-[#0f1117]">
      <Sidebar />
      {/* Main content — offset by fixed sidebar width on md+ */}
      <main
        className="min-h-screen flex flex-col"
        style={{ marginLeft: 240 }}
      >
        {/* Inner wrapper: fills main, centers content within the content column */}
        <div
          className="flex-1 flex flex-col px-6 py-8 pb-20"
          style={{ maxWidth: 1160, width: '100%', marginLeft: 'auto', marginRight: 'auto' }}
        >
          <Outlet />
        </div>
      </main>
    </div>
  );
}
