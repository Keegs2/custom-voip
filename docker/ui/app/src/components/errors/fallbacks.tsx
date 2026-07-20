/**
 * Fallback surfaces rendered by the ErrorBoundary layers (root / route /
 * softphone). Glass-styled to match the design system but intentionally
 * SELF-CONTAINED: no router hooks, no app contexts, no GlassBackground
 * dependency — a fallback must render even when every provider above it has
 * crashed. Recovery is via plain `window.location` + the boundary's reset.
 */
import { useState, type CSSProperties } from 'react';
import { GLASS, hexToRgba } from '../glass/glass';

/* ─── Shared bits ─────────────────────────────────────────── */

const panelSurface: CSSProperties = {
  background: 'linear-gradient(180deg, rgba(255,255,255,0.055) 0%, rgba(255,255,255,0.02) 55%, rgba(8,10,16,0.35) 100%)',
  backdropFilter: 'blur(18px) saturate(150%)',
  WebkitBackdropFilter: 'blur(18px) saturate(150%)',
  border: '1px solid rgba(255,255,255,0.10)',
  borderRadius: 20,
  boxShadow: `0 24px 64px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.08), 0 0 48px ${hexToRgba(GLASS.accent, 0.08)}`,
};

const buttonBase: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 16px',
  borderRadius: 10,
  fontSize: '0.82rem',
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'background 0.15s, border-color 0.15s, color 0.15s',
};

const primaryButton: CSSProperties = {
  ...buttonBase,
  background: hexToRgba(GLASS.accent, 0.18),
  border: `1px solid ${hexToRgba(GLASS.accent, 0.45)}`,
  color: '#93c5fd',
};

const ghostButton: CSSProperties = {
  ...buttonBase,
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.12)',
  color: GLASS.textMuted,
};

/** Diagnostics blob for the copy-to-clipboard "report" affordance. */
function buildReport(error: Error, scope: string): string {
  return [
    `VoIP portal error report — ${scope}`,
    `Time: ${new Date().toISOString()}`,
    `URL: ${window.location.href}`,
    `User agent: ${navigator.userAgent}`,
    `Error: ${error.name}: ${error.message}`,
    error.stack ?? '(no stack trace)',
  ].join('\n');
}

/** "Copy error details" — the lightweight report affordance shared by every fallback. */
function CopyReportButton({ error, scope, style }: { error: Error; scope: string; style?: CSSProperties }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(buildReport(error, scope));
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
    window.setTimeout(() => setCopied('idle'), 2500);
  };

  return (
    <button type="button" onClick={() => void copy()} style={{ ...ghostButton, ...style }}>
      {copied === 'copied' ? 'Copied — paste into a report' : copied === 'failed' ? 'Copy failed' : 'Copy error details'}
    </button>
  );
}

function ErrorGlyph({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <circle cx="24" cy="24" r="21" stroke={hexToRgba(GLASS.accent, 0.45)} strokeWidth="2.5" />
      <path d="M24 14v14" stroke="#93c5fd" strokeWidth="3" strokeLinecap="round" />
      <circle cx="24" cy="34" r="2" fill="#93c5fd" />
    </svg>
  );
}

/* ─── Root fallback (main.tsx) ────────────────────────────── */

/**
 * Full-page fallback for the root boundary. Renders on a plain dark field
 * (GlassBackground may never have mounted) with a centered frosted panel.
 */
