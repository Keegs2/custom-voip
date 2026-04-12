import { useState, useCallback, type KeyboardEvent } from 'react';
import { useSoftphone } from '../../contexts/SoftphoneContext';

const KEYS: { label: string; sub?: string }[] = [
  { label: '1', sub: '' },
  { label: '2', sub: 'ABC' },
  { label: '3', sub: 'DEF' },
  { label: '4', sub: 'GHI' },
  { label: '5', sub: 'JKL' },
  { label: '6', sub: 'MNO' },
  { label: '7', sub: 'PQRS' },
  { label: '8', sub: 'TUV' },
  { label: '9', sub: 'WXYZ' },
  { label: '*', sub: '' },
  { label: '0', sub: '+' },
  { label: '#', sub: '' },
];

const IconCall = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} style={{ width: 20, height: 20 }}>
    <path d="M2.25 6.338c0 12.03 9.716 21.75 21.75 21.75" strokeLinecap="round" strokeLinejoin="round" />
    <path d="m2.25 6.338 3.56-3.56a1.5 1.5 0 0 1 2.121 0l2.296 2.296a1.5 1.5 0 0 1 0 2.122l-1.054 1.053c-.226.226-.296.56-.144.849a13.478 13.478 0 0 0 5.636 5.635c.29.153.624.083.85-.143l1.053-1.054a1.5 1.5 0 0 1 2.122 0l2.296 2.296a1.5 1.5 0 0 1 0 2.121l-3.56 3.56" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconBackspace = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 16, height: 16 }}>
    <path d="M12 9.75L14.25 12m0 0 2.25 2.25M14.25 12l2.25-2.25M14.25 12 12 14.25m-2.58 4.92-6.374-6.375a1.125 1.125 0 0 1 0-1.59L9.42 4.83c.21-.211.497-.33.795-.33H19.5a2.25 2.25 0 0 1 2.25 2.25v10.5a2.25 2.25 0 0 1-2.25 2.25h-9.284c-.298 0-.585-.119-.795-.33Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function DialPad() {
  const { makeCall, activeCall, connectionState, sendDTMF } = useSoftphone();
  const [number, setNumber] = useState('');
  const [isDialing, setIsDialing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // During an active call, the dial pad sends DTMF instead of placing a new call
  const isInCall = activeCall !== null && activeCall.state === 'active';

  const handleKey = useCallback((digit: string) => {
    if (isInCall) {
      sendDTMF(digit);
      setNumber((prev) => prev + digit);
      return;
    }
    setNumber((prev) => prev + digit);
    setError(null);
  }, [isInCall, sendDTMF]);

  const handleBackspace = useCallback(() => {
    setNumber((prev) => prev.slice(0, -1));
  }, []);

  const handleCall = useCallback(async () => {
    const trimmed = number.trim();
    if (!trimmed || isDialing) return;
    if (connectionState !== 'registered') {
      setError('Softphone not connected. Please wait...');
      return;
    }

    setIsDialing(true);
    setError(null);
    try {
      await makeCall(trimmed);
      setNumber('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Call failed');
    } finally {
      setIsDialing(false);
    }
  }, [number, isDialing, connectionState, makeCall]);

  const handleInputKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void handleCall();
    if (e.key === 'Backspace') return; // Allow native backspace on input
  }, [handleCall]);

  const isCallable = connectionState === 'registered' && !isDialing && !isInCall;
  const canDial = isCallable && number.trim().length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 0' }}>
      {/* Number display input */}
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <input
          type="tel"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder={isInCall ? 'Enter DTMF digit...' : 'Enter number...'}
          aria-label="Phone number input"
          style={{
            width: '100%',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 10,
            color: '#f1f5f9',
            fontSize: '1.25rem',
            fontWeight: 500,
            letterSpacing: '0.05em',
            padding: '10px 44px 10px 14px',
            outline: 'none',
            fontFamily: 'monospace',
            textAlign: 'center',
            boxSizing: 'border-box',
          }}
        />
        {number.length > 0 && (
          <button
            type="button"
            onClick={handleBackspace}
            aria-label="Delete last digit"
            className="sp-backspace-btn"
            style={{
              position: 'absolute',
              right: 10,
              background: 'transparent',
              border: 'none',
              color: '#64748b',
              cursor: 'pointer',
              padding: 4,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 6,
            }}
          >
            <IconBackspace />
          </button>
        )}
      </div>

      {/* Error message */}
      {error && (
        <div style={{ fontSize: '0.75rem', color: '#f87171', textAlign: 'center', padding: '0 8px' }}>
          {error}
        </div>
      )}

      {/* Key grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 8,
        }}
      >
        {KEYS.map(({ label, sub }) => (
          <button
            key={label}
            type="button"
            onClick={() => handleKey(label)}
            aria-label={`Dial ${label}`}
            className="sp-dial-key"
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 1,
              height: 52,
              borderRadius: 12,
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.08)',
              color: '#e2e8f0',
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            <span style={{ fontSize: '1.1rem', fontWeight: 600, lineHeight: 1 }}>{label}</span>
            {sub !== undefined && sub !== '' && (
              <span style={{ fontSize: '0.55rem', color: '#475569', letterSpacing: '0.1em', fontWeight: 600 }}>
                {sub}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Call button */}
      {!isInCall && (
        <button
          type="button"
          onClick={() => void handleCall()}
          disabled={!canDial}
          aria-label="Make call"
          className="sp-call-btn"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            height: 52,
            borderRadius: 26,
            background: canDial
              ? 'linear-gradient(135deg, #16a34a 0%, #22c55e 100%)'
              : 'rgba(255,255,255,0.05)',
            border: 'none',
            color: canDial ? '#fff' : '#334155',
            fontSize: '0.875rem',
            fontWeight: 600,
            cursor: canDial ? 'pointer' : 'not-allowed',
            opacity: isDialing ? 0.7 : 1,
            boxShadow: canDial ? '0 4px 16px rgba(34,197,94,0.35)' : 'none',
          }}
        >
          <IconCall />
          {isDialing ? 'Calling...' : 'Call'}
        </button>
      )}

      {/* Connection status hint */}
      {connectionState !== 'registered' && connectionState !== 'disconnected' && (
        <div style={{ fontSize: '0.7rem', color: '#64748b', textAlign: 'center' }}>
          {connectionState === 'connecting' || connectionState === 'connected'
            ? 'Connecting to voice server...'
            : 'Voice server unavailable'}
        </div>
      )}
    </div>
  );
}
