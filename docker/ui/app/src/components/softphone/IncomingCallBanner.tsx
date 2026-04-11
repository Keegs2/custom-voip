import { createPortal } from 'react-dom';
import { useSoftphone } from '../../contexts/SoftphoneContext';

export function IncomingCallBanner() {
  const { incomingCall, answerCall, rejectCall } = useSoftphone();

  if (!incomingCall) return null;

  const { remoteName, remoteNumber } = incomingCall;
  const displayName = remoteName && remoteName !== remoteNumber ? remoteName : null;

  const banner = (
    <div
      role="alertdialog"
      aria-label="Incoming call"
      aria-live="assertive"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '12px 24px',
        background: 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #0f172a 100%)',
        borderBottom: '1px solid rgba(99,102,241,0.40)',
        boxShadow: '0 4px 32px rgba(0,0,0,0.6)',
        // Slide-down animation
        animation: 'slideDown 0.25s ease-out',
      }}
    >
      {/* Pulse ring + caller info */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        {/* Animated ring indicator */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #4f46e5 0%, #818cf8 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 0 0 rgba(99,102,241,0.6)',
              animation: 'phonePulse 1.5s ease-out infinite',
            }}
          >
            <svg viewBox="0 0 24 24" fill="white" style={{ width: 18, height: 18 }}>
              <path fillRule="evenodd" d="M1.5 4.5a3 3 0 0 1 3-3h1.372c.86 0 1.61.586 1.819 1.42l1.105 4.423a1.875 1.875 0 0 1-.694 1.955l-1.293.97c-.135.101-.164.249-.126.352a11.285 11.285 0 0 0 6.697 6.697c.103.038.25.009.352-.126l.97-1.293a1.875 1.875 0 0 1 1.955-.694l4.423 1.105c.834.209 1.42.959 1.42 1.82V19.5a3 3 0 0 1-3 3h-2.25C8.552 22.5 1.5 15.448 1.5 6.75V4.5Z" clipRule="evenodd" />
            </svg>
          </div>
        </div>

        <div>
          <div style={{ fontSize: '0.7rem', color: '#818cf8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 2 }}>
            Incoming Call
          </div>
          {displayName && (
            <div style={{ fontSize: '1rem', fontWeight: 700, color: '#f1f5f9', letterSpacing: '-0.02em', lineHeight: 1.2 }}>
              {displayName}
            </div>
          )}
          <div style={{ fontSize: displayName ? '0.8rem' : '1rem', color: displayName ? '#94a3b8' : '#f1f5f9', fontFamily: 'monospace', fontWeight: 600 }}>
            {remoteNumber}
          </div>
        </div>
      </div>

      {/* Answer / Reject buttons */}
      <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
        {/* Reject */}
        <button
          type="button"
          onClick={rejectCall}
          aria-label="Reject call"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 16px',
            borderRadius: 20,
            background: 'rgba(239,68,68,0.15)',
            border: '1px solid rgba(239,68,68,0.35)',
            color: '#f87171',
            fontSize: '0.8rem',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'background 0.15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(239,68,68,0.25)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(239,68,68,0.15)'; }}
        >
          <div style={{ transform: 'rotate(135deg)', display: 'flex' }}>
            <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 14, height: 14 }}>
              <path fillRule="evenodd" d="M1.5 4.5a3 3 0 0 1 3-3h1.372c.86 0 1.61.586 1.819 1.42l1.105 4.423a1.875 1.875 0 0 1-.694 1.955l-1.293.97c-.135.101-.164.249-.126.352a11.285 11.285 0 0 0 6.697 6.697c.103.038.25.009.352-.126l.97-1.293a1.875 1.875 0 0 1 1.955-.694l4.423 1.105c.834.209 1.42.959 1.42 1.82V19.5a3 3 0 0 1-3 3h-2.25C8.552 22.5 1.5 15.448 1.5 6.75V4.5Z" clipRule="evenodd" />
            </svg>
          </div>
          Decline
        </button>

        {/* Answer */}
        <button
          type="button"
          onClick={() => void answerCall()}
          aria-label="Answer call"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 20px',
            borderRadius: 20,
            background: 'linear-gradient(135deg, #16a34a 0%, #22c55e 100%)',
            border: 'none',
            color: '#fff',
            fontSize: '0.8rem',
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: '0 2px 12px rgba(34,197,94,0.40)',
            transition: 'opacity 0.15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.9'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 14, height: 14 }}>
            <path fillRule="evenodd" d="M1.5 4.5a3 3 0 0 1 3-3h1.372c.86 0 1.61.586 1.819 1.42l1.105 4.423a1.875 1.875 0 0 1-.694 1.955l-1.293.97c-.135.101-.164.249-.126.352a11.285 11.285 0 0 0 6.697 6.697c.103.038.25.009.352-.126l.97-1.293a1.875 1.875 0 0 1 1.955-.694l4.423 1.105c.834.209 1.42.959 1.42 1.82V19.5a3 3 0 0 1-3 3h-2.25C8.552 22.5 1.5 15.448 1.5 6.75V4.5Z" clipRule="evenodd" />
          </svg>
          Answer
        </button>
      </div>
    </div>
  );

  return createPortal(banner, document.body);
}
