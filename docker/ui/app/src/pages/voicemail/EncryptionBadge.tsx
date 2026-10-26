/**
 * EncryptionBadge — "Encrypted at rest" with a short, honest explanation on
 * click/hover. The claim matches the build plan (D1/D2/D8): a per-customer
 * key wraps a fresh key per message; audio is decrypted only in server
 * memory to play it. No FIPS claim, no "end-to-end" claim — the platform can
 * decrypt to play messages for you. Customer copy never names the cipher or
 * the key-management vendor (public copy rules).
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Lock } from 'lucide-react';

export function EncryptionBadge() {
  // ALL hooks unconditionally at the top (React #310).
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  return (
    <span className="vm-enc" ref={wrapRef}>
      <button
        type="button"
        className="vm-enc-pill"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <Lock size={12} strokeWidth={2.4} aria-hidden="true" />
        Encrypted at rest
      </button>
      {open && (
        <span id={panelId} className="vm-enc-panel" role="note">
          <strong>How your voicemail is protected</strong>
          <span>
            Every message and greeting is encrypted before it is stored, with a key that belongs only to your account.
          </span>
          <span>
            Audio is decrypted only in memory, for the moment you play or download it — it is never written to disk
            unencrypted. Messages are deleted automatically when they reach the end of the retention period.
          </span>
        </span>
      )}
    </span>
  );
}
