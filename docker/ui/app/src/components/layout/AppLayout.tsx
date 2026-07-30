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
        {/* Inner wrapper: fills the full width between the sidebar and the right edge */}
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