export function RootErrorFallback({ error }: { error: Error }) {
  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        inset: 0,
        background: `radial-gradient(ellipse at 50% 30%, ${hexToRgba(GLASS.accent, 0.10)} 0%, transparent 55%), #0f1117`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        zIndex: 9999,
      }}
    >
      <div style={{ ...panelSurface, maxWidth: 480, width: '100%', padding: '36px 32px', textAlign: 'center' }}>
        <ErrorGlyph />
        <h1 style={{ fontSize: '1.15rem', fontWeight: 700, color: GLASS.text, margin: '18px 0 8px' }}>
          Something went wrong
        </h1>
        <p style={{ fontSize: '0.85rem', color: GLASS.textMuted, lineHeight: 1.6, margin: '0 0 6px' }}>
          The portal hit an unexpected error and could not recover on its own.
          Reloading usually fixes it.
        </p>
        <p style={{ fontSize: '0.72rem', color: GLASS.textFaint, lineHeight: 1.5, margin: '0 0 22px', fontFamily: 'ui-monospace, monospace', wordBreak: 'break-word' }}>
          {error.name}: {error.message}
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button type="button" onClick={() => window.location.reload()} style={primaryButton}>
            Reload portal
          </button>
          <CopyReportButton error={error} scope="root" />
        </div>
        <p style={{ fontSize: '0.68rem', color: GLASS.textFaint, marginTop: 16 }}>
          If this keeps happening, copy the error details and send them to the platform team.
        </p>
      </div>
    </div>
  );
}

/* ─── Route fallback (AppLayout / full-screen routes) ─────── */

/**
 * In-flow fallback for a single crashed page. The app chrome (sidebar,
 * softphone, an active call) keeps running around it; navigating to another
 * page auto-resets the boundary via its `resetKey`.
 */
export function RouteErrorFallback({ error, onReset }: { error: Error; onReset: () => void }) {
  return (
    <div
      role="alert"
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: 'clamp(32px, 8vh, 96px) 24px',
        minHeight: 320,
      }}
    >
      <div style={{ ...panelSurface, maxWidth: 520, width: '100%', padding: '30px 28px', textAlign: 'center' }}>
        <ErrorGlyph size={34} />
        <h2 style={{ fontSize: '1.02rem', fontWeight: 700, color: GLASS.text, margin: '14px 0 8px' }}>
          This page crashed
        </h2>
        <p style={{ fontSize: '0.82rem', color: GLASS.textMuted, lineHeight: 1.6, margin: '0 0 6px' }}>
          Only this page is affected — navigation, other pages, and any active
          call are still running. Try again, or pick another page from the sidebar.
        </p>
        <p style={{ fontSize: '0.7rem', color: GLASS.textFaint, lineHeight: 1.5, margin: '0 0 20px', fontFamily: 'ui-monospace, monospace', wordBreak: 'break-word' }}>
          {error.name}: {error.message}
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button type="button" onClick={onReset} style={primaryButton}>
            Try again
          </button>
          <button type="button" onClick={() => window.location.reload()} style={ghostButton}>
            Reload portal
          </button>
          <CopyReportButton error={error} scope="route" />
        </div>
      </div>
    </div>
  );
}

/* ─── Softphone fallback (SoftphoneWidget) ────────────────── */

/**
 * Compact bottom-right pill shown when the softphone WIDGET crashes. The
 * WebRTC session lives in SoftphoneContext (above this boundary), so an
 * in-progress call keeps its audio — "Restore" remounts the controls fresh.
 */
export function SoftphoneErrorFallback({ error, onReset }: { error: Error; onReset: () => void }) {
  return (
    <div
      role="alert"
      style={{
        ...panelSurface,
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 1000,
        borderRadius: 14,
        padding: '12px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        maxWidth: 360,
      }}
    >
      <div style={{ flexShrink: 0 }}>
        <ErrorGlyph size={22} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '0.78rem', fontWeight: 700, color: GLASS.text }}>Call controls crashed</div>
        <div style={{ fontSize: '0.68rem', color: GLASS.textMuted, lineHeight: 1.4 }}>
          Any active call is still connected.
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
        <button type="button" onClick={onReset} style={{ ...primaryButton, padding: '5px 10px', fontSize: '0.72rem' }}>
          Restore
        </button>
        <CopyReportButton error={error} scope="softphone" style={{ padding: '5px 10px', fontSize: '0.72rem' }} />
      </div>
    </div>
  );
}
