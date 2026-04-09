import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';

export function AppLayout() {
  return (
    <div className="min-h-screen bg-[#0f1117]">
      <Sidebar />
      <main
        style={{ marginLeft: 240, minHeight: '100vh' }}
        className="p-6 pb-16 max-w-[1600px]"
      >
        <Outlet />
      </main>
    </div>
  );
}
