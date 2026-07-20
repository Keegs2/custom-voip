/**
 * ScenarioCard — a big, room-legible button a presenter clicks to fire one demo
 * scenario (seed / call-drain / agent-usage / decline / reset). Each carries an
 * icon, a title, a one-line "what you'll see" caption, an accent, and a busy /
 * just-ran state. Designed so an exec across the room reads the action instantly.
 *
 * Presentational: the click + busy state come from the parent.
 */

import type { ReactNode } from 'react';
import { glassSurface, hexToRgba, GLASS } from '../../../../components/glass/glass';
import { GlassSheen } from '../../../../components/glass/GlassCard';
import { useState } from 'react';

interface ScenarioCardProps {
  title: string;
  caption: string;
  icon: ReactNode;
  accent: string;
  running: boolean;
  disabled: boolean;
  justRan: boolean;
  onClick: () => void;
}

export function ScenarioCard({ title, caption, icon, accent, running, disabled, justRan, onClick }: ScenarioCardProps) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...glassSurface({ interactive: true, hovered: hovered && !disabled, accent, radius: 18 }),
        textAlign: 'left',
        padding: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: 'inherit',
        opacity: disabled && !running ? 0.55 : 1,
      }}
    >
      <GlassSheen accent={accent} />
      <div style={{ position: 'relative', zIndex: 1, padding: '20px 22px', minHeight: 148, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span
            style={{
              width: 46,
              height: 46,
              borderRadius: 13,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: hexToRgba(accent, 0.14),
              border: `1px solid ${hexToRgba(accent, 0.32)}`,
              color: accent,
            }}
          >
            {icon}
          </span>
          {running ? (
            <span
              aria-label="running"
              style={{
                width: 18,
                height: 18,
                borderRadius: '50%',
                border: `2.5px solid ${hexToRgba(accent, 0.25)}`,
                borderTopColor: accent,
                animation: 'glass-spin 0.7s linear infinite',
              }}
            />
          ) : justRan ? (
            <span
              style={{
                fontSize: '0.56rem',
                fontWeight: 800,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: GLASS.success,
                background: hexToRgba(GLASS.success, 0.12),
                border: `1px solid ${hexToRgba(GLASS.success, 0.3)}`,
                borderRadius: 999,
                padding: '3px 9px',
              }}
            >
              Ran
            </span>
          ) : null}
        </div>

        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: '1.05rem', fontWeight: 800, color: GLASS.text, letterSpacing: '-0.01em' }}>{title}</div>
          <div style={{ fontSize: '0.78rem', color: GLASS.textMuted, marginTop: 5, lineHeight: 1.45 }}>{caption}</div>
        </div>
      </div>
    </button>
  );
}
