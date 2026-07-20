/**
 * Shared loading / error / empty presentational states for the billing admin
 * area, all rendered on frosted glass with the app blue accent. Driven purely
 * by props.
 */

import type { ReactNode } from 'react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../../components/glass/glass';

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <GlassPanel padding="40px 32px">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: '50%',
            border: `2.5px solid ${hexToRgba(GLASS.accent, 0.22)}`,
            borderTopColor: GLASS.accent,
            animation: 'glass-spin 0.7s linear infinite',
          }}
        />
        <span style={{ fontSize: '0.85rem', color: GLASS.textMuted }}>{label}</span>
      </div>
    </GlassPanel>
  );
}

export function InlineLoading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '20px 4px', color: GLASS.textMuted, fontSize: '0.85rem' }}>
      <span
        style={{
          width: 15,
          height: 15,
          borderRadius: '50%',
          border: `2px solid ${hexToRgba(GLASS.accent, 0.25)}`,
          borderTopColor: GLASS.accent,
          animation: 'glass-spin 0.7s linear infinite',
          display: 'inline-block',
        }}
      />
      {label}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <GlassPanel padding="20px 22px" accent={GLASS.danger}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span
          style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: hexToRgba(GLASS.danger, 0.12),
            border: `1px solid ${hexToRgba(GLASS.danger, 0.28)}`,
            color: GLASS.danger,
            fontWeight: 800,
          }}
        >
          !
        </span>
        <span style={{ fontSize: '0.875rem', color: '#fca5a5', fontWeight: 500 }}>{message}</span>
      </div>
    </GlassPanel>
  );
}

export function EmptyState({ title, body, icon }: { title: string; body?: string; icon?: ReactNode }) {
  return (
    <GlassPanel padding="44px 32px">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 10 }}>
        {icon && (
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 15,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: hexToRgba(GLASS.accent, 0.1),
              border: `1px solid ${hexToRgba(GLASS.accent, 0.22)}`,
              color: GLASS.accent,
            }}
          >
            {icon}
          </div>
        )}
        <div style={{ fontSize: '1rem', fontWeight: 700, color: GLASS.text }}>{title}</div>
        {body && <div style={{ fontSize: '0.85rem', color: GLASS.textMuted, maxWidth: 360, lineHeight: 1.5 }}>{body}</div>}
      </div>
    </GlassPanel>
  );
}
