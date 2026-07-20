/**
 * DemoBadge — the honest "DEMO" marker that appears on every payments surface so
 * no executive (or auditor) ever mistakes the simulation for live money. Small,
 * amber, glassy pill. Used inline in page heroes and on the add-card form.
 *
 * Exports ONLY components (react-refresh/only-export-components).
 */

import type { CSSProperties } from 'react';
import { GLASS, hexToRgba } from '../glass/glass';

interface DemoBadgeProps {
  /** Override the copy — defaults to "DEMO · No real money moves". */
  label?: string;
  /** `sm` for inline-with-title, `xs` for compact chips. */
  size?: 'xs' | 'sm';
  style?: CSSProperties;
}

export function DemoBadge({ label = 'Demo · No real money moves', size = 'sm', style }: DemoBadgeProps) {
  const amber = GLASS.warning;
  const small = size === 'xs';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: small ? 5 : 7,
        fontSize: small ? '0.58rem' : '0.64rem',
        fontWeight: 800,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: amber,
        background: hexToRgba(amber, 0.1),
        border: `1px solid ${hexToRgba(amber, 0.32)}`,
        borderRadius: 999,
        padding: small ? '3px 9px' : '5px 12px',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        whiteSpace: 'nowrap',
        boxShadow: `inset 0 1px 0 rgba(255,255,255,0.10), 0 0 18px -8px ${hexToRgba(amber, 0.6)}`,
        ...style,
      }}
    >
      <span
        aria-hidden
        style={{
          width: small ? 5 : 6,
          height: small ? 5 : 6,
          borderRadius: '50%',
          background: amber,
          boxShadow: `0 0 8px ${amber}`,
          flexShrink: 0,
        }}
      />
      {label}
    </span>
  );
}
