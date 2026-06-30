/**
 * RcfPageHeader — the hero header (badge + title + subtitle + at-a-glance stats)
 * rendered as a frosted glass panel from the kit. Purely presentational.
 */

import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../components/glass/glass';
import { BLUE, BLUE_LIGHT } from '../styles';

interface RcfPageHeaderProps {
  title: string;
  subtitle: string;
  totalNumbers: number;
  activeCount: number;
  disabledCount: number;
}

export function RcfPageHeader({ title, subtitle, totalNumbers, activeCount, disabledCount }: RcfPageHeaderProps) {
  const stats: { value: number; label: string; color: string }[] = [
    { value: totalNumbers, label: 'Total', color: BLUE_LIGHT },
    { value: activeCount, label: 'Active', color: BLUE },
    ...(disabledCount > 0 ? [{ value: disabledCount, label: 'Disabled', color: GLASS.danger }] : []),
  ];

  return (
    <GlassPanel padding="32px 36px 28px">
      {/* Subtle radial glow */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: -60,
          right: -60,
          width: 280,
          height: 280,
          background: `radial-gradient(circle, ${hexToRgba(BLUE, 0.07)} 0%, transparent 70%)`,
          pointerEvents: 'none',
        }}
      />

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 24 }}>
        {/* Shale logo */}
        <div style={{ flexShrink: 0 }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: `linear-gradient(135deg, ${hexToRgba(BLUE, 0.18)} 0%, ${hexToRgba(BLUE, 0.08)} 100%)`,
              border: `1px solid ${hexToRgba(BLUE, 0.28)}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: `0 0 24px ${hexToRgba(BLUE, 0.2)}`,
            }}
          >
            <img
              src="/shale_logo.png"
              alt="Shale"
              style={{ width: 36, height: 36, objectFit: 'contain', filter: `drop-shadow(0 0 8px ${hexToRgba(BLUE, 0.55)}) brightness(1.1)` }}
            />
          </div>
        </div>

        {/* Title + subtitle */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: BLUE, opacity: 0.85, marginBottom: 6 }}>
            Remote Call Forwarding
          </div>
          <h1 style={{ fontSize: 'clamp(1.2rem, 2.5vw, 1.55rem)', fontWeight: 800, color: GLASS.text, letterSpacing: '-0.025em', lineHeight: 1.15, margin: '0 0 8px', textShadow: '0 1px 12px rgba(0,0,0,0.5)' }}>
            {title}
          </h1>
          <p style={{ fontSize: '0.85rem', color: GLASS.textMuted, lineHeight: 1.65, margin: 0, maxWidth: 500 }}>
            {subtitle}
          </p>
        </div>

        {/* Stats */}
        {totalNumbers > 0 && (
          <div style={{ display: 'flex', gap: 12, flexShrink: 0, alignSelf: 'center' }}>
            {stats.map(({ value, label, color }) => (
              <div
                key={label}
                style={{
                  textAlign: 'center',
                  padding: '12px 16px',
                  background: 'rgba(15,17,23,0.45)',
                  border: '1px solid rgba(59,130,246,0.12)',
                  borderRadius: 12,
                  minWidth: 68,
                }}
              >
                <div style={{ fontSize: '1.6rem', fontWeight: 800, color, lineHeight: 1, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums', marginBottom: 4 }}>
                  {value}
                </div>
                <div style={{ fontSize: '0.62rem', fontWeight: 600, color: GLASS.textFaint, textTransform: 'uppercase', letterSpacing: '0.09em' }}>
                  {label}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </GlassPanel>
  );
}
