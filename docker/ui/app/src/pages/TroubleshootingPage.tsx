import { useState, useEffect, useRef } from 'react';

export function TroubleshootingPage() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Homer is reverse-proxied through our nginx at /homer/ so it's same-origin.
  const homerUrl = '/homer/';

  // Auto-login to Homer using default admin credentials, then load the iframe.
  // Homer 7 uses /api/v3/auth as the login endpoint.
  useEffect(() => {
    let cancelled = false;

    async function loginAndLoad() {
      try {
        const res = await fetch('/api/v3/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'sipcapture' }),
        });

        if (!res.ok) {
          throw new Error(`Homer login failed: ${res.status}`);
        }

        const data = await res.json();
        const token = data?.token;

        if (!token) {
          throw new Error('No token in Homer login response');
        }

        // Store the token in localStorage where Homer's Angular app expects it
        localStorage.setItem('token', token);

        if (!cancelled) {
          setReady(true);
        }
      } catch (err) {
        if (!cancelled) {
          // If login fails, still show the iframe (user can login manually)
          console.warn('Homer auto-login failed:', err);
          setReady(true);
        }
      }
    }

    loginAndLoad();
    return () => { cancelled = true; };
  }, []);

  if (error) {
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
          {error}
        </p>
      </div>
    );
  }

  if (!ready) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: 'calc(100vh - 96px)',
          color: '#718096',
          fontSize: '0.9rem',
        }}
      >
        Connecting to Homer...
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      src={homerUrl}
      title="Homer SIP Capture"
      onError={() => setError('Could not load Homer. Make sure the container is running.')}
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
