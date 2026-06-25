/**
 * GlassBackground — the ambient, slowly-drifting colour field that sells the
 * "liquid glass" aesthetic, themed in the APP BLUE.
 *
 * This is mounted ONCE, app-wide, by AppLayout (behind the centered content and
 * behind the Sidebar). Every routed page therefore sits on the same liquid-glass
 * backdrop; glass surfaces above it pick the colours up through their
 * `backdrop-filter`, and opaque legacy surfaces still read fine because the base
 * is dark (#0f1117) and the blobs are low-opacity.
 *
 * Technique:
 *  - A few large radial-gradient "blobs" (blue + cyan) at low opacity, each
 *    heavily blurred (`filter: blur()`), drifting via slow CSS keyframe
 *    `transform` animations (GPU-only — translate + scale, never layout props).
 *  - Different durations/delays per blob → an organic, non-repeating feel.
 *  - A vignette + faint top sheen keep text legible over the colour.
 *  - `prefers-reduced-motion` freezes all drift.
 *
 * It also hosts the design system's shared keyframes (drift / shimmer / rise /
 * spin) so the skeleton shimmer, card entrance, and spinner animations work for
 * ANY page while this is mounted. The class prefix is the generic `glass-`.
 */

import { GLASS, hexToRgba } from './glass';

/** Shared keyframes for the whole glass design system (prefixed `glass-`). */
const KEYFRAMES = `
@keyframes glass-drift-a {
  0%   { transform: translate(0, 0) scale(1); }
  33%  { transform: translate(7vw, 5vh) scale(1.14); }
  66%  { transform: translate(-5vw, 9vh) scale(0.92); }
  100% { transform: translate(0, 0) scale(1); }
}
@keyframes glass-drift-b {
  0%   { transform: translate(0, 0) scale(1); }
  40%  { transform: translate(-8vw, -6vh) scale(1.08); }
  75%  { transform: translate(5vw, 4vh) scale(0.96); }
  100% { transform: translate(0, 0) scale(1); }
}
@keyframes glass-drift-c {
  0%   { transform: translate(0, 0) scale(1.04); }
  50%  { transform: translate(6vw, -7vh) scale(0.9); }
  100% { transform: translate(0, 0) scale(1.04); }
}
@keyframes glass-shimmer {
  0%   { background-position: -180% 0; }
  100% { background-position: 180% 0; }
}
@keyframes glass-rise {
  from { opacity: 0; transform: translateY(14px) scale(0.985); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes glass-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .glass-blob { animation: none !important; }
  .glass-rise { animation: none !important; opacity: 1 !important; transform: none !important; }
  .glass-shimmer { animation: none !important; }
}
`;

interface BlobSpec {
  /** 'accent' | 'secondary' chooses which prop colour the blob uses. */
  tone: 'accent' | 'secondary';
  size: string;
  top?: string;
  left?: string;
  right?: string;
  bottom?: string;
  opacity: number;
  blur: number;
  anim: string;
}

/**
 * Blob layout. Kept to four blobs for GPU cost; opacities are deliberately low
 * so the field stays subtle behind opaque, not-yet-glassified pages.
 */
const BLOBS: BlobSpec[] = [
  { tone: 'accent',    size: '52vw', top: '-12%', left: '-8%',  opacity: 0.18, blur: 70, anim: 'glass-drift-a 30s ease-in-out infinite' },
  { tone: 'secondary', size: '46vw', top: '18%',  right: '-10%', opacity: 0.15, blur: 80, anim: 'glass-drift-b 38s ease-in-out infinite' },
  { tone: 'accent',    size: '40vw', bottom: '-14%', left: '22%', opacity: 0.13, blur: 90, anim: 'glass-drift-c 34s ease-in-out infinite' },
  { tone: 'secondary', size: '30vw', bottom: '6%', right: '14%', opacity: 0.09, blur: 80, anim: 'glass-drift-b 44s ease-in-out infinite 4s' },
];

export interface GlassBackgroundProps {
  /** Primary blob colour. Defaults to the app blue. */
  accent?: string;
  /** Secondary blob colour. Defaults to cyan. */
  secondary?: string;
}

export function GlassBackground({ accent = GLASS.accent, secondary = GLASS.accentSecondary }: GlassBackgroundProps = {}) {
  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
        background: GLASS.bg,
      }}
    >
      <style>{KEYFRAMES}</style>

      {BLOBS.map((b, i) => {
        const color = b.tone === 'accent' ? accent : secondary;
        return (
          <div
            key={i}
            className="glass-blob"
            style={{
              position: 'absolute',
              top: b.top,
              left: b.left,
              right: b.right,
              bottom: b.bottom,
              width: b.size,
              height: b.size,
              borderRadius: '50%',
              background: `radial-gradient(circle at 50% 50%, ${hexToRgba(color, b.opacity)} 0%, ${hexToRgba(color, 0)} 70%)`,
              filter: `blur(${b.blur}px)`,
              willChange: 'transform',
              animation: b.anim,
            }}
          />
        );
      })}

      {/* Faint top sheen for texture + a vignette so text stays legible. */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'radial-gradient(120% 90% at 50% -10%, rgba(255,255,255,0.035) 0%, transparent 45%), radial-gradient(120% 120% at 50% 120%, rgba(0,0,0,0.45) 0%, transparent 55%)',
        }}
      />
    </div>
  );
}
