/**
 * Confirmation modals for DID self-serve: RequestModal (claim a number — pending
 * admin approval) and ReleaseModal (hold-to-release back to the pool). Both are
 * presentational; the parent owns the request/release mutations.
 *
 * React #310: ReleaseModal calls all its hooks at the very top, before the
 * `if (!did) return null` guard.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DidInventoryItem } from '../../../../types/didInventory';
import { fmt } from '../../../../utils/format';
import { modalOverlay } from '../../styles';

// ── RequestModal ─────────────────────────────────────────────────────────────

interface RequestModalProps {
  did: DidInventoryItem | null;
  onConfirm: (did: DidInventoryItem) => void;
  onCancel: () => void;
  isPending: boolean;
}

export function RequestModal({ did, onConfirm, onCancel, isPending }: RequestModalProps) {
  if (!did) return null;
  return (
    <div style={modalOverlay(false)} onClick={(e) => { if (e.target === e.currentTarget && !isPending) onCancel(); }}>
      <div style={{ background: 'linear-gradient(145deg, rgba(26,29,39,0.98) 0%, rgba(19,21,29,0.99) 100%)', border: '1px solid rgba(59,130,246,0.22)', borderRadius: 18, padding: '32px 32px 28px', maxWidth: 420, width: '100%', position: 'relative', boxShadow: '0 24px 64px -8px rgba(0,0,0,0.75), 0 0 0 1px rgba(59,130,246,0.08)', animation: 'glass-rise 0.2s ease' }}>
        <div style={{ position: 'absolute', top: 0, left: 48, right: 48, height: 2, background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.65), transparent)', borderRadius: '0 0 2px 2px' }} />

        <div style={{ width: 52, height: 52, borderRadius: 13, background: 'linear-gradient(135deg, rgba(59,130,246,0.18) 0%, rgba(59,130,246,0.08) 100%)', border: '1px solid rgba(59,130,246,0.28)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20, boxShadow: '0 0 20px rgba(59,130,246,0.18)' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth={1.6} style={{ width: 26, height: 26 }}>
            <path d="M3 5a2 2 0 0 1 2-2h3.28a1 1 0 0 1 .948.684l1.498 4.493a1 1 0 0 1-.502 1.21l-2.257 1.13a11.042 11.042 0 0 0 5.516 5.516l1.13-2.257a1 1 0 0 1 1.21-.502l4.493 1.498a1 1 0 0 1 .684.949V19a2 2 0 0 1-2 2h-1C9.716 21 3 14.284 3 6V5z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        <div style={{ fontSize: '1.05rem', fontWeight: 700, color: '#e2e8f0', marginBottom: 8, letterSpacing: '-0.02em' }}>Request this number?</div>
        <div style={{ fontSize: '0.84rem', color: '#64748b', marginBottom: 20, lineHeight: 1.6 }}>
          You are requesting <span style={{ fontFamily: 'monospace', color: '#60a5fa', fontWeight: 600 }}>{fmt(did.did)}</span>
          {did.city || did.state ? <> {' '}({[did.city, did.state].filter(Boolean).join(', ')})</> : null}
          {' '}for your account. An admin will review and approve the assignment.
        </div>

        <div style={{ padding: '12px 16px', borderRadius: 10, background: 'rgba(245,158,11,0.07)', border: '1px solid rgba(245,158,11,0.18)', marginBottom: 24, fontSize: '0.78rem', lineHeight: 1.5 }}>
          <span style={{ color: '#fbbf24', fontWeight: 600 }}>Note: </span>
          <span style={{ color: '#78716c' }}>This number will be marked as pending until an administrator approves the request. You will be notified once it is assigned.</span>
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onCancel} disabled={isPending} style={{ padding: '9px 20px', borderRadius: 9, border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.04)', color: '#64748b', fontSize: '0.83rem', fontWeight: 500, cursor: isPending ? 'not-allowed' : 'pointer', fontFamily: 'inherit', transition: 'background 0.15s, color 0.15s', opacity: isPending ? 0.5 : 1 }}>Cancel</button>
          <button type="button" onClick={() => onConfirm(did)} disabled={isPending} style={{ padding: '9px 22px', borderRadius: 9, border: 'none', background: isPending ? 'rgba(59,130,246,0.35)' : 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)', color: '#fff', fontSize: '0.83rem', fontWeight: 700, cursor: isPending ? 'not-allowed' : 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 7, boxShadow: isPending ? 'none' : '0 4px 16px rgba(59,130,246,0.35)', transition: 'background 0.15s, box-shadow 0.15s', letterSpacing: '-0.01em' }}>
            {isPending && (
              <svg viewBox="0 0 16 16" style={{ width: 13, height: 13, animation: 'glass-spin 0.7s linear infinite' }}>
                <circle cx="8" cy="8" r="6" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth={2} />
                <path d="M8 2a6 6 0 0 1 6 6" stroke="#fff" strokeWidth={2} fill="none" strokeLinecap="round" />
              </svg>
            )}
            {isPending ? 'Requesting…' : 'Confirm Request'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── ReleaseModal (hold-to-release) ───────────────────────────────────────────

interface ReleaseModalProps {
  did: DidInventoryItem | null;
  onConfirm: (did: DidInventoryItem) => void;
  onCancel: () => void;
  isPending: boolean;
}

export function ReleaseModal({ did, onConfirm, onCancel, isPending }: ReleaseModalProps) {
  // ALL hooks unconditionally at top — early return is below (React #310)
  const [holdProgress, setHoldProgress] = useState(0);
  const [holdPhase, setHoldPhase] = useState<'idle' | 'holding' | 'done'>('idle');
  const rafRef = useRef<number | null>(null);
  const holdStartRef = useRef<number>(0);
  const didFireRef = useRef(false);

  const cancelHold = useCallback(() => {
    if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    setHoldPhase('idle');
    setHoldProgress(0);
    didFireRef.current = false;
  }, []);

  useEffect(() => () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); }, []);

  const startHold = useCallback(() => {
    if (isPending || didFireRef.current) return;
    holdStartRef.current = performance.now();
    setHoldPhase('holding');
    const HOLD_MS = 5000;
    const tick = (now: number) => {
      const elapsed = now - holdStartRef.current;
      const pct = Math.min((elapsed / HOLD_MS) * 100, 100);
      setHoldProgress(pct);
      if (pct >= 100 && !didFireRef.current) {
        didFireRef.current = true;
        setHoldPhase('done');
        rafRef.current = null;
        setTimeout(() => { if (did) onConfirm(did); }, 120);
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [isPending, did, onConfirm]);

  const holdLabel = (() => {
    if (holdPhase === 'done' || isPending) return 'Releasing…';
    if (holdPhase === 'idle') return 'Hold to Release';
    if (holdProgress < 20) return 'Hold to Release…';
    if (holdProgress < 60) return 'Read the warning above…';
    return 'Releasing…';
  })();

  if (!did) return null;
  return (
    <div style={modalOverlay(true)} onClick={(e) => { if (e.target === e.currentTarget && !isPending) onCancel(); }}>
      <div style={{ background: 'linear-gradient(145deg, rgba(26,29,39,0.99) 0%, rgba(19,21,29,1) 100%)', border: '1px solid rgba(239,68,68,0.22)', borderRadius: 18, padding: '32px 32px 28px', maxWidth: 440, width: '100%', position: 'relative', boxShadow: '0 24px 64px -8px rgba(0,0,0,0.80), 0 0 0 1px rgba(239,68,68,0.06)', animation: 'glass-rise 0.2s ease' }}>
        <div style={{ position: 'absolute', top: 0, left: 48, right: 48, height: 2, background: 'linear-gradient(90deg, transparent, rgba(245,158,11,0.65), transparent)', borderRadius: '0 0 2px 2px' }} />

        <div style={{ width: 52, height: 52, borderRadius: 13, background: 'linear-gradient(135deg, rgba(245,158,11,0.16) 0%, rgba(245,158,11,0.07) 100%)', border: '1px solid rgba(245,158,11,0.28)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20, boxShadow: '0 0 20px rgba(245,158,11,0.14)' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth={1.7} style={{ width: 26, height: 26 }}>
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" strokeLinecap="round" strokeLinejoin="round" />
            <line x1="12" y1="9" x2="12" y2="13" strokeLinecap="round" />
            <line x1="12" y1="17" x2="12.01" y2="17" strokeLinecap="round" />
          </svg>
        </div>

        <div style={{ fontSize: '1.08rem', fontWeight: 700, color: '#e2e8f0', marginBottom: 6, letterSpacing: '-0.02em' }}>Release Number</div>
        <div style={{ fontFamily: 'monospace', fontSize: '1.25rem', fontWeight: 800, color: '#60a5fa', letterSpacing: '0.04em', marginBottom: 16 }}>{fmt(did.did)}</div>

        <div style={{ padding: '13px 16px', borderRadius: 10, background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.18)', marginBottom: 18, fontSize: '0.81rem', lineHeight: 1.6 }}>
          <span style={{ color: '#fbbf24', fontWeight: 600 }}>Warning: </span>
          <span style={{ color: '#a3a090' }}>Releasing this number will immediately stop call forwarding. The number will return to the available pool and may be claimed by another customer.</span>
        </div>

        <div style={{ fontSize: '0.83rem', color: '#64748b', marginBottom: 24, lineHeight: 1.55 }}>
          Are you sure you want to release <span style={{ fontFamily: 'monospace', color: '#94a3b8', fontWeight: 600 }}>{fmt(did.did)}</span>?
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onCancel} disabled={isPending || holdPhase === 'done'} style={{ padding: '9px 20px', borderRadius: 9, border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.04)', color: '#64748b', fontSize: '0.83rem', fontWeight: 500, cursor: (isPending || holdPhase === 'done') ? 'not-allowed' : 'pointer', fontFamily: 'inherit', transition: 'background 0.15s, color 0.15s', opacity: (isPending || holdPhase === 'done') ? 0.5 : 1 }}>Cancel</button>

          <button
            type="button"
            disabled={isPending || holdPhase === 'done'}
            onMouseDown={startHold}
            onMouseUp={cancelHold}
            onMouseLeave={cancelHold}
            onTouchStart={(e) => { e.preventDefault(); startHold(); }}
            onTouchEnd={(e) => { e.preventDefault(); cancelHold(); }}
            onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); startHold(); } }}
            onKeyUp={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cancelHold(); } }}
            style={{
              position: 'relative',
              overflow: 'hidden',
              padding: '9px 22px',
              borderRadius: 9,
              border: holdPhase === 'holding' ? '1px solid rgba(239,68,68,0.55)' : '1px solid rgba(239,68,68,0.28)',
              background: holdPhase === 'done' ? 'rgba(239,68,68,0.30)' : 'rgba(239,68,68,0.10)',
              color: holdPhase === 'holding' ? '#fca5a5' : '#f87171',
              fontSize: '0.83rem',
              fontWeight: 700,
              cursor: (isPending || holdPhase === 'done') ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              minWidth: 162,
              letterSpacing: '-0.01em',
              userSelect: 'none',
              WebkitUserSelect: 'none',
              animation: holdPhase === 'holding' ? 'releaseButtonPulse 0.9s ease-in-out infinite' : 'none',
              transition: 'border-color 0.2s, color 0.2s, background 0.2s',
              boxShadow: holdPhase === 'holding' ? '0 0 12px rgba(239,68,68,0.18), inset 0 0 0 1px rgba(239,68,68,0.06)' : '0 0 0 rgba(239,68,68,0)',
            }}
          >
            <div aria-hidden style={{ position: 'absolute', top: 0, left: 0, bottom: 0, borderRadius: 9, background: 'linear-gradient(90deg, rgba(245,158,11,0.55) 0%, rgba(239,68,68,0.7) 100%)', width: `${holdProgress}%`, transition: holdPhase === 'idle' ? 'width 0.35s cubic-bezier(0.4,0,0.2,1)' : 'none', boxShadow: holdProgress > 2 && holdProgress < 100 ? '2px 0 16px 3px rgba(239,68,68,0.6), 0 0 24px rgba(245,158,11,0.3)' : 'none' }} />
            <span style={{ position: 'relative', zIndex: 1, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              {(isPending || holdPhase === 'done') && (
                <svg viewBox="0 0 16 16" style={{ width: 12, height: 12, animation: 'glass-spin 0.7s linear infinite', flexShrink: 0 }}>
                  <circle cx="8" cy="8" r="6" fill="none" stroke="rgba(239,68,68,0.35)" strokeWidth={2} />
                  <path d="M8 2a6 6 0 0 1 6 6" stroke="#ef4444" strokeWidth={2} fill="none" strokeLinecap="round" />
                </svg>
              )}
              {holdLabel}
            </span>
          </button>
        </div>

        <style>{`@keyframes releaseButtonPulse { 0% { box-shadow: 0 0 0 0 rgba(239,68,68,0.30), inset 0 0 0 1px rgba(239,68,68,0.06); } 50% { box-shadow: 0 0 0 4px rgba(239,68,68,0.08), inset 0 0 0 1px rgba(239,68,68,0.10); } 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.00), inset 0 0 0 1px rgba(239,68,68,0.06); } }`}</style>
      </div>
    </div>
  );
}
