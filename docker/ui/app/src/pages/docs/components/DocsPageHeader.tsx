/**
 * Documentation page hero — a frosted glass panel with a badge (the Shale logo
 * by default, or a per-product icon when `icon` is supplied), eyebrow, title,
 * and subtitle. Built on <GlassPanel> so it sits on the app-wide ambient
 * backdrop with the rest of the glass kit.
 *
 * Spacing: NO top margin (the AppLayout owns the top offset); a single
 * section-gap (32px) below pushes the first content block down uniformly.
 */

import type { ReactNode } from 'react';
import { GlassPanel } from '../../../components/glass/GlassCard';
import { hexToRgba } from '../../../components/glass/glass';
import {
  DOCS,
  pageHeaderWrap,
  headerLogoBadge,
  headerEyebrow,
  headerTitle,
  headerSubtitle,
} from '../styles';

interface DocsPageHeaderProps {
  /** Eyebrow text above the title. */
  eyebrow: string;
  title: string;
  subtitle: string;
  /** Accent colour drives the badge glow + top accent rule. */
  accent?: string;
  /**
   * Optional badge icon element. When provided (e.g. a product's own lucide
   * icon), it replaces the default Shale logo — giving each product guide a
   * distinctive, accent-tinted header while the docs hub keeps the Shale mark.
   */
  icon?: ReactNode;
}

export function DocsPageHeader({ eyebrow, title, subtitle, accent = DOCS.accent, icon }: DocsPageHeaderProps) {
  return (
    <div className="glass-rise" style={{ ...pageHeaderWrap, animation: 'glass-rise 0.5s cubic-bezier(0.2,0.7,0.3,1) both' }}>
      <GlassPanel accent={accent} radius={20} padding="30px 34px 26px">
        {/* Top accent rule */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: 0,
            left: 46,
            right: 46,
            height: 2,
            background: `linear-gradient(90deg, transparent, ${hexToRgba(accent, 0.7)}, transparent)`,
            borderRadius: '0 0 2px 2px',
          }}
        />
        {/* Radial accent glow */}
        <div
          aria-hidden
          style={{
            position: 'absolute',
            top: -60,
            right: -60,
            width: 280,
            height: 280,
            background: `radial-gradient(circle, ${hexToRgba(accent, 0.12)} 0%, transparent 70%)`,
            pointerEvents: 'none',
          }}
        />

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 22, position: 'relative' }}>
          <div style={headerLogoBadge(accent)}>
            {icon ? (
              <span style={{ color: accent, display: 'flex', filter: `drop-shadow(0 0 8px ${hexToRgba(accent, 0.5)})` }}>
                {icon}
              </span>
            ) : (
              <img
                src="/shale_logo.png"
                alt="Shale"
                style={{
                  width: 36,
                  height: 36,
                  objectFit: 'contain',
                  filter: `drop-shadow(0 0 8px ${hexToRgba(accent, 0.55)}) brightness(1.1)`,
                }}
              />
            )}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={headerEyebrow(accent)}>{eyebrow}</div>
            <h1 style={headerTitle}>{title}</h1>
            <p style={headerSubtitle}>{subtitle}</p>
          </div>
        </div>
      </GlassPanel>
    </div>
  );
}
