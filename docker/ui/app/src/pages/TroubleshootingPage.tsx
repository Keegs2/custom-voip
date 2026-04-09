import { useState } from 'react';

export function TroubleshootingPage() {
  const [iframeError, setIframeError] = useState(false);
  const homerUrl = `http://${window.location.hostname}:9080`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: 'calc(100vh - 96px)' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexShrink: 0,
        }}
      >
        <div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 800, color: '#e2e8f0', margin: 0, letterSpacing: '-0.02em' }}>
            Troubleshooting
          </h1>
          <p style={{ fontSize: '0.85rem', color: '#718096', marginTop: 4 }}>
            Homer SIP Capture — real-time SIP packet analysis and call flow debugging
          </p>
        </div>
        <a
          href={homerUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: '0.8rem',
            fontWeight: 600,
            padding: '7px 16px',
            borderRadius: 8,
            border: '1px solid rgba(42,47,69,0.6)',
            background: 'rgba(30,33,48,0.8)',
            color: '#94a3b8',
            textDecoration: 'none',
            transition: 'all 0.15s',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(59,130,246,0.1)';
            e.currentTarget.style.borderColor = 'rgba(59,130,246,0.3)';
            e.currentTarget.style.color = '#60a5fa';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'rgba(30,33,48,0.8)';
            e.currentTarget.style.borderColor = 'rgba(42,47,69,0.6)';
            e.currentTarget.style.color = '#94a3b8';
          }}
        >
          Open Full Screen
        </a>
      </div>

      {/* Homer iframe — fills remaining height */}
      {iframeError ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
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
            Homer should be running on port 9080. Make sure the Homer container is up and
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
      ) : (
        <div
          style={{
            flex: 1,
            border: '1px solid rgba(42,47,69,0.6)',
            borderRadius: 12,
            overflow: 'hidden',
            boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
          }}
        >
          <iframe
            src={homerUrl}
            title="Homer SIP Capture"
            onError={() => setIframeError(true)}
            style={{
              width: '100%',
              height: '100%',
              border: 'none',
              background: '#1a1d27',
              display: 'block',
            }}
          />
        </div>
      )}
    </div>
  );
}
