import { useMemo } from 'react';

/**
 * AnimatedGridBackground — Keystone edition
 *
 * Animated grid background adapted from Zentra's component with these changes:
 * - All orange colors replaced with blue (#3b82f6, #60a5fa)
 * - Collector icon, glow rings, and showCollector prop removed entirely
 * - Center vertical guideline removed
 * - Dots flow from edges inward and fade out at ~60% of viewport width
 *   (no vertical drop phase, no collector convergence)
 * - Simplified keyframe: spawn at edge (opacity 0), fade in at 10%,
 *   travel inward, fade out at 100%
 * - Grid opacity default 0.06 (subtler)
 * - Grid line color: rgba(99, 130, 180, opacity) — blue-tinted
 * - Vignette uses Keystone's #0f1117 background color
 */

interface EnergyDot {
  id: number;
  side: 'left' | 'right';
  /** Vertical position as percentage of viewport height (5–80%) */
  rowPercent: number;
  delay: number;
  duration: number;
  size: 'sm' | 'md';
}

export interface AnimatedGridBackgroundProps {
  gridSize?: number;
  dotsPerSide?: number;
  gridOpacity?: number;
  showGlow?: boolean;
}

export function AnimatedGridBackground({
  gridSize = 56,
  dotsPerSide = 8,
  gridOpacity = 0.06,
  showGlow = true,
}: AnimatedGridBackgroundProps) {
  // Stable component-scoped ID for CSS keyframe names.
  // We avoid useId() because it produces colons (":r0:") which are
  // invalid in CSS @keyframes identifiers.
  const componentId = useMemo(
    () => `ks-grid-${Math.random().toString(36).substring(2, 9)}`,
    [],
  );

  // Generate a stable set of dots for both sides.
  const energyDots = useMemo<EnergyDot[]>(() => {
    const dots: EnergyDot[] = [];

    for (let i = 0; i < dotsPerSide; i++) {
      dots.push({
        id: i,
        side: 'left',
        rowPercent: 5 + Math.random() * 75, // 5–80% from top
        delay: Math.random() * 12,
        duration: 7 + Math.random() * 7,    // 7–14s total
        size: Math.random() > 0.65 ? 'md' : 'sm',
      });
    }

    for (let i = 0; i < dotsPerSide; i++) {
      dots.push({
        id: dotsPerSide + i,
        side: 'right',
        rowPercent: 5 + Math.random() * 75,
        delay: Math.random() * 12,
        duration: 7 + Math.random() * 7,
        size: Math.random() > 0.65 ? 'md' : 'sm',
      });
    }

    return dots;
  }, [dotsPerSide]);

  // Build per-dot keyframes. Each dot:
  //   - Spawns at the edge (opacity 0)
  //   - Fades in by 10%
  //   - Travels inward to ~60% of viewport width
  //   - Fades out completely by 100%
  // No vertical movement — purely horizontal inward travel.
  const keyframesCSS = useMemo(() => {
    return energyDots
      .map((dot) => {
        const startX =
          dot.side === 'left' ? '-12px' : 'calc(100vw + 12px)';
        // Travel to ~60% of the way across from the originating edge
        const endX =
          dot.side === 'left'
            ? 'calc(60vw)'
            : 'calc(40vw)';
        const y = `${dot.rowPercent}vh`;

        return `
@keyframes energy-flow-${componentId}-${dot.id} {
  0%   { left: ${startX}; top: ${y}; opacity: 0; }
  10%  { opacity: 1; }
  100% { left: ${endX};   top: ${y}; opacity: 0; }
}`;
      })
      .join('\n');
  }, [energyDots, componentId]);

  return (
    <div
      className="fixed inset-0 overflow-hidden pointer-events-none z-0"
      aria-hidden="true"
    >
      {/* Inject per-dot keyframes */}
      <style dangerouslySetInnerHTML={{ __html: keyframesCSS }} />

      {/* Optional radial blue glow centred in the upper half */}
      {showGlow && (
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(circle at 50% 35%, rgba(59, 130, 246, 0.09) 0%, transparent 55%)',
          }}
        />
      )}

      {/* Blue-tinted grid */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `
            linear-gradient(to right,  rgba(99, 130, 180, ${gridOpacity}) 1px, transparent 1px),
            linear-gradient(to bottom, rgba(99, 130, 180, ${gridOpacity}) 1px, transparent 1px)
          `,
          backgroundSize: `${gridSize}px ${gridSize}px`,
        }}
      />

      {/* Animated dots — fixed so they don't scroll with the page */}
      <div className="fixed inset-0 pointer-events-none">
        {energyDots.map((dot) => (
          <EnergyDotElement key={dot.id} dot={dot} componentId={componentId} />
        ))}
      </div>

      {/* Vignette: pulls focus toward the centre and hides the hard grid edges */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse at 50% 50%, transparent 30%, rgba(15, 17, 23, 0.55) 100%)',
        }}
      />
    </div>
  );
}

/* ─── Individual animated dot ─────────────────────────── */

function EnergyDotElement({
  dot,
  componentId,
}: {
  dot: EnergyDot;
  componentId: string;
}) {
  const lightSize = dot.size === 'md' ? 5 : 3;
  const glowSize  = dot.size === 'md' ? 14 : 9;

  return (
    <div
      className="fixed"
      style={{
        animationName: `energy-flow-${componentId}-${dot.id}`,
        animationDuration: `${dot.duration}s`,
        animationDelay: `${dot.delay}s`,
        animationTimingFunction: 'ease-in-out',
        animationIterationCount: 'infinite',
        animationFillMode: 'both',
      }}
    >
      {/* Blue light core */}
      <div
        className="rounded-full"
        style={{
          width: lightSize,
          height: lightSize,
          background: 'linear-gradient(135deg, #3b82f6 0%, #60a5fa 100%)',
          boxShadow: `
            0 0 ${glowSize}px rgba(59, 130, 246, 0.85),
            0 0 ${glowSize * 2}px rgba(59, 130, 246, 0.40),
            0 0 ${glowSize * 3}px rgba(96, 165, 250, 0.18)
          `,
        }}
      />
    </div>
  );
}

export default AnimatedGridBackground;
