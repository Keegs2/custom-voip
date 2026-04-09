import { useState } from 'react';
import { Button } from '../../components/ui/Button';

export function HomerTab() {
  const [iframeError, setIframeError] = useState(false);

  // Homer is reverse-proxied through our nginx at /homer/ so it's same-origin.
  // This avoids X-Frame-Options and CSP iframe blocking.
  const homerUrl = '/homer/';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '20px 24px',
          background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
          border: '1px solid rgba(42,47,69,0.6)',
          borderRadius: 16,
          boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
        }}
      >
        <div>
          <h2
            style={{
              fontSize: '1rem',
              fontWeight: 700,
              color: '#e2e8f0',
              margin: 0,
              letterSpacing: '-0.01em',
            }}
          >
            Homer SIP Capture
          </h2>
          <p
            style={{
              fontSize: '0.78rem',
              color: '#718096',
              marginTop: 4,
            }}
          >
            Embedded Homer viewer — SIP packet capture and analysis
          </p>
        </div>
        <a
          href={homerUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Button variant="ghost" size="sm">
            Open in New Tab
          </Button>
        </a>
      </div>

      {/* Iframe or fallback */}
      {iframeError ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 16,
            padding: '80px 16px',
            background: 'linear-gradient(135deg, rgba(30,33,48,0.6) 0%, rgba(19,21,29,0.7) 100%)',
            border: '1px solid rgba(42,47,69,0.6)',
            borderRadius: 16,
            textAlign: 'center',
          }}
        >
          <p style={{ fontWeight: 600, color: '#e2e8f0', fontSize: '0.95rem' }}>
            Homer is not reachable
          </p>
          <p style={{ fontSize: '0.82rem', color: '#718096', maxWidth: 400, lineHeight: 1.6 }}>
            The Homer SIP capture interface at{' '}
            <span
              style={{
                fontFamily: 'monospace',
                color: '#93c5fd',
                background: 'rgba(59,130,246,0.1)',
                padding: '2px 6px',
                borderRadius: 4,
              }}
            >
              {homerUrl}
            </span>{' '}
            could not be loaded. Verify Homer is running and accessible from your browser.
          </p>
          <a
            href={homerUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: '#3b82f6',
              fontSize: '0.88rem',
              textDecoration: 'none',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none';
            }}
          >
            Try opening directly
          </a>
        </div>
      ) : (
        <div
          style={{
            border: '1px solid rgba(42,47,69,0.6)',
            borderRadius: 16,
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
              height: 'calc(100vh - 220px)',
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
