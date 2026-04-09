/**
 * IVR Builder — Verb Palette
 *
 * Left sidebar with 6 draggable verb cards. Users drag from here onto the canvas.
 * Uses @dnd-kit/core useDraggable.
 */

import { useDraggable } from '@dnd-kit/core';
import { cn } from '../../utils/cn';
import { verbIcon, verbColor, verbTextClass } from './ivrUtils';
import type { IvrVerbType } from '../../types/ivr';

// ---------------------------------------------------------------------------
// Palette items configuration
// ---------------------------------------------------------------------------

const PALETTE_ITEMS: Array<{ verb: IvrVerbType; label: string; description: string }> = [
  { verb: 'say',    label: 'Say',    description: 'Speak text to the caller' },
  { verb: 'play',   label: 'Play',   description: 'Play an audio file URL' },
  { verb: 'gather', label: 'Gather', description: 'Collect digit input' },
  { verb: 'dial',   label: 'Dial',   description: 'Forward to a phone number' },
  { verb: 'hangup', label: 'Hangup', description: 'End the call' },
  { verb: 'pause',  label: 'Pause',  description: 'Wait for a set duration' },
];

// ---------------------------------------------------------------------------
// Single draggable palette card
// ---------------------------------------------------------------------------

interface PaletteCardProps {
  verb: IvrVerbType;
  label: string;
  description: string;
}

function PaletteCard({ verb, label, description }: PaletteCardProps) {
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
        'relative flex items-center gap-2.5 px-3 py-2.5',
        'bg-[#1a1d27] border border-[#2a2f45] rounded-lg overflow-hidden',
        'cursor-grab select-none transition-all duration-100',
        'hover:border-[#3d4460] hover:bg-[#1e2130]',
        isDragging && 'opacity-30 cursor-grabbing',
      )}
      {...listeners}
      {...attributes}
      aria-label={`Drag ${label} verb onto the canvas`}
    >
      {/* Accent left bar */}
      <div
        className="absolute left-0 inset-y-0 w-[3px]"
        style={{ backgroundColor: accentColor }}
        aria-hidden="true"
      />

      {/* Icon */}
      <div
        className={cn(
          'flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center',
          'text-sm font-bold ml-1',
          textClass,
        )}
        style={{ backgroundColor: `${accentColor}22` }}
        aria-hidden="true"
      >
        {icon}
      </div>

      {/* Labels */}
      <div className="min-w-0">
        <div className={cn('text-xs font-bold', textClass)}>{label}</div>
        <div className="text-[0.68rem] text-[#4a5568] leading-tight truncate">{description}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Palette panel
// ---------------------------------------------------------------------------

export function IvrPalette() {
  return (
    <aside
      className="flex flex-col bg-[#0d0f15] border-r border-[#2a2f45] overflow-y-auto"
      style={{ width: '200px', flexShrink: 0 }}
      aria-label="IVR verb palette"
    >
      {/* Header */}
      <div className="px-3 pt-3 pb-2">
        <h2 className="text-[0.68rem] font-bold uppercase tracking-[0.8px] text-[#4a5568]">
          Verbs
        </h2>
      </div>

      {/* Cards */}
      <div className="flex flex-col gap-1.5 px-2 pb-4">
        {PALETTE_ITEMS.map(({ verb, label, description }) => (
          <PaletteCard
            key={verb}
            verb={verb}
            label={label}
            description={description}
          />
        ))}
      </div>

      {/* Usage hint */}
      <div className="mt-auto px-3 pb-4">
        <p className="text-[0.65rem] text-[#3d4460] leading-relaxed">
          Drag any verb onto the canvas to add it to the flow.
        </p>
      </div>
    </aside>
  );
}
