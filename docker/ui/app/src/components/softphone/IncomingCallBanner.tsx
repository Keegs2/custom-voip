import { createPortal } from 'react-dom';
import { useSoftphone } from '../../contexts/SoftphoneContext';

/* ─── Caller avatar with initials ────────────────────────────── */

function CallerAvatar({ name, number }: { name: string | null; number: string }) {
  const initials = name
    ? name
        .split(' ')
        .slice(0, 2)
        .map((w) => w[0] ?? '')
        .join('')
        .toUpperCase()
    : number.slice(-2);

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      {/* Outer ripple rings */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: -16,
          borderRadius: '50%',
          border: '2px solid rgba(34,197,94,0.50)',
          animation: 'banner-ripple 1.8s 0.0s ease-out infinite',
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: -16,
          borderRadius: '50%',
          border: '2px solid rgba(34,197,94,0.35)',
          animation: 'banner-ripple 1.8s 0.6s ease-out infinite',
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: -16,
          borderRadius: '50%',
          border: '2px solid rgba(34,197,94,0.20)',
          animation: 'banner-ripple 1.8s 1.2s ease-out infinite',
        }}
      />

      {/* Avatar circle */}
      <div
        style={{
          position: 'relative',
          width: 52,
          height: 52,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #1d4ed8 0%, #4f46e5 50%, #7c3aed 100%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '1.1rem',
          fontWeight: 700,
          color: '#fff',
          letterSpacing: '-0.03em',
          zIndex: 1,
          boxShadow: '0 0 0 3px rgba(34,197,94,0.40)',
          animation: 'banner-avatar-glow 2s ease-in-out infinite',
        }}
      >
        {initials}
      </div>

      {/* Phone ringing icon overlay */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          bottom: -4,
          right: -4,
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: '#22c55e',
          border: '2px solid #0f172a',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 2,
          animation: 'banner-ring-icon 1.4s ease-in-out infinite',
        }}
      >
        <svg viewBox="0 0 24 24" fill="white" style={{ width: 11, height: 11 }}>
          <path fillRule="evenodd" d="M1.5 4.5a3 3 0 0 1 3-3h1.372c.86 0 1.61.586 1.819 1.42l1.105 4.423a1.875 1.875 0 0 1-.694 1.955l-1.293.97c-.135.101-.164.249-.126.352a11.285 11.285 0 0 0 6.697 6.697c.103.038.25.009.352-.126l.97-1.293a1.875 1.875 0 0 1 1.955-.694l4.423 1.105c.834.209 1.42.959 1.42 1.82V19.5a3 3 0 0 1-3 3h-2.25C8.552 22.5 1.5 15.448 1.5 6.75V4.5Z" clipRule="evenodd" />
        </svg>
      </div>
    </div>
  );
}

/* ─── Sound wave visualization ──────────────────────────────── */

function SoundWave() {
  const heights = [30, 55, 75, 100, 75, 55, 30];
  return (
    <div
      aria-hidden="true"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 3,
        height: 28,
        opacity: 0.60,
      }}
    >
      {heights.map((pct, i) => (
        <div
          key={i}
          style={{
            width: 3,
            borderRadius: 2,
            background: 'rgba(134,239,172,0.9)',
            height: `${pct}%`,
            animation: `banner-wave 0.85s ease-in-out ${i * 0.11}s infinite alternate`,
          }}
        />
      ))}
    </div>
  );
}

/* ─── Accept button with ripple effect ──────────────────────── */

