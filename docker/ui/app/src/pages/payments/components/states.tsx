/**
 * Shared loading / error states for the customer Payments page, on frosted glass.
 * Exports ONLY components (react-refresh/only-export-components).
 */

import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../components/glass/glass';

export function PageLoading({ label = 'Loading your billing…' }: { label?: string }) {
  return (
    <GlassPanel padding="52px 32px">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
        <span
          style={{
            width: 30,
            height: 30,
            borderRadius: '50%',
            border: `3px solid ${hexToRgba(GLASS.accent, 0.22)}`,
            borderTopColor: GLASS.accent,
            animation: 'glass-spin 0.7s linear infinite',
          }}
        />
        <span style={{ fontSize: '0.9rem', color: GLASS.textMuted }}>{label}</span>
      </div>
    </GlassPanel>
  );
}

export function PageError({ message }: { message: string }) {
  return (
    <GlassPanel padding="24px 26px" accent={GLASS.danger}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span
          style={{
            width: 38,
            height: 38,
            borderRadius: 11,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: hexToRgba(GLASS.danger, 0.12),
            border: `1px solid ${hexToRgba(GLASS.danger, 0.28)}`,
            color: GLASS.danger,
            fontWeight: 800,
            fontSize: '1.1rem',
          }}
        >
          !
        </span>
        <div>
          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#fca5a5' }}>Couldn&rsquo;t load billing</div>
          <div style={{ fontSize: '0.82rem', color: GLASS.textMuted, marginTop: 2 }}>{message}</div>
        </div>
      </div>
    </GlassPanel>
  );
}
