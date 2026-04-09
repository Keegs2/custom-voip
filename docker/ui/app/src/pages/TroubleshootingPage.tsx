import { useState } from 'react';
import { Sidebar } from '../components/layout/Sidebar';

export function TroubleshootingPage() {
  const [error, setError] = useState(false);
  const homerUrl = '/homer/';

  if (error) {
    return (
      <div className="min-h-screen bg-[#0f1117]">
        <Sidebar />
        <div
          style={{
            marginLeft: 240,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            padding: 40,
          }}
        >
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontWeight: 600, color: '#e2e8f0', fontSize: '1rem' }}>
              Homer is not reachable
            </p>
            <p style={{ fontSize: '0.85rem', color: '#718096', marginTop: 8 }}>
              Make sure the Homer container is running.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0f1117]">
      <Sidebar />
      <div style={{ marginLeft: 240, height: '100vh' }}>
        <iframe
          src={homerUrl}
          title="Homer SIP Capture"
          onError={() => setError(true)}
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            background: '#fff',
            display: 'block',
          }}
        />
      </div>
    </div>
  );
}