function AcceptButton({ onAnswer }: { onAnswer: () => void }) {
  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      {/* Ripple rings behind the button */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: -8,
          borderRadius: 28,
          background: 'rgba(34,197,94,0.25)',
          animation: 'banner-accept-ripple 1.4s 0.0s ease-out infinite',
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: -8,
          borderRadius: 28,
          background: 'rgba(34,197,94,0.15)',
          animation: 'banner-accept-ripple 1.4s 0.5s ease-out infinite',
        }}
      />

      <button
        type="button"
        onClick={onAnswer}
        aria-label="Answer call"
        style={{
          position: 'relative',
          zIndex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 22px',
          borderRadius: 24,
          background: 'linear-gradient(135deg, #16a34a 0%, #22c55e 100%)',
          border: 'none',
          color: '#fff',
          fontSize: '0.85rem',
          fontWeight: 700,
          cursor: 'pointer',
          letterSpacing: '-0.01em',
          boxShadow: '0 4px 16px rgba(34,197,94,0.50)',
          animation: 'banner-accept-pulse 1.4s ease-in-out infinite',
          transition: 'transform 0.1s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.04)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 15, height: 15 }}>
          <path fillRule="evenodd" d="M1.5 4.5a3 3 0 0 1 3-3h1.372c.86 0 1.61.586 1.819 1.42l1.105 4.423a1.875 1.875 0 0 1-.694 1.955l-1.293.97c-.135.101-.164.249-.126.352a11.285 11.285 0 0 0 6.697 6.697c.103.038.25.009.352-.126l.97-1.293a1.875 1.875 0 0 1 1.955-.694l4.423 1.105c.834.209 1.42.959 1.42 1.82V19.5a3 3 0 0 1-3 3h-2.25C8.552 22.5 1.5 15.448 1.5 6.75V4.5Z" clipRule="evenodd" />
        </svg>
        Answer
      </button>
    </div>
  );
}

/* ─── Keyframe animations ────────────────────────────────────── */

const BANNER_STYLES = `
  @keyframes banner-ripple {
    0%   { transform: scale(1);    opacity: 0.8; }
    100% { transform: scale(1.80); opacity: 0;   }
  }

  @keyframes banner-avatar-glow {
    0%, 100% { box-shadow: 0 0 0 3px rgba(34,197,94,0.40); }
    50%       { box-shadow: 0 0 0 5px rgba(34,197,94,0.65), 0 0 20px rgba(34,197,94,0.25); }
  }

  @keyframes banner-ring-icon {
    0%, 60%, 100% { transform: rotate(0deg); }
    10%            { transform: rotate(16deg); }
    20%            { transform: rotate(-16deg); }
    30%            { transform: rotate(10deg); }
    40%            { transform: rotate(-10deg); }
    50%            { transform: rotate(5deg); }
  }

  @keyframes banner-wave {
    from { transform: scaleY(0.25); opacity: 0.5; }
    to   { transform: scaleY(1.00); opacity: 1.0; }
  }

  @keyframes banner-accept-ripple {
    0%   { transform: scale(1);   opacity: 0.7; }
    100% { transform: scale(1.6); opacity: 0;   }
  }

  @keyframes banner-accept-pulse {
    0%, 100% { box-shadow: 0 4px 16px rgba(34,197,94,0.50); }
    50%       { box-shadow: 0 4px 28px rgba(34,197,94,0.80), 0 0 40px rgba(34,197,94,0.25); }
  }

  @keyframes banner-slide-down {
    from { transform: translateY(-110%); opacity: 0; }
    to   { transform: translateY(0);     opacity: 1; }
  }

  @keyframes banner-bg-sweep {
    0%, 100% { background-position: 0% 50%; }
    50%       { background-position: 100% 50%; }
  }

  @keyframes phonePulse {
    0%   { box-shadow: 0 0 0 0   rgba(99,102,241,0.7); }
    70%  { box-shadow: 0 0 0 14px rgba(99,102,241,0);  }
    100% { box-shadow: 0 0 0 0   rgba(99,102,241,0);   }
  }

  @keyframes slideDown {
    from { transform: translateY(-100%); opacity: 0; }
    to   { transform: translateY(0);    opacity: 1; }
  }
`;

/* ─── Main component ─────────────────────────────────────────── */

