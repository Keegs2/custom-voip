import { useState } from 'react';

export function TroubleshootingPage() {
  const [iframeError, setIframeError] = useState(false);

  // Homer runs on port 9080 on the VM's direct IP.
  // The app may be accessed via a load balancer on a different IP,
  // so we hardcode the VM IP where Homer is actually reachable.
  const homerUrl = 'http://34.74.71.32:9080';

  if (iframeError) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: 'calc(100vh - 96px)',
          gap: 16,
          background: 'linear-gradient(135deg, rgba(30,33,48,0.6) 0%, rgba(19,21,29,0.7) 100%)',
          border: '1px solid rgba(42,47,69,0.6)',
          borderRadius: 16,
          textAlign: 'center',
          padding: 40,
        }}
      >
        <p style={{ fontWeight: 600, color: '#e2e8f0', fontSize: '1rem' }}>
          Homer is not reachable
        </p>
        <p style={{ fontSize: '0.85rem', color: '#718096', maxWidth: 440, lineHeight: 1.6 }}>
          Homer should be running on port 9080. Verify the container is up and
          the port is accessible from your browser.
        </p>
        <code
          style={{
            display: 'block',
            padding: '10px 16px',
            background: 'rgba(15,17,23,0.8)',
            border: '1px solid rgba(42,47,69,0.6)',
            borderRadius: 8,
            color: '#93c5fd',
            fontSize: '0.82rem',
            fontFamily: 'monospace',
          }}
        >
          {homerUrl}
        </code>
      </div>
    );
  }

  return (
    <iframe
      src={homerUrl}
      title="Homer SIP Capture"
      onError={() => setIframeError(true)}
      style={{
        width: '100%',
        height: 'calc(100vh - 96px)',
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 12,
        background: '#1a1d27',
        display: 'block',
      }}
    />
  );
}
