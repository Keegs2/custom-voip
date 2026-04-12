import { useState, useEffect, useRef, useCallback } from 'react';
import { Phone } from 'lucide-react';
import { useSoftphone } from '../../contexts/SoftphoneContext';
import { useAuth } from '../../contexts/AuthContext';
import { PresenceIndicator } from './PresenceIndicator';
import { DialPad } from './DialPad';
import { ActiveCallView } from './ActiveCall';
import { CallHistory } from './CallHistory';
import { ContactList } from './ContactList';
import { DeviceSelector } from './DeviceSelector';
import { IncomingCallBanner } from './IncomingCallBanner';
import type { PresenceStatus } from '../../types/softphone';

type WidgetTab = 'dialpad' | 'call' | 'history' | 'contacts' | 'settings';

const WIDGET_WIDTH = 320;
const WIDGET_HEIGHT = 520;
const FAB_SIZE = 60;
// Conservative fallback used before the FAB is measured. The pill contains
// an icon + label + dot so it is always wider than the 60px circle assumed
// by FAB_SIZE. The real width is measured via fabRef after each render.
const FAB_WIDTH_FALLBACK = 180;
const EDGE_MARGIN = 8;

const PRESENCE_OPTIONS: { value: PresenceStatus; label: string; color: string }[] = [
  { value: 'available', label: 'Available',      color: '#22c55e' },
  { value: 'away',      label: 'Away',           color: '#f59e0b' },
  { value: 'busy',      label: 'Busy',           color: '#ef4444' },
  { value: 'dnd',       label: 'Do Not Disturb', color: '#ef4444' },
  { value: 'offline',   label: 'Appear Offline', color: '#64748b' },
];

const CONNECTION_LABEL: Record<string, { label: string; color: string }> = {
  disconnected: { label: 'Disconnected',       color: '#64748b' },
  connecting:   { label: 'Connecting...',      color: '#f59e0b' },
  connected:    { label: 'Authenticating...', color: '#f59e0b' },
  registered:   { label: 'Registered',         color: '#22c55e' },
  error:        { label: 'Error',              color: '#ef4444' },
};

/* ─── Position helpers ──────────────────────────────────────── */

function defaultPosition(fabWidth: number = FAB_WIDTH_FALLBACK): { x: number; y: number } {
  if (typeof window === 'undefined') return { x: 0, y: 0 };
  // Default: bottom-right corner, FAB docked to right edge.
  // Uses the measured pill width so the full chip stays on screen.
  return {
    x: window.innerWidth  - fabWidth - EDGE_MARGIN,
    y: window.innerHeight - FAB_SIZE - EDGE_MARGIN,
  };
}

function clampPosition(
  x: number,
  y: number,
  isExpanded: boolean,
  fabWidth: number = FAB_WIDTH_FALLBACK,
): { x: number; y: number } {
  if (typeof window === 'undefined') return { x, y };
  // Horizontal extent: for the FAB use the measured pill width, not the circle size.
  const w = isExpanded ? WIDGET_WIDTH : fabWidth;
  const h = isExpanded ? WIDGET_HEIGHT : FAB_SIZE;
  return {
    x: Math.max(EDGE_MARGIN, Math.min(x, window.innerWidth  - w - EDGE_MARGIN)),
    y: Math.max(EDGE_MARGIN, Math.min(y, window.innerHeight - h - EDGE_MARGIN)),
  };
}

// Snap to nearest horizontal edge (left or right), keep vertical position.
// Should be called on drag-end for FAB, and on collapse.
function snapToEdge(
  pos: { x: number; y: number },
  isExpanded: boolean,
  fabWidth: number = FAB_WIDTH_FALLBACK,
): { x: number; y: number } {
  if (typeof window === 'undefined') return pos;
  // Use the measured pill width for horizontal math so the chip never overflows.
  const w = isExpanded ? WIDGET_WIDTH : fabWidth;
  const h = isExpanded ? WIDGET_HEIGHT : FAB_SIZE;
  const centerX = pos.x + w / 2;
  const screenMidX = window.innerWidth / 2;

  const x = centerX < screenMidX
    ? EDGE_MARGIN                              // snap to left edge
    : window.innerWidth - w - EDGE_MARGIN;    // snap to right edge

  const y = Math.max(EDGE_MARGIN, Math.min(pos.y, window.innerHeight - h - EDGE_MARGIN));

  return { x, y };
}

// Given a FAB position, compute where the panel should open so it stays on screen.
// Aligns the panel to the same side (left/right) as the FAB.
function expandedPositionFromFab(
  fabPos: { x: number; y: number },
  fabWidth: number = FAB_WIDTH_FALLBACK,
): { x: number; y: number } {
  if (typeof window === 'undefined') return fabPos;
  const fabCenterX = fabPos.x + fabWidth / 2;
  const onRightSide = fabCenterX >= window.innerWidth / 2;

  const x = onRightSide
    ? window.innerWidth - WIDGET_WIDTH - EDGE_MARGIN   // right-align panel
    : EDGE_MARGIN;                                      // left-align panel

  const y = Math.max(EDGE_MARGIN, Math.min(fabPos.y, window.innerHeight - WIDGET_HEIGHT - EDGE_MARGIN));

  return { x, y };
}

function loadSavedPosition(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem('softphone-position');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'x' in parsed &&
      'y' in parsed &&
      typeof (parsed as Record<string, unknown>).x === 'number' &&
      typeof (parsed as Record<string, unknown>).y === 'number'
    ) {
      return { x: (parsed as { x: number; y: number }).x, y: (parsed as { x: number; y: number }).y };
    }
  } catch {
    // ignore malformed storage
  }
  return null;
}

