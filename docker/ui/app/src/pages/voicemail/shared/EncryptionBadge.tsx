import { useState } from 'react';

/* ─── Lock glyph ──────────────────────────────────────────── */

function IconLock({ size = 13 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} style={{ width: size, height: size }}>
      <rect x="5" y="11" width="14" height="9" rx="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 11V8a4 4 0 1 1 8 0v3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="15.5" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

const ACCENT = '#818cf8';

interface EncryptionBadgeProps {
  /** Compact pill (just the lock + label) vs. the default labelled chip. */
  size?: 'sm' | 'md';
  /** Override the label, e.g. for a per-mailbox gov-tier variant. */
  label?: string;
}

/**
 * Reusable trust marker — a lock glyph + "Encrypted at rest" with a short
 * explainer popover. Shown at decision (wizard Review) and consumption (reading
 * pane) moments. The popover is purely presentational — no data leaves the
 * client and no audio URL is ever exposed here.
 */
export function EncryptionBadge({ size = 'md', label = 'Encrypted at rest' }: EncryptionBadgeProps) {
  // All hooks unconditionally at the top (React #310).
  const [open, setOpen] = useState(false);

  const compact = size === 'sm';

  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`${label} — learn more`}
        aria-expanded={open}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: compact ? 5 : 7,
          padding: compact ? '3px 8px' : '5px 11px',
          borderRadius: 999,
          border: `1px solid ${ACCENT}40`,
          background: `linear-gradient(135deg, ${ACCENT}22 0%, ${ACCENT}0e 100%)`,
          color: ACCENT,
          fontSize: compact ? '0.65rem' : '0.72rem',
          fontWeight: 700,
          letterSpacing: '0.01em',
          cursor: 'pointer',
          fontFamily: 'inherit',
          whiteSpace: 'nowrap',
          boxShadow: `0 0 12px ${ACCENT}1f`,
        }}
      >
        <IconLock size={compact ? 11 : 13} />
        {label}
      </button>

      {open && (
        <div
          role="tooltip"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            left: 0,
            zIndex: 60,
            width: 268,
            padding: '12px 14px',
            borderRadius: 12,
            background: '#161922',
            border: `1px solid ${ACCENT}30`,
            boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
            color: '#cbd5e0',
            fontSize: '0.74rem',
            lineHeight: 1.55,
            fontWeight: 400,
            cursor: 'default',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6 }}>
            <span style={{ color: ACCENT, display: 'flex' }}><IconLock size={14} /></span>
            <span style={{ fontWeight: 700, color: '#e2e8f0', fontSize: '0.78rem' }}>
              Your messages are encrypted
            </span>
          </div>
          Every voicemail is sealed with a unique key (AES-256-GCM, envelope-wrapped
          in a managed KMS) the moment it lands. Plaintext is never written to
          disk — audio is decrypted in memory only while you play it, over TLS.
        </div>
      )}
    </span>
  );
}
