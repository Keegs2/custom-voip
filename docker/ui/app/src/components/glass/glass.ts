/**
 * Liquid-glass design tokens — the CANONICAL, app-wide glass design system.
 *
 * This is the single source of truth for every frosted-glass surface in the
 * SPA. It reuses the existing app palette (see UI CLAUDE.md §15) rather than
 * inventing a new scheme, and leads with the APP BLUE accent (#3b82f6) with
 * cyan (#22d3ee) as the secondary glow.
 *
 * Theming model
 * -------------
 *  - `GLASS.accent` (blue) is the default for every primitive.
 *  - Every glass primitive (GlassPanel/GlassCard/GlassChip/GlassSheen/
 *    GlassBackground) accepts an optional `accent` prop so a single page could
 *    override the local hue without forking the kit. Pass `GLASS.green` (the
 *    legacy RCF hue) or any hex.
 *
 * Keep this module free of page-specific code so it stays portable.
 */

export const GLASS = {
  // ── Base page background (matches AppLayout / palette §15) ────────────────
  bg: '#0f1117',

  // ── Accents ──────────────────────────────────────────────────────────────
  /** Canonical app accent — APP BLUE. The default for every glass primitive. */
  accent: '#3b82f6',
  /** Secondary glow — cyan. Pairs with the accent in glows + the backdrop. */
  accentSecondary: '#22d3ee',

  // Named palette entries (available for local `accent` overrides) ───────────
  blue: '#3b82f6',
  cyan: '#22d3ee',
  green: '#4ade80', // legacy RCF accent — kept for opt-in overrides
  success: '#22c55e',
  warning: '#f59e0b',
  danger: '#ef4444',

  // ── Text ─────────────────────────────────────────────────────────────────
  text: '#e2e8f0',
  textMuted: '#94a3b8',
  textFaint: '#475569',
  // NOTE: deliberately NOT `as const` — tokens must be typed `string` so helper
  // params that default to e.g. `GLASS.accent` infer `string` (not the literal
  // '#3b82f6'), letting any accent flow through. Keys are still type-checked.
};

/**
 * Options for {@link glassSurface}. The frosted-surface fill + sheen are
 * centralised here so every glass element refracts light the same way.
 */
export interface GlassSurfaceOptions {
  /** Accent colour for the hover glow + active border. Defaults to app blue. */
  accent?: string;
  /** Whether the surface lifts + glows on hover. */
  interactive?: boolean;
  /** Hover state, owned by the calling component (kept controlled for #310). */
  hovered?: boolean;
  /** Corner radius. */
  radius?: number;
  /** backdrop blur strength in px (kept moderate for GPU cost). */
  blur?: number;
}

/**
 * The shared frosted-glass surface: translucent fill, 1px translucent border,
 * `backdrop-filter` blur+saturate, an inset top specular line, a layered drop
 * shadow, and (when interactive) a hover lift + accent glow.
 */
export function glassSurface(opts: GlassSurfaceOptions = {}): React.CSSProperties {
  const { accent = GLASS.accent, interactive = false, hovered = false, radius = 20, blur = 18 } = opts;
  const lifted = interactive && hovered;
  return {
    position: 'relative',
    borderRadius: radius,
    background:
      'linear-gradient(160deg, rgba(255,255,255,0.055) 0%, rgba(255,255,255,0.02) 55%, rgba(255,255,255,0.012) 100%)',
    backdropFilter: `blur(${blur}px) saturate(160%)`,
    WebkitBackdropFilter: `blur(${blur}px) saturate(160%)`,
    border: `1px solid ${lifted ? hexToRgba(accent, 0.34) : 'rgba(255,255,255,0.10)'}`,
    boxShadow: lifted
      ? `0 24px 60px -18px rgba(0,0,0,0.66), 0 0 44px -10px ${hexToRgba(accent, 0.33)}, inset 0 1px 0 rgba(255,255,255,0.16), inset 0 0 0 1px rgba(255,255,255,0.03)`
      : '0 14px 40px -18px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.10)',
    transform: lifted ? 'translateY(-3px)' : 'translateY(0)',
    transition: 'transform 0.32s cubic-bezier(0.2,0.7,0.3,1), box-shadow 0.32s ease, border-color 0.32s ease',
    overflow: 'hidden',
  };
}

/** Small helper — expand a #rrggbb hex into an rgba() string. */
export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