function savePosition(pos: { x: number; y: number }): void {
  try {
    localStorage.setItem('softphone-position', JSON.stringify(pos));
  } catch {
    // ignore storage errors
  }
}

/* ─── Icons ──────────────────────────────────────────────────── */

const IconPhone = () => <Phone size={18} />;

const IconClose = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
    <path d="M6 18 18 6M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconDialpad = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ width: 16, height: 16 }}>
    <path d="M3.75 6A2.25 2.25 0 0 1 6 3.75h.008a2.25 2.25 0 0 1 2.243 2.25v.008A2.25 2.25 0 0 1 6.008 8.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h.008a2.25 2.25 0 0 1 2.243 2.25v.008A2.25 2.25 0 0 1 6.008 18H6a2.25 2.25 0 0 1-2.25-2.25v-.008ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25h.008A2.25 2.25 0 0 1 18 6v.008a2.25 2.25 0 0 1-2.242 2.242H15.75A2.25 2.25 0 0 1 13.5 6.008V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25h.008a2.25 2.25 0 0 1 2.242 2.25v.008a2.25 2.25 0 0 1-2.242 2.242H15.75a2.25 2.25 0 0 1-2.25-2.242v-.008Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconHistory = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ width: 16, height: 16 }}>
    <path d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconContacts = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ width: 16, height: 16 }}>
    <path d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconSettings = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ width: 16, height: 16 }}>
    <path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconGripDots = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" style={{ width: 12, height: 12 }}>
    <circle cx="5" cy="4"  r="1.2" />
    <circle cx="5" cy="8"  r="1.2" />
    <circle cx="5" cy="12" r="1.2" />
    <circle cx="11" cy="4"  r="1.2" />
    <circle cx="11" cy="8"  r="1.2" />
    <circle cx="11" cy="12" r="1.2" />
  </svg>
);

/* ─── Animated sound wave bars (for ringing state) ─────────── */

function SoundWaveBars({ color = '#22c55e' }: { color?: string }) {
  const bars = [0.4, 0.7, 1.0, 0.7, 0.4];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, height: 20 }}>
      {bars.map((scale, i) => (
        <div
          key={i}
          style={{
            width: 3,
            borderRadius: 2,
            background: color,
            height: `${scale * 100}%`,
            animation: `softphone-wave 0.9s ease-in-out ${i * 0.12}s infinite alternate`,
            opacity: 0.85,
          }}
        />
      ))}
    </div>
  );
}

/* ─── Animated ellipsis for "Calling..." ────────────────────── */

function AnimatedEllipsis() {
  return (
    <span>
      <span style={{ animation: 'softphone-dot 1.2s 0.0s infinite' }}>.</span>
      <span style={{ animation: 'softphone-dot 1.2s 0.4s infinite' }}>.</span>
      <span style={{ animation: 'softphone-dot 1.2s 0.8s infinite' }}>.</span>
    </span>
  );
}

/* ─── Dialing / ringing outbound indicator ──────────────────── */

function OutboundRingingIndicator({ remoteName, remoteNumber }: { remoteName: string; remoteNumber: string }) {
  const displayName = remoteName && remoteName !== remoteNumber ? remoteName : null;
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        padding: '20px 16px',
        textAlign: 'center',
      }}
    >
      {/* Pulsing ring stack */}
      <div style={{ position: 'relative', width: 72, height: 72, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            border: '2px solid rgba(59,130,246,0.6)',
            animation: 'softphone-ripple 1.6s 0.0s ease-out infinite',
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            border: '2px solid rgba(59,130,246,0.4)',
            animation: 'softphone-ripple 1.6s 0.5s ease-out infinite',
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: '50%',
            border: '2px solid rgba(59,130,246,0.25)',
            animation: 'softphone-ripple 1.6s 1.0s ease-out infinite',
          }}
        />
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, #1d4ed8 0%, #3b82f6 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 4px 20px rgba(59,130,246,0.5)',
            animation: 'softphone-glow-blue 2s ease-in-out infinite',
            zIndex: 1,
          }}
        >
          <svg viewBox="0 0 24 24" fill="white" style={{ width: 22, height: 22, animation: 'softphone-ring 2s ease-in-out infinite' }}>
            <path fillRule="evenodd" d="M1.5 4.5a3 3 0 0 1 3-3h1.372c.86 0 1.61.586 1.819 1.42l1.105 4.423a1.875 1.875 0 0 1-.694 1.955l-1.293.97c-.135.101-.164.249-.126.352a11.285 11.285 0 0 0 6.697 6.697c.103.038.25.009.352-.126l.97-1.293a1.875 1.875 0 0 1 1.955-.694l4.423 1.105c.834.209 1.42.959 1.42 1.82V19.5a3 3 0 0 1-3 3h-2.25C8.552 22.5 1.5 15.448 1.5 6.75V4.5Z" clipRule="evenodd" />
          </svg>
        </div>
      </div>

      <div>
        <div style={{ fontSize: '0.7rem', fontWeight: 600, color: '#60a5fa', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>
          Calling<AnimatedEllipsis />
        </div>
        {displayName && (
          <div style={{ fontSize: '1.05rem', fontWeight: 700, color: '#f1f5f9', letterSpacing: '-0.02em' }}>
            {displayName}
          </div>
        )}
        <div style={{ fontSize: displayName ? '0.8rem' : '1rem', color: displayName ? '#64748b' : '#94a3b8', fontFamily: 'monospace', fontWeight: 500 }}>
          {remoteNumber}
        </div>
      </div>

      <SoundWaveBars color="#3b82f6" />
    </div>
  );
}

