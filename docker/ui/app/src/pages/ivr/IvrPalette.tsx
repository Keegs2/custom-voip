/**
 * IVR Builder — Verb Palette (Horizontal Toolbar)
 *
 * A horizontal strip of 6 draggable verb chips rendered above the canvas.
 * Users drag from here onto the canvas drop zones.
 * Uses @dnd-kit/core useDraggable.
 */

import { useDraggable } from '@dnd-kit/core';
import { verbIcon, verbColor } from './ivrUtils';
import type { IvrVerbType } from '../../types/ivr';

// ---------------------------------------------------------------------------
// Palette items configuration
// ---------------------------------------------------------------------------

const PALETTE_ITEMS: Array<{ verb: IvrVerbType; label: string }> = [
  { verb: 'say',    label: 'Say'    },
  { verb: 'play',   label: 'Play'   },
  { verb: 'gather', label: 'Gather' },
  { verb: 'dial',   label: 'Dial'   },
  { verb: 'hangup', label: 'Hangup' },
  { verb: 'pause',  label: 'Pause'  },
];

// ---------------------------------------------------------------------------
// Single draggable palette chip (compact horizontal variant)
// ---------------------------------------------------------------------------

interface PaletteChipProps {
  verb: IvrVerbType;
  label: string;
}

function PaletteChip({ verb, label }: PaletteChipProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette:${verb}`,
    data: { verb, type: 'palette' },
  });

  const accentColor = verbColor(verb);
  const icon = verbIcon(verb);

  return (
    <div
      ref={setNodeRef}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        border: `1px solid ${accentColor}40`,
        borderRadius: 6,
        overflow: 'hidden',
        cursor: isDragging ? 'grabbing' : 'grab',
        userSelect: 'none',
        transition: 'opacity 150ms, transform 150ms',
        background: `${accentColor}0d`,
        opacity: isDragging ? 0.25 : 1,
        transform: isDragging ? 'scale(0.95)' : 'scale(1)',
      }}
      {...listeners}
      {...attributes}
      aria-label={`Drag ${label} verb onto the canvas`}
      title={`Drag to add ${label} verb`}
    >
      {/* Icon badge */}
      <div
        style={{
          flexShrink: 0,
          width: 16,
          height: 16,
          borderRadius: 4,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '0.6rem',
          fontWeight: 700,
          backgroundColor: `${accentColor}18`,
          color: accentColor,
        }}
        aria-hidden="true"
      >
        {icon}
      </div>

      {/* Label */}
      <span
        style={{
          fontSize: '0.72rem',
          fontWeight: 600,
          letterSpacing: '0.03em',
          color: accentColor,
        }}
      >
        {label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Horizontal palette toolbar
// ---------------------------------------------------------------------------

export function IvrPalette() {
  return (
    <div
      role="toolbar"
      aria-label="IVR verb palette — drag verbs onto the canvas"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexWrap: 'wrap',
      }}
    >
      {/* Section label */}
      <span
        style={{
          fontSize: '0.65rem',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.10em',
          marginRight: 4,
          flexShrink: 0,
          color: '#334155',
        }}
        aria-hidden="true"
      >
        Verbs
      </span>

      {PALETTE_ITEMS.map(({ verb, label }) => (
        <PaletteChip key={verb} verb={verb} label={label} />
      ))}

      {/* Drag hint — hidden from assistive tech */}
      <span
        style={{
          marginLeft: 8,
          fontSize: '0.65rem',
          flexShrink: 0,
          color: '#1e293b',
        }}
        aria-hidden="true"
      >
        drag onto canvas
      </span>
    </div>
  );
}
