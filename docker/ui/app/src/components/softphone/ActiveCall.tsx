import { useState } from 'react';
import { useSoftphone } from '../../contexts/SoftphoneContext';

const IconMic = ({ muted }: { muted: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 18, height: 18 }}>
    {muted ? (
      <>
        <path d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" strokeLinecap="round" strokeLinejoin="round" />
        <path d="m3 3 18 18" strokeLinecap="round" />
      </>
    ) : (
      <>
        <path d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" strokeLinecap="round" strokeLinejoin="round" />
      </>
    )}
  </svg>
);

const IconPause = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 18, height: 18 }}>
    <path d="M15.75 5.25v13.5m-7.5-13.5v13.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconPlay = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 18, height: 18 }}>
    <path d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconKeypad = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 18, height: 18 }}>
    <path d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconPhone = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 20, height: 20 }}>
    <path fillRule="evenodd" d="M1.5 4.5a3 3 0 0 1 3-3h1.372c.86 0 1.61.586 1.819 1.42l1.105 4.423a1.875 1.875 0 0 1-.694 1.955l-1.293.97c-.135.101-.164.249-.126.352a11.285 11.285 0 0 0 6.697 6.697c.103.038.25.009.352-.126l.97-1.293a1.875 1.875 0 0 1 1.955-.694l4.423 1.105c.834.209 1.42.959 1.42 1.82V19.5a3 3 0 0 1-3 3h-2.25C8.552 22.5 1.5 15.448 1.5 6.75V4.5Z" clipRule="evenodd" />
  </svg>
);

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function ActiveCallView() {
  const {
    activeCall,
    hangupCall,
    holdCall,
    unholdCall,
    muteCall,
    unmuteCall,
  } = useSoftphone();

  const [showDtmf, setShowDtmf] = useState(false);

  if (!activeCall) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 200, color: '#334155', fontSize: '0.875rem' }}>
        No active call
      </div>
    );
  }

  const { state, remoteName, remoteNumber, duration, muted, held } = activeCall;

  const STATE_LABELS: Record<string, string> = {
    idle:    'Idle',
    dialing: 'Dialing...',
    ringing: 'Ringing...',
    early:   'Connecting...',
    active:  formatDuration(duration),
    held:    `On Hold — ${formatDuration(duration)}`,
    ended:   'Call ended',
  };
  const stateLabel = STATE_LABELS[state] ?? state;

  const displayName = remoteName && remoteName !== remoteNumber ? remoteName : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '16px 0', gap: 20 }}>
      {/* Caller avatar */}
      <div style={{ position: 'relative' }}>
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, rgba(59,130,246,0.25) 0%, rgba(99,102,241,0.25) 100%)',
            border: '2px solid rgba(99,102,241,0.30)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1.75rem',
            color: '#818cf8',
            fontWeight: 700,
            // Pulse animation when ringing or dialing
            animation: (state === 'ringing' || state === 'dialing') ? 'pulse 1.5s ease-in-out infinite' : 'none',
          }}
        >
          {(displayName ?? remoteNumber).charAt(0).toUpperCase()}
        </div>
        {/* State indicator dot */}
        <div
          style={{
            position: 'absolute',
            bottom: 2,
            right: 2,
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: state === 'active' ? '#22c55e'
              : state === 'held' ? '#f59e0b'
              : state === 'ended' ? '#ef4444'
              : '#3b82f6',
            border: '2px solid #0f1117',
          }}
        />
      </div>

      {/* Caller info */}
      <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {displayName && (
          <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#f1f5f9', letterSpacing: '-0.02em' }}>
            {displayName}
          </div>
        )}
        <div style={{ fontSize: displayName ? '0.875rem' : '1.1rem', color: displayName ? '#64748b' : '#f1f5f9', fontFamily: 'monospace', fontWeight: 600 }}>
          {remoteNumber}
        </div>
        <div style={{ fontSize: '0.8rem', color: state === 'active' ? '#22c55e' : '#94a3b8', fontWeight: 600, letterSpacing: '0.02em', fontVariantNumeric: 'tabular-nums' }}>
          {stateLabel}
        </div>
      </div>

      {/* Control buttons */}
      {!showDtmf ? (
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', justifyContent: 'center' }}>
          {/* Mute */}
          <ActionButton
            onClick={() => muted ? unmuteCall() : muteCall()}
            label={muted ? 'Unmute' : 'Mute'}
            active={muted}
            activeColor="#ef4444"
            disabled={state !== 'active'}
          >
            <IconMic muted={muted} />
          </ActionButton>

          {/* Hold / Unhold */}
          <ActionButton
            onClick={() => held ? unholdCall() : holdCall()}
            label={held ? 'Resume' : 'Hold'}
            active={held}
            activeColor="#f59e0b"
            disabled={state !== 'active' && state !== 'held'}
          >
            {held ? <IconPlay /> : <IconPause />}
          </ActionButton>

          {/* Keypad toggle */}
          <ActionButton
            onClick={() => setShowDtmf(true)}
            label="Keypad"
            active={false}
            activeColor="#3b82f6"
            disabled={state !== 'active'}
          >
            <IconKeypad />
          </ActionButton>
        </div>
      ) : (
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            type="button"
            onClick={() => setShowDtmf(false)}
            style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: '0.75rem', textAlign: 'left', padding: '0 4px' }}
          >
            ← Back to controls
          </button>
          <DtmfPad />
        </div>
      )}

      {/* Hangup button */}
      <button
        type="button"
        onClick={hangupCall}
        aria-label="Hang up"
        disabled={state === 'ended'}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 64,
          height: 64,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #dc2626 0%, #ef4444 100%)',
          border: 'none',
          color: '#fff',
          cursor: state === 'ended' ? 'not-allowed' : 'pointer',
          boxShadow: '0 4px 20px rgba(239,68,68,0.50)',
          transition: 'transform 0.1s, box-shadow 0.1s',
          opacity: state === 'ended' ? 0.5 : 1,
        }}
        onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.92)'; }}
        onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
      >
        {/* Rotated phone icon (hang up position) */}
        <div style={{ transform: 'rotate(135deg)' }}>
          <IconPhone />
        </div>
      </button>
    </div>
  );
}

