/**
 * LiveHero — the frosted page header for the live-ops pages: an accent eyebrow
 * badge, a gradient title, a muted subtitle, and an optional right-hand actions
 * slot (e.g. a live-poll indicator). Sits flush with the layout's top offset and
 * enforces one section-gap below itself, matching the app spacing standard.
 */

import type { ReactNode } from 'react';
import { GLASS } from '../../../components/glass/glass';
import { heroBadge, heroEyebrow, heroTitle, heroSubtitle, SECTION_GAP } from './styles';

interface LiveHeroProps {
  eyebrow: string;
  title: string;
  subtitle?: string;
  /** Right-aligned slot (live indicator, counts, etc.). */
  actions?: ReactNode;
  accent?: string;
}

export function LiveHero({ eyebrow, title, subtitle, actions, accent = GLASS.accent }: LiveHeroProps) {
  return (
    <header
      style={{
        marginBottom: SECTION_GAP,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: 20,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={heroBadge(accent)}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: accent, boxShadow: `0 0 8px ${accent}` }} />
          <span style={heroEyebrow(accent)}>{eyebrow}</span>
        </div>
        <h1 style={heroTitle(accent)}>{title}</h1>
        {subtitle && <p style={heroSubtitle}>{subtitle}</p>}
      </div>
      {actions && <div style={{ flexShrink: 0 }}>{actions}</div>}
    </header>
  );
}

/** A small pulsing "live" indicator with an optional label — for the hero slot. */
export function LivePulse({ label, color = GLASS.success }: { label: string; color?: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 14px',
        borderRadius: 999,
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.10)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        fontSize: '0.72rem',
        fontWeight: 700,
        color: GLASS.textMuted,
        letterSpacing: '0.04em',
      }}
    >
      <span
        className="glass-rise"
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
          boxShadow: `0 0 8px ${color}`,
          animation: 'glass-shimmer 1.6s ease-in-out infinite',
        }}
      />
      {label}
    </span>
  );
}
