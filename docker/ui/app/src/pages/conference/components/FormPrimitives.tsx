/**
 * Shared form UI primitives for the conference modals + settings tab. Frosted
 * to match the glass kit. This module exports only components (fast-refresh safe).
 */

import type { ReactNode } from 'react';
import { GLASS, hexToRgba } from '../../../components/glass/glass';

export function FormField({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label
        style={{
          fontSize: '0.75rem',
          fontWeight: 600,
          color: GLASS.textMuted,
          letterSpacing: '0.02em',
        }}
      >
        {label}
        {required && <span style={{ color: GLASS.danger, marginLeft: 2 }}>*</span>}
      </label>
      {children}
    </div>
  );
}

export function ToggleField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '9px 13px',
        borderRadius: 10,
        background: value ? hexToRgba(GLASS.accent, 0.1) : 'rgba(255,255,255,0.03)',
        border: `1px solid ${value ? hexToRgba(GLASS.accent, 0.28) : 'rgba(255,255,255,0.08)'}`,
        cursor: 'pointer',
        userSelect: 'none',
        transition: 'all 0.15s',
      }}
      onClick={() => onChange(!value)}
    >
      <div
        style={{
          width: 28,
          height: 16,
          borderRadius: 8,
          background: value ? GLASS.accent : 'rgba(255,255,255,0.14)',
          position: 'relative',
          transition: 'background 0.2s',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 2,
            left: value ? 14 : 2,
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: '#fff',
            transition: 'left 0.2s',
            boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
          }}
        />
      </div>
      <span style={{ fontSize: '0.78rem', fontWeight: 600, color: value ? '#93c5fd' : GLASS.textMuted }}>
        {label}
      </span>
    </div>
  );
}