/* ─── CSS animations injected once ─────────────────────────── */

const SOFTPHONE_STYLES = `
  @keyframes softphone-ring {
    0%, 100% { transform: rotate(0deg); }
    10%       { transform: rotate(14deg); }
    20%       { transform: rotate(-14deg); }
    30%       { transform: rotate(9deg); }
    40%       { transform: rotate(-9deg); }
    50%       { transform: rotate(4deg); }
    60%       { transform: rotate(-4deg); }
  }

  @keyframes softphone-pulse-green {
    0%, 100% { box-shadow: 0 0 0 0   rgba(34,197,94,0.55); }
    50%       { box-shadow: 0 0 0 14px rgba(34,197,94,0); }
  }

  @keyframes softphone-pulse-fab {
    0%, 100% { box-shadow: 0 4px 20px rgba(34,197,94,0.40), 0 0 0 0   rgba(34,197,94,0.50); }
    50%       { box-shadow: 0 4px 32px rgba(34,197,94,0.65), 0 0 0 18px rgba(34,197,94,0); }
  }

  @keyframes softphone-glow {
    0%, 100% { box-shadow: 0 4px 20px rgba(59,130,246,0.30); }
    50%       { box-shadow: 0 4px 32px rgba(59,130,246,0.65), 0 0 60px rgba(59,130,246,0.20); }
  }

  @keyframes softphone-glow-blue {
    0%, 100% { box-shadow: 0 4px 20px rgba(59,130,246,0.45); }
    50%       { box-shadow: 0 4px 30px rgba(59,130,246,0.75), 0 0 50px rgba(59,130,246,0.30); }
  }

  @keyframes softphone-glow-green-idle {
    0%, 100% { box-shadow: 0 4px 16px rgba(34,197,94,0.35), 0 0 0 0 rgba(34,197,94,0.20); }
    50%       { box-shadow: 0 4px 28px rgba(34,197,94,0.60), 0 0 32px rgba(34,197,94,0.18); }
  }

  @keyframes softphone-ripple {
    0%   { transform: scale(1);    opacity: 0.8; }
    100% { transform: scale(1.85); opacity: 0; }
  }

  @keyframes softphone-shake {
    0%, 100% { transform: translateX(0); }
    20%       { transform: translateX(-4px); }
    40%       { transform: translateX(4px); }
    60%       { transform: translateX(-3px); }
    80%       { transform: translateX(3px); }
  }

  @keyframes softphone-bounce {
    0%, 100% { transform: translateY(0); }
    40%       { transform: translateY(-6px); }
    60%       { transform: translateY(-3px); }
  }

  @keyframes softphone-wave {
    from { transform: scaleY(0.3); opacity: 0.6; }
    to   { transform: scaleY(1.0); opacity: 1.0; }
  }

  @keyframes softphone-dot {
    0%, 80%, 100% { opacity: 0; }
    40%            { opacity: 1; }
  }

  @keyframes softphone-header-pulse {
    0%, 100% { background: linear-gradient(90deg, rgba(22,163,74,0.18) 0%, rgba(34,197,94,0.10) 100%); }
    50%       { background: linear-gradient(90deg, rgba(22,163,74,0.30) 0%, rgba(34,197,94,0.18) 100%); }
  }

  @keyframes softphone-slide-up {
    from { transform: translateY(12px); opacity: 0; }
    to   { transform: translateY(0);   opacity: 1; }
  }

  @keyframes softphone-ripple-accept {
    0%   { transform: scale(1);   opacity: 0.6; }
    100% { transform: scale(2.2); opacity: 0;   }
  }

  @keyframes softphone-dial-flash {
    0%   { background: rgba(59,130,246,0.30); box-shadow: 0 0 0 0 rgba(59,130,246,0.50); }
    40%  { background: rgba(59,130,246,0.18); box-shadow: 0 0 12px 4px rgba(59,130,246,0.25); }
    100% { background: rgba(255,255,255,0.05); box-shadow: none; }
  }

  @keyframes softphone-presence-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%       { opacity: 0.65; transform: scale(1.35); }
  }

  /* ── Tab bar buttons ── */
  .sp-tab-btn {
    transition: color 0.15s ease, background 0.15s ease, transform 0.12s ease;
  }
  .sp-tab-btn:hover:not([aria-selected="true"]) {
    color: #94a3b8 !important;
    background: rgba(255,255,255,0.04) !important;
  }
  .sp-tab-btn:active {
    transform: scale(0.95);
    background: rgba(255,255,255,0.06) !important;
  }
  .sp-tab-btn[aria-selected="true"] {
    color: #60a5fa !important;
  }

  /* ── Close / minimize button ── */
  .sp-close-btn {
    transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease, transform 0.12s ease;
  }
  .sp-close-btn:hover {
    color: #f87171 !important;
    background: rgba(239,68,68,0.12) !important;
    border-color: rgba(239,68,68,0.25) !important;
    transform: rotate(8deg);
  }
  .sp-close-btn:active {
    transform: scale(0.88) rotate(8deg);
    background: rgba(239,68,68,0.20) !important;
  }

  /* ── Dial pad digit buttons ── */
  .sp-dial-key {
    transition: background 0.10s ease, border-color 0.10s ease, transform 0.08s ease, box-shadow 0.10s ease;
    position: relative;
    overflow: hidden;
  }
  .sp-dial-key:hover {
    background: rgba(255,255,255,0.10) !important;
    border-color: rgba(59,130,246,0.30) !important;
    box-shadow: 0 0 0 1px rgba(59,130,246,0.15) inset !important;
  }
  .sp-dial-key:active {
    transform: scale(0.92) !important;
    background: rgba(59,130,246,0.18) !important;
    animation: softphone-dial-flash 0.35s ease-out forwards;
  }

  /* ── Call (green) button ── */
  .sp-call-btn {
    transition: transform 0.12s ease, box-shadow 0.15s ease, opacity 0.2s;
  }
  .sp-call-btn:not(:disabled):hover {
    transform: scale(1.05);
    box-shadow: 0 6px 28px rgba(34,197,94,0.55) !important;
  }
  .sp-call-btn:not(:disabled):active {
    transform: scale(0.91) !important;
    box-shadow: 0 2px 10px rgba(34,197,94,0.40) !important;
  }
  .sp-call-btn:not(:disabled) {
    animation: softphone-glow-green-idle 2.4s ease-in-out infinite;
  }

  /* ── Hangup (red) button ── */
  .sp-hangup-btn {
    transition: transform 0.12s ease, box-shadow 0.15s ease;
  }
  .sp-hangup-btn:not(:disabled):hover {
    transform: scale(1.05);
    box-shadow: 0 6px 28px rgba(239,68,68,0.65) !important;
  }
  .sp-hangup-btn:not(:disabled):active {
    transform: scale(0.90) !important;
    box-shadow: 0 2px 8px rgba(239,68,68,0.40) !important;
  }

  /* ── Mute / Hold / Keypad action buttons ── */
  .sp-action-btn {
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, transform 0.12s ease, box-shadow 0.15s ease;
  }
  .sp-action-btn:not(:disabled):hover {
    background: rgba(255,255,255,0.12) !important;
    color: #f1f5f9 !important;
    border-color: rgba(255,255,255,0.18) !important;
  }
  .sp-action-btn:not(:disabled):active {
    transform: scale(0.93) !important;
  }

  /* ── DTMF pad (in-call keypad) ── */
  .sp-dtmf-key {
    transition: background 0.10s ease, transform 0.08s ease;
  }
  .sp-dtmf-key:hover {
    background: rgba(255,255,255,0.10) !important;
    border-color: rgba(59,130,246,0.25) !important;
  }
  .sp-dtmf-key:active {
    transform: scale(0.93);
    background: rgba(59,130,246,0.15) !important;
  }

  /* ── Back-to-controls link ── */
  .sp-back-btn {
    transition: color 0.12s ease;
  }
  .sp-back-btn:hover {
    color: #94a3b8 !important;
  }

  /* ── Backspace button ── */
  .sp-backspace-btn {
    transition: color 0.12s ease, background 0.12s ease, transform 0.10s ease;
  }
  .sp-backspace-btn:hover {
    color: #94a3b8 !important;
    background: rgba(255,255,255,0.06) !important;
  }
  .sp-backspace-btn:active {
    transform: scale(0.88);
  }

  /* ── Contact list rows ── */
  .sp-contact-row {
    transition: background 0.12s ease, border-left-color 0.12s ease;
    border-left: 2px solid transparent;
  }
  .sp-contact-row:hover {
    background: rgba(59,130,246,0.06) !important;
    border-left-color: rgba(59,130,246,0.40) !important;
  }
  .sp-contact-row:active {
    background: rgba(59,130,246,0.10) !important;
  }

  /* ── Contact call button ── */
  .sp-contact-call-btn {
    transition: background 0.15s ease, transform 0.12s ease, box-shadow 0.15s ease;
  }
  .sp-contact-call-btn:hover {
    background: rgba(34,197,94,0.22) !important;
    transform: scale(1.08);
    box-shadow: 0 0 10px rgba(34,197,94,0.30) !important;
  }
  .sp-contact-call-btn:active {
    transform: scale(0.93) !important;
  }

  /* ── Presence dot — pulse on available ── */
  .sp-presence-available {
    animation: softphone-presence-pulse 2.2s ease-in-out infinite;
  }

  /* ── Call history rows ── */
  .sp-history-row {
    transition: background 0.12s ease;
    position: relative;
  }
  .sp-history-row:hover {
    background: rgba(255,255,255,0.04) !important;
  }
  .sp-history-row:active {
    background: rgba(255,255,255,0.07) !important;
  }

  /* ── History call-back button ── */
  .sp-callback-btn {
    transition: background 0.12s ease, color 0.12s ease, transform 0.10s ease, box-shadow 0.12s ease;
  }
  .sp-callback-btn:hover {
    background: rgba(34,197,94,0.22) !important;
    color: #86efac !important;
    box-shadow: 0 0 8px rgba(34,197,94,0.25) !important;
  }
  .sp-callback-btn:active {
    transform: scale(0.93);
  }

  /* ── Call history filter tabs ── */
  .sp-filter-btn {
    transition: all 0.15s ease;
  }
  .sp-filter-btn:hover {
    background: rgba(255,255,255,0.05) !important;
    color: #94a3b8 !important;
  }
  .sp-filter-btn:active {
    transform: scale(0.95);
  }

  /* ── Presence dropdown items ── */
  .sp-presence-opt {
    transition: background 0.12s ease;
  }
  .sp-presence-opt:hover {
    background: rgba(255,255,255,0.08) !important;
  }
  .sp-presence-opt:active {
    background: rgba(255,255,255,0.12) !important;
  }

  /* ── Device selector ── */
  .sp-device-select {
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .sp-device-select:hover {
    border-color: rgba(255,255,255,0.18) !important;
    box-shadow: 0 0 0 1px rgba(59,130,246,0.15) !important;
  }
  .sp-device-select:focus {
    border-color: rgba(59,130,246,0.50) !important;
    box-shadow: 0 0 0 2px rgba(59,130,246,0.15) !important;
  }
`;