export function IncomingCallBanner() {
  const { incomingCall, answerCall, rejectCall } = useSoftphone();

  if (!incomingCall) return null;

  const { remoteName, remoteNumber } = incomingCall;
  const displayName = remoteName && remoteName !== remoteNumber ? remoteName : null;

  const banner = (
    <>
      <style>{BANNER_STYLES}</style>

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
          gap: 0,
          // Animated gradient background
          background: 'linear-gradient(135deg, #0a1628 0%, #0f1f0f 30%, #0d1b2a 60%, #0f172a 100%)',
          backgroundSize: '300% 300%',
          animation: 'banner-slide-down 0.28s cubic-bezier(0.34,1.56,0.64,1), banner-bg-sweep 4s ease-in-out infinite',
          borderBottom: '1px solid rgba(34,197,94,0.30)',
          boxShadow: '0 4px 40px rgba(0,0,0,0.70), 0 1px 0 rgba(34,197,94,0.15)',
        }}
      >
        {/* Left accent bar */}
        <div
          aria-hidden="true"
          style={{
            width: 4,
            alignSelf: 'stretch',
            background: 'linear-gradient(180deg, #22c55e 0%, #16a34a 100%)',
            flexShrink: 0,
          }}
        />

        {/* Content */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 20,
            padding: '16px 28px 16px 24px',
          }}
        >
          {/* Left: avatar + caller info + sound wave */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
            {/* Avatar with ripple rings */}
            <CallerAvatar name={displayName} number={remoteNumber} />

            {/* Caller info */}
            <div>
              <div
                style={{
                  fontSize: '0.68rem',
                  color: '#86efac',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.12em',
                  marginBottom: 5,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                {/* Animated dot */}
                <span
                  aria-hidden="true"
                  style={{
                    display: 'inline-block',
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: '#22c55e',
                    animation: 'banner-accept-pulse 1.2s ease-in-out infinite',
                    flexShrink: 0,
                  }}
                />
                Incoming Call
              </div>

              {displayName && (
                <div
                  style={{
                    fontSize: '1.15rem',
                    fontWeight: 800,
                    color: '#f8fafc',
                    letterSpacing: '-0.03em',
                    lineHeight: 1.15,
                    marginBottom: 2,
                  }}
                >
                  {displayName}
                </div>
              )}

              <div
                style={{
                  fontSize: displayName ? '0.82rem' : '1.05rem',
                  color: displayName ? '#94a3b8' : '#f1f5f9',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontWeight: 600,
                  letterSpacing: '0.04em',
                }}
              >
                {remoteNumber}
              </div>
            </div>

            {/* Sound wave visualization */}
            <div style={{ paddingLeft: 4 }}>
              <SoundWave />
            </div>
          </div>

          {/* Right: action buttons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
            {/* Reject */}
            <button
              type="button"
              onClick={rejectCall}
              aria-label="Decline call"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                padding: '9px 18px',
                borderRadius: 22,
                background: 'rgba(239,68,68,0.12)',
                border: '1px solid rgba(239,68,68,0.30)',
                color: '#fca5a5',
                fontSize: '0.82rem',
                fontWeight: 700,
                cursor: 'pointer',
                letterSpacing: '-0.01em',
                transition: 'background 0.15s, transform 0.1s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(239,68,68,0.22)';
                e.currentTarget.style.transform = 'scale(1.03)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(239,68,68,0.12)';
                e.currentTarget.style.transform = 'scale(1)';
              }}
            >
              <div style={{ transform: 'rotate(135deg)', display: 'flex' }}>
                <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 14, height: 14 }}>
                  <path fillRule="evenodd" d="M1.5 4.5a3 3 0 0 1 3-3h1.372c.86 0 1.61.586 1.819 1.42l1.105 4.423a1.875 1.875 0 0 1-.694 1.955l-1.293.97c-.135.101-.164.249-.126.352a11.285 11.285 0 0 0 6.697 6.697c.103.038.25.009.352-.126l.97-1.293a1.875 1.875 0 0 1 1.955-.694l4.423 1.105c.834.209 1.42.959 1.42 1.82V19.5a3 3 0 0 1-3 3h-2.25C8.552 22.5 1.5 15.448 1.5 6.75V4.5Z" clipRule="evenodd" />
                </svg>
              </div>
              Decline
            </button>

            {/* Accept — with ripple */}
            <AcceptButton onAnswer={() => void answerCall()} />
          </div>
        </div>
      </div>
    </>
  );

  return createPortal(banner, document.body);
}