/* ─── Helper: action button ──────────────────────────────── */

interface ActionButtonProps {
  onClick: () => void;
  label: string;
  active: boolean;
  activeColor: string;
  disabled?: boolean;
  children: React.ReactNode;
}

function ActionButton({ onClick, label, active, activeColor, disabled, children }: ActionButtonProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        style={{
          width: 48,
          height: 48,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: active ? `${activeColor}20` : 'rgba(255,255,255,0.06)',
          border: `1px solid ${active ? `${activeColor}50` : 'rgba(255,255,255,0.08)'}`,
          color: active ? activeColor : '#94a3b8',
          cursor: disabled ? 'not-allowed' : 'pointer',
          transition: 'background 0.15s, color 0.15s, border-color 0.15s',
          opacity: disabled ? 0.4 : 1,
          boxShadow: active ? `0 0 10px ${activeColor}30` : 'none',
        }}
      >
        {children}
      </button>
      <span style={{ fontSize: '0.65rem', color: active ? activeColor : '#475569', fontWeight: 500 }}>
        {label}
      </span>
    </div>
  );
}

/* ─── DTMF pad inline (during active call) ───────────────── */

const DTMF_KEYS = ['1','2','3','4','5','6','7','8','9','*','0','#'];

function DtmfPad() {
  const { sendDTMF } = useSoftphone();
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
      {DTMF_KEYS.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => sendDTMF(k)}
          aria-label={`DTMF ${k}`}
          style={{
            height: 40,
            borderRadius: 8,
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.08)',
            color: '#e2e8f0',
            fontSize: '1rem',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'background 0.1s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.10)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
        >
          {k}
        </button>
      ))}
    </div>
  );
}
