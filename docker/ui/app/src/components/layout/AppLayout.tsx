import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { SoftphoneWidget } from '../softphone/SoftphoneWidget';

export function AppLayout() {
  // The public landing page (index route) is a marketing surface and breathes
  // wider than the standard 1280 app content cap. Every other route keeps 1280.
  const { pathname } = useLocation();
  const contentMaxWidth = pathname === '/' ? 1600 : 1280;

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
          className="flex-1 flex flex-col py-8 pb-20"
          style={{ maxWidth: contentMaxWidth, width: '100%', marginLeft: 'auto', marginRight: 'auto', paddingLeft: 'clamp(24px, 3vw, 48px)', paddingRight: 'clamp(24px, 3vw, 48px)' }}
        >
          <Outlet />
        </div>
      </main>

      {/* Softphone overlay — self-gates on hasUcaas (renders null for rcf and
          any account with no WebRTC extension), so RCF sees zero UCaaS chrome. */}
      <SoftphoneWidget />
    </div>
  );
}
