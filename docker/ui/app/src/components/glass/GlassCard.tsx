/**
 * Reusable frosted-glass surfaces — the canonical, app-wide glass primitives.
 *
 *  - <GlassPanel>  : a static frosted panel (controls bar, table, states).
 *  - <GlassCard>   : an interactive panel that lifts + glows on hover, with a
 *                    staggered entrance animation.
 *  - <GlassChip>   : a little glass status pill.
 *  - <GlassSheen>  : the top-edge specular highlight overlay (light refracting
 *                    through the glass). Rendered inside panels/cards.
 *
 * Theming: every primitive takes an optional `accent` prop (default app blue,
 * `GLASS.accent`). The drift/rise/shimmer keyframes these rely on are injected
 * once by <GlassBackground> (mounted app-wide in AppLayout).
 *
 * All hooks live at the very top of each component (React #310 discipline).
 */

import { useState, type CSSProperties, type ReactNode } from 'react';
import { glassSurface, hexToRgba, GLASS } from './glass';

// ── GlassSheen ─────────────────────────────────────────────────────────────
// The specular sheen: a soft top gradient + a thin bright edge line. The edge
// line is white by default; pass `accent` to tint it faintly toward the hue.

export function GlassSheen({ accent }: { accent?: string }) {
  const edge = accent ? hexToRgba(accent, 0.5) : 'rgba(255,255,255,0.55)';
  return (
    <>
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: '46%',
          background: 'linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0) 100%)',
          pointerEvents: 'none',
        }}
      />
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: 0,
          left: '8%',
          right: '8%',
          height: 1,
          background: `linear-gradient(90deg, transparent, ${edge}, transparent)`,
          opacity: 0.45,
          pointerEvents: 'none',
        }}
      />
    </>
  );
}

// ── GlassPanel ─────────────────────────────────────────────────────────────

interface GlassPanelProps {
  children: ReactNode;
  style?: CSSProperties;
  radius?: number;
  blur?: number;
  padding?: number | string;
  /** Accent hue for the border/edge. Defaults to app blue. */
  accent?: string;
}

export function GlassPanel({ children, style, radius = 20, blur = 18, padding, accent = GLASS.accent }: GlassPanelProps) {
  return (
    <div style={{ ...glassSurface({ radius, blur, accent }), ...style }}>
      <GlassSheen accent={accent} />
      <div style={{ position: 'relative', zIndex: 1, padding }}>{children}</div>
    </div>
  );
}

// ── GlassCard ──────────────────────────────────────────────────────────────

interface GlassCardProps {
  children: ReactNode;
  style?: CSSProperties;
  /** Accent hue for the hover glow + corner light. Defaults to app blue. */
  accent?: string;
  /** Entrance stagger index — drives animation-delay. */
  index?: number;
  radius?: number;
  blur?: number;
}

export function GlassCard({ children, style, accent = GLASS.accent, index = 0, radius = 22, blur = 18 }: GlassCardProps) {
  // ALL hooks unconditionally at the top (React #310 discipline)
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="glass-rise"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...glassSurface({ interactive: true, hovered, accent, radius, blur }),
        animation: 'glass-rise 0.55s cubic-bezier(0.2,0.7,0.3,1) both',
        animationDelay: `${Math.min(index, 12) * 45}ms`,
        ...style,
      }}
    >
      <GlassSheen accent={accent} />
      {/* Corner accent glow that warms on hover */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: -40,
          left: -40,
          width: 180,
          height: 180,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${hexToRgba(accent, hovered ? 0.16 : 0.07)} 0%, transparent 70%)`,
          transition: 'background 0.4s ease',
          pointerEvents: 'none',
        }}
      />
      <div style={{ position: 'relative', zIndex: 1 }}>{children}</div>
    </div>
  );
}

// ── GlassChip ──────────────────────────────────────────────────────────────

interface GlassChipProps {
  label: string;
  /** The chip's own colour (status semantic). Defaults to muted text. */
  color?: string;
  icon?: ReactNode;
  /** Show a glowing status dot. */
  dot?: boolean;
  style?: CSSProperties;
}

export function GlassChip({ label, color = GLASS.textMuted, icon, dot, style }: GlassChipProps) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: '0.62rem',
        fontWeight: 700,
        color,
        background: hexToRgba(color, 0.1),
        border: `1px solid ${hexToRgba(color, 0.28)}`,
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        borderRadius: 999,
        padding: '4px 10px',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.10)',
        ...style,
      }}
    >
      {dot && (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: color,
            boxShadow: `0 0 6px ${color}`,
            flexShrink: 0,
          }}
        />
      )}
      {icon}
      {label}
    </span>
  );
}