/* ─── Main component ─────────────────────────────────────────── */

export function SoftphoneWidget() {
  const {
    connectionState,
    activeCall,
    incomingCall,
    presence,
    isExpanded,
    credentials,
    setExpanded,
    setPresence,
  } = useSoftphone();
  const { user } = useAuth();

  const [activeTab, setActiveTab] = useState<WidgetTab>('dialpad');
  const [showPresenceMenu, setShowPresenceMenu] = useState(false);

  // ── FAB size measurement ──
  // The FAB is a pill chip (icon + label + dot) whose rendered width varies
  // with content. We measure it after every render so all edge-snapping math
  // uses the real width rather than a hardcoded guess.
  const fabRef = useRef<HTMLButtonElement>(null);
  const [fabWidth, setFabWidth] = useState<number>(FAB_WIDTH_FALLBACK);

  // ── Drag state ──
  const [position, setPosition] = useState<{ x: number; y: number }>(() => {
    const saved = loadSavedPosition();
    if (saved) {
      // Re-snap to edge in case viewport has changed since last save.
      // We always persist the FAB (collapsed) position, so snap as FAB.
      return snapToEdge(saved, false, FAB_WIDTH_FALLBACK);
    }
    return defaultPosition(FAB_WIDTH_FALLBACK);
  });
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  // Mousedown coordinates recorded on the FAB — used to compute drag distance
  // and distinguish a click (< 5px) from a real drag (>= 5px).
  const fabMouseDownPos = useRef<{ x: number; y: number } | null>(null);

  /* ─── Measure FAB width after every render ──────────────────── */
  // We run this as a layout effect so the measurement happens synchronously
  // after DOM mutation, before the browser paints. That way the very first
  // paint already uses the correct position if the FAB was just snapped.
  useEffect(() => {
    if (!fabRef.current) return;
    const measured = fabRef.current.offsetWidth;
    if (measured > 0 && measured !== fabWidth) {
      setFabWidth(measured);
      // If the FAB is currently collapsed and snapped to the right edge,
      // re-snap with the freshly measured width so it doesn't overflow.
      if (!isExpanded) {
        setPosition((prev) => {
          const snapped = snapToEdge(prev, false, measured);
          savePosition(snapped);
          return snapped;
        });
      }
    }
  });

  /* ─── Drag handlers ────────────────────────────────────────── */

  const handleDragStart = useCallback(
    (clientX: number, clientY: number) => {
      dragOffset.current = { x: clientX - position.x, y: clientY - position.y };
      setIsDragging(true);
    },
    [position],
  );

  const handleDragMove = useCallback(
    (clientX: number, clientY: number) => {
      if (!isDragging) return;
      const newX = clientX - dragOffset.current.x;
      const newY = clientY - dragOffset.current.y;
      setPosition({ x: newX, y: newY });
    },
    [isDragging],
  );

  const handleDragEnd = useCallback(
    (clientX: number, clientY: number) => {
      if (!isDragging) return;
      setIsDragging(false);

      const rawPos = {
        x: clientX - dragOffset.current.x,
        y: clientY - dragOffset.current.y,
      };

      let finalPos: { x: number; y: number };
      if (!isExpanded) {
        // FAB: always snap to nearest horizontal edge after drag ends
        finalPos = snapToEdge(rawPos, false, fabWidth);
        // Save FAB edge position so expand/collapse can reference it
        savePosition(finalPos);
      } else {
        // Panel: just clamp within viewport, no edge-snapping
        finalPos = clampPosition(rawPos.x, rawPos.y, true, fabWidth);
        // Don't persist panel position — we always derive it from FAB position
      }
      setPosition(finalPos);
    },
    [isDragging, isExpanded, fabWidth],
  );

  // Attach global mouse listeners while dragging
  useEffect(() => {
    if (!isDragging) return;

    const onMouseMove = (e: MouseEvent) => handleDragMove(e.clientX, e.clientY);
    const onMouseUp   = (e: MouseEvent) => handleDragEnd(e.clientX, e.clientY);

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup',   onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup',   onMouseUp);
    };
  }, [isDragging, handleDragMove, handleDragEnd]);

  // Re-snap / re-clamp position whenever window resizes
  useEffect(() => {
    const onResize = () => {
      setPosition((prev) => {
        if (!isExpanded) {
          // Re-snap FAB to the same edge but within new viewport bounds
          const snapped = snapToEdge(prev, false, fabWidth);
          savePosition(snapped);
          return snapped;
        }
        // Panel: just clamp within new viewport
        return clampPosition(prev.x, prev.y, true, fabWidth);
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isExpanded, fabWidth]);

  // Collapse the panel and snap the FAB to the nearest horizontal edge.
  // This is the canonical "close" action, called only from the X button.
  const collapsePanel = useCallback(() => {
    const fabPos = snapToEdge(position, false, fabWidth);
    setPosition(fabPos);
    savePosition(fabPos);
    setExpanded(false);
  }, [position, fabWidth, setExpanded]);

  // FAB onMouseUp — used instead of onClick so we can apply the 5px drag
  // threshold right at the moment of release without racing against the
  // global mouseup handler (handleDragEnd) that runs first.
  const onFabMouseUp = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      // If already expanded, the FAB does nothing — only X closes the panel.
      if (isExpanded) return;

      const downPos = fabMouseDownPos.current;
      if (!downPos) return;

      const dx = e.clientX - downPos.x;
      const dy = e.clientY - downPos.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      // Less than 5px of movement → treat as a click, expand immediately.
      if (distance < 5) {
        const panelPos = expandedPositionFromFab(position, fabWidth);
        setPosition(panelPos);
        setExpanded(true);
      }
      // >= 5px → was a drag; handleDragEnd already snapped the FAB to edge.
    },
    [isExpanded, position, fabWidth, setExpanded],
  );

  // ── Guard: UCaaS feature check ──
  const hasUcaas =
    user?.role === 'admin' ||
    user?.account_type === 'ucaas' ||
    (user?.account_type !== 'rcf' && user?.ucaas_enabled === true);
  if (!hasUcaas) return null;
  if (!credentials && connectionState === 'disconnected') return null;

  const hasActiveCall = activeCall !== null && activeCall.state !== 'ended';
  const isIncoming = incomingCall !== null;
  const isDialingOrRinging =
    hasActiveCall &&
    activeCall.direction === 'outbound' &&
    (activeCall.state === 'dialing' || activeCall.state === 'ringing' || activeCall.state === 'early');
  const connInfo = CONNECTION_LABEL[connectionState] ?? CONNECTION_LABEL['disconnected'];

  // Auto-switch to call tab when outbound call starts
  const effectiveTab = hasActiveCall && activeTab === 'dialpad' ? 'call' : activeTab;

  const tabs: { id: WidgetTab; icon: React.ReactNode; label: string; badge?: number }[] = [
    { id: 'dialpad',  icon: <IconDialpad />,  label: 'Pad' },
    { id: 'call',     icon: <IconPhone />,    label: 'Call' },
    { id: 'history',  icon: <IconHistory />,  label: 'History' },
    { id: 'contacts', icon: <IconContacts />, label: 'Contacts' },
    { id: 'settings', icon: <IconSettings />, label: 'Settings' },
  ];

  /* ─── Mouse event shims for drag handle ─────────────────────── */

  const onHeaderMouseDown = (e: React.MouseEvent) => {
    // Only left mouse button
    if (e.button !== 0) return;
    e.preventDefault();
    handleDragStart(e.clientX, e.clientY);
  };

  const onHeaderTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    handleDragStart(touch.clientX, touch.clientY);
  };

  const onHeaderTouchMove = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    e.preventDefault();
    handleDragMove(touch.clientX, touch.clientY);
  };

  const onHeaderTouchEnd = (e: React.TouchEvent) => {
    const touch = e.changedTouches[0];
    if (!touch) return;
    handleDragEnd(touch.clientX, touch.clientY);
  };

  /* ─── Derived visual states ──────────────────────────────────── */

  const fabBackground = isIncoming
    ? 'linear-gradient(135deg, #166534 0%, #22c55e 100%)'
    : hasActiveCall
    ? 'linear-gradient(135deg, #16a34a 0%, #22c55e 100%)'
    : 'linear-gradient(135deg, #1d2235 0%, #252d42 100%)';

  const fabBoxShadow = isIncoming
    ? undefined // driven by animation
    : hasActiveCall
    ? '0 4px 20px rgba(34,197,94,0.45)'
    : isDragging
    ? '0 8px 32px rgba(0,0,0,0.60)'
    : '0 2px 12px rgba(0,0,0,0.4), 0 0 20px rgba(59,130,246,0.15), inset 0 1px 0 rgba(255,255,255,0.06)';

  const headerBackground = isIncoming
    ? 'linear-gradient(90deg, rgba(22,163,74,0.22) 0%, rgba(34,197,94,0.12) 100%)'
    : hasActiveCall && activeCall?.state === 'active'
    ? 'rgba(22,163,74,0.08)'
    : 'transparent';

  const panelBoxShadow = isDragging
    ? '0 32px 80px rgba(0,0,0,0.80), 0 0 0 1px rgba(255,255,255,0.06)'
    : isIncoming
    ? '0 24px 64px rgba(0,0,0,0.70), 0 0 0 1px rgba(34,197,94,0.20), 0 0 40px rgba(34,197,94,0.08)'
    : '0 8px 32px rgba(0,0,0,0.5), 0 0 40px rgba(59,130,246,0.08), inset 0 1px 0 rgba(255,255,255,0.04)';

  /* ─── Render ──────────────────────────────────────────────────── */

  return (
    <>
      {/* Incoming call banner renders via portal at top of screen */}
      <IncomingCallBanner />

      {/* Inject keyframe animations */}
      <style>{SOFTPHONE_STYLES}</style>

      {/* Fixed-positioned root — position driven by drag state */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          zIndex: 1000,
          // Translate to the dragged position; GPU-composited layer for smooth drag
          transform: `translate(${position.x}px, ${position.y}px)`,
          willChange: isDragging ? 'transform' : 'auto',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: 10,
          // Disable transition while dragging so it tracks the pointer exactly
          transition: isDragging ? 'none' : 'transform 0.18s cubic-bezier(0.25,0.46,0.45,0.94)',
        }}
      >
        {/* ── Expanded panel ── */}
        {isExpanded && (
          <div
            style={{
              width: WIDGET_WIDTH,
              maxHeight: 520,
              display: 'flex',
              flexDirection: 'column',
              background: 'linear-gradient(180deg, #131825 0%, #0f1420 100%)',
              border: '1px solid rgba(59,130,246,0.15)',
              borderRadius: 20,
              boxShadow: panelBoxShadow,
              overflow: 'hidden',
              animation: 'softphone-slide-up 0.22s cubic-bezier(0.34,1.56,0.64,1)',
            }}
          >
            {/* ── Drag handle / header ── */}
            <div
              onMouseDown={onHeaderMouseDown}
              onTouchStart={onHeaderTouchStart}
              onTouchMove={onHeaderTouchMove}
              onTouchEnd={onHeaderTouchEnd}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '14px 16px 10px',
                borderBottom: isIncoming
                  ? '1px solid rgba(34,197,94,0.20)'
                  : '1px solid rgba(255,255,255,0.06)',
                flexShrink: 0,
                cursor: isDragging ? 'grabbing' : 'grab',
                userSelect: 'none',
                background: headerBackground,
                animation: isIncoming ? 'softphone-header-pulse 2s ease-in-out infinite' : undefined,
                transition: 'background 0.3s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {/* Grip dots — visual affordance */}
                <span style={{ color: 'rgba(255,255,255,0.18)', flexShrink: 0, display: 'flex' }}>
                  <IconGripDots />
                </span>

                {/* Presence dot — clickable */}
                <div style={{ position: 'relative' }}>
                  <button
                    type="button"
                    onClick={(e) => {
                      // Prevent header drag from swallowing this click
                      e.stopPropagation();
                      setShowPresenceMenu((v) => !v);
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    aria-label="Set presence status"
                    aria-haspopup="listbox"
                    aria-expanded={showPresenceMenu}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      padding: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <PresenceIndicator status={presence} size={10} />
                  </button>

                  {/* Presence dropdown */}
                  {showPresenceMenu && (
                    <div
                      onMouseDown={(e) => e.stopPropagation()}
                      style={{
                        position: 'absolute',
                        top: 20,
                        left: 0,
                        background: '#1e2435',
                        border: '1px solid rgba(255,255,255,0.10)',
                        borderRadius: 10,
                        boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
                        zIndex: 10,
                        minWidth: 160,
                        overflow: 'hidden',
                      }}
                      role="listbox"
                      aria-label="Presence status options"
                    >
                      {PRESENCE_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          role="option"
                          aria-selected={presence === opt.value}
                          onClick={() => {
                            void setPresence(opt.value);
                            setShowPresenceMenu(false);
                          }}
                          className="sp-presence-opt"
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            width: '100%',
                            padding: '8px 12px',
                            background: presence === opt.value ? 'rgba(255,255,255,0.06)' : 'transparent',
                            border: 'none',
                            color: '#e2e8f0',
                            fontSize: '0.8rem',
                            cursor: 'pointer',
                            textAlign: 'left',
                          }}
                        >
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: opt.color, flexShrink: 0 }} />
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#94a3b8', letterSpacing: '-0.01em' }}>
                  Softphone
                </span>

                {/* Connection status pill */}
                <span
                  style={{
                    fontSize: '0.6rem',
                    fontWeight: 600,
                    color: connInfo.color,
                    background: `${connInfo.color}18`,
                    border: `1px solid ${connInfo.color}30`,
                    borderRadius: 10,
                    padding: '2px 6px',
                    letterSpacing: '0.04em',
                  }}
                >
                  {connInfo.label}
                </span>

                {/* Active call status chip */}
                {hasActiveCall && activeCall.state === 'active' && (
                  <span
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: '0.6rem',
                      fontWeight: 600,
                      color: '#22c55e',
                      background: 'rgba(34,197,94,0.12)',
                      border: '1px solid rgba(34,197,94,0.25)',
                      borderRadius: 10,
                      padding: '2px 6px',
                    }}
                  >
                    <span
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: '50%',
                        background: '#22c55e',
                        animation: 'softphone-pulse-green 1.4s ease-in-out infinite',
                        flexShrink: 0,
                      }}
                    />
                    Live
                  </span>
                )}

                {isIncoming && (
                  <span
                    style={{
                      fontSize: '0.6rem',
                      fontWeight: 600,
                      color: '#86efac',
                      background: 'rgba(34,197,94,0.15)',
                      border: '1px solid rgba(34,197,94,0.30)',
                      borderRadius: 10,
                      padding: '2px 6px',
                      animation: 'softphone-dot 1.4s ease-in-out infinite',
                    }}
                  >
                    Ringing
                  </span>
                )}
              </div>

              {/* Minimize button — the ONLY way to close the expanded panel */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  collapsePanel();
                }}
                onMouseDown={(e) => e.stopPropagation()}
                aria-label="Minimize softphone"
                className="sp-close-btn"
                style={{
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 6,
                  color: '#475569',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 24,
                  height: 24,
                  padding: 0,
                  flexShrink: 0,
                }}
              >
                <IconClose />
              </button>
            </div>

            {/* ── Outbound dialing / ringing state ── */}
            {isDialingOrRinging && (
              <OutboundRingingIndicator
                remoteName={activeCall.remoteName}
                remoteNumber={activeCall.remoteNumber}
              />
            )}

            {/* ── Tab bar (hidden while dialing outbound) ── */}
            {!isDialingOrRinging && (
              <div
                style={{
                  display: 'flex',
                  borderBottom: '1px solid rgba(255,255,255,0.06)',
                  flexShrink: 0,
                }}
              >
                {tabs.map((tab) => {
                  if (tab.id === 'call' && !hasActiveCall) return null;
                  const isActive = effectiveTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setActiveTab(tab.id)}
                      aria-label={tab.label}
                      aria-selected={isActive}
                      className="sp-tab-btn"
                      style={{
                        flex: 1,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 3,
                        padding: '8px 4px',
                        background: 'transparent',
                        border: 'none',
                        borderBottom: isActive ? '2px solid #3b82f6' : '2px solid transparent',
                        color: isActive ? '#60a5fa' : '#475569',
                        cursor: 'pointer',
                        fontSize: '0.58rem',
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        position: 'relative',
                      }}
                    >
                      {tab.icon}
                      {tab.label}
                      {tab.badge !== undefined && tab.badge > 0 && (
                        <span
                          style={{
                            position: 'absolute',
                            top: 5,
                            right: '50%',
                            transform: 'translateX(8px)',
                            minWidth: 14,
                            height: 14,
                            borderRadius: 7,
                            background: '#ef4444',
                            color: '#fff',
                            fontSize: '0.55rem',
                            fontWeight: 700,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: '0 3px',
                          }}
                        >
                          {tab.badge > 99 ? '99+' : tab.badge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* ── Tab content ── */}
            {!isDialingOrRinging && (
              <div
                style={{
                  flex: 1,
                  overflowY: 'auto',
                  padding: '12px 14px',
                  minHeight: 0,
                }}
              >
                {effectiveTab === 'dialpad'  && <DialPad />}
                {effectiveTab === 'call'     && <ActiveCallView />}
                {effectiveTab === 'history'  && <CallHistory />}
                {effectiveTab === 'contacts' && <ContactList />}
                {effectiveTab === 'settings' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                    <DeviceSelector />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── FAB / pill toggle button ── */}
        <button
          ref={fabRef}
          type="button"
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            // Record the exact pixel where the press began so onMouseUp can
            // measure how far the pointer travelled to distinguish click vs drag.
            fabMouseDownPos.current = { x: e.clientX, y: e.clientY };
            handleDragStart(e.clientX, e.clientY);
          }}
          onMouseUp={onFabMouseUp}
          onTouchStart={(e) => {
            const touch = e.touches[0];
            if (!touch) return;
            fabMouseDownPos.current = { x: touch.clientX, y: touch.clientY };
            handleDragStart(touch.clientX, touch.clientY);
          }}
          onTouchMove={(e) => {
            const touch = e.touches[0];
            if (!touch) return;
            e.preventDefault();
            handleDragMove(touch.clientX, touch.clientY);
          }}
          onTouchEnd={(e) => {
            const touch = e.changedTouches[0];
            if (!touch) return;
            const downPos = fabMouseDownPos.current;
            handleDragEnd(touch.clientX, touch.clientY);
            // Touch tap: same distance threshold as mouse
            if (!isExpanded && downPos) {
              const dx = touch.clientX - downPos.x;
              const dy = touch.clientY - downPos.y;
              if (Math.sqrt(dx * dx + dy * dy) < 5) {
                const panelPos = expandedPositionFromFab(position, fabWidth);
                setPosition(panelPos);
                setExpanded(true);
              }
            }
          }}
          aria-label={isExpanded ? 'Minimize softphone' : 'Open softphone'}
          aria-expanded={isExpanded}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: isExpanded ? '10px 14px' : '12px 18px',
            borderRadius: 28,
            background: fabBackground,
            border: isIncoming
              ? '1px solid rgba(34,197,94,0.40)'
              : '1px solid rgba(59,130,246,0.25)',
            color: hasActiveCall || isIncoming ? '#fff' : '#94a3b8',
            cursor: isDragging ? 'grabbing' : 'pointer',
            boxShadow: fabBoxShadow,
            transition: isDragging ? 'none' : 'box-shadow 0.2s, background 0.25s',
            userSelect: 'none',
            position: 'relative',
            // Apply ringing animations on the FAB when there's an incoming call
            animation: isIncoming
              ? 'softphone-pulse-fab 1.4s ease-in-out infinite, softphone-bounce 1.8s ease-in-out infinite'
              : undefined,
          }}
        >
          {/* Phone icon — ring animation on incoming call */}
          <span
            style={{
              display: 'flex',
              animation: isIncoming ? 'softphone-ring 1.6s ease-in-out infinite' : undefined,
            }}
          >
            <IconPhone />
          </span>

          {/* FAB label / caller info */}
          {!isExpanded && (
            <span style={{ fontSize: '0.8rem', fontWeight: 600, whiteSpace: 'nowrap' }}>
              {isIncoming
                ? (incomingCall.remoteName && incomingCall.remoteName !== incomingCall.remoteNumber
                    ? incomingCall.remoteName
                    : incomingCall.remoteNumber)
                : hasActiveCall
                ? 'Active Call'
                : 'Softphone'}
            </span>
          )}

          {/* Connection / call status dot */}
          <div
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: isIncoming ? '#22c55e' : connInfo.color,
              flexShrink: 0,
              boxShadow: `0 0 4px ${isIncoming ? '#22c55e' : connInfo.color}`,
              animation: isIncoming ? 'softphone-pulse-green 1.2s ease-in-out infinite' : undefined,
            }}
          />

          {/* Incoming call badge — visible when expanded (panel covers label) */}
          {isIncoming && isExpanded && (
            <span
              style={{
                position: 'absolute',
                top: -6,
                right: -6,
                minWidth: 18,
                height: 18,
                borderRadius: 9,
                background: '#22c55e',
                border: '2px solid #0f1420',
                color: '#fff',
                fontSize: '0.6rem',
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 4px',
                animation: 'softphone-pulse-green 1.2s ease-in-out infinite',
              }}
            >
              1
            </span>
          )}
        </button>
      </div>
    </>
  );
}
