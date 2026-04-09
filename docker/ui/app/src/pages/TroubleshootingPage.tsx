import { useState } from 'react';

export function TroubleshootingPage() {
  const [error, setError] = useState(false);

  // Homer is reverse-proxied through our nginx at /homer/ so it's same-origin.
  const homerUrl = '/homer/';

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
          Make sure the Homer container is running and port 9080 is accessible.
        </p>
      </div>
    );
  }

  // Break out of the AppLayout's max-width + padding container
  // to make Homer fill the full available width
  return (
    <div
      style={{
        // Negate the parent's px-6/md:px-10 padding and max-width centering
        margin: '-32px -40px -80px -24px',
        height: 'calc(100vh)',
        position: 'relative',
      }}
    >
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
  );
}
