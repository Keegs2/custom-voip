/**
 * IVR Builder — Verb Palette (Horizontal Toolbar)
 *
 * A horizontal strip of 6 draggable verb chips rendered above the canvas.
 * Users drag from here onto the canvas drop zones.
 * Uses @dnd-kit/core useDraggable.
 */

import { useDraggable } from '@dnd-kit/core';
import { cn } from '../../utils/cn';
import { verbIcon, verbColor, verbTextClass } from './ivrUtils';
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
  const textClass = verbTextClass(verb);
  const icon = verbIcon(verb);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'relative flex items-center gap-1.5 px-2.5 py-1.5',
        'border rounded-lg overflow-hidden',
        'cursor-grab select-none transition-all duration-150',
        'hover:bg-[rgba(255,255,255,0.05)]',
        isDragging && 'opacity-25 cursor-grabbing scale-95',
      )}
      style={{
        background: `${accentColor}0d`,
        borderColor: `${accentColor}28`,
      }}
      {...listeners}
      {...attributes}
      aria-label={`Drag ${label} verb onto the canvas`}
      title={`Drag to add ${label} verb`}
    >
      {/* Icon badge */}
      <div
        className={cn('flex-shrink-0 w-5 h-5 rounded flex items-center justify-center text-[0.65rem] font-bold', textClass)}
        style={{ backgroundColor: `${accentColor}18` }}
        aria-hidden="true"
      >
        {icon}
      </div>

      {/* Label */}
      <span className={cn('text-[0.72rem] font-semibold tracking-wide', textClass)}>
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
      className="flex items-center gap-1.5 flex-wrap"
    >
      {/* Section label */}
      <span
        className="text-[0.6rem] font-bold uppercase tracking-[0.12em] mr-1 flex-shrink-0"
        style={{ color: '#334155' }}
        aria-hidden="true"
      >
        Verbs
      </span>

      {PALETTE_ITEMS.map(({ verb, label }) => (
        <PaletteChip key={verb} verb={verb} label={label} />
      ))}

      {/* Drag hint — hidden from assistive tech, visible on wider screens */}
      <span
        className="ml-2 text-[0.65rem] hidden sm:inline"
        style={{ color: 'rgba(74,85,104,0.55)' }}
        aria-hidden="true"
      >
        drag onto canvas
      </span>
    </div>
  );
}
