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
        'relative flex items-center gap-3 px-3 py-3',
        'bg-[#13151d] border border-[rgba(42,47,69,0.6)] rounded-xl overflow-hidden',
        'cursor-grab select-none transition-all duration-150',
        'hover:border-[rgba(42,47,69,0.9)] hover:bg-[#1a1d27] hover:shadow-[0_2px_12px_rgba(0,0,0,0.3)]',
        isDragging && 'opacity-25 cursor-grabbing scale-95',
      )}
      {...listeners}
      {...attributes}
      aria-label={`Drag ${label} verb onto the canvas`}
    >
      {/* Accent left bar */}
      <div
        className="absolute left-0 inset-y-0 w-[3px] rounded-l-xl"
        style={{ backgroundColor: accentColor }}
        aria-hidden="true"
      />

      {/* Icon */}
      <div
        className={cn(
          'flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center',
          'text-sm font-bold ml-1',
          textClass,
        )}
        style={{ backgroundColor: `${accentColor}18`, border: `1px solid ${accentColor}30` }}
        aria-hidden="true"
      >
        {icon}
      </div>

      {/* Labels */}
      <div className="min-w-0">
        <div className={cn('text-xs font-bold tracking-wide', textClass)}>{label}</div>
        <div className="text-[0.68rem] text-[#4a5568] leading-tight truncate mt-0.5">{description}</div>
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
      className="flex flex-col overflow-y-auto"
      style={{
        width: '220px',
        flexShrink: 0,
        background: 'linear-gradient(180deg, #0f1117 0%, #0d0f15 100%)',
        borderRight: '1px solid rgba(42,47,69,0.6)',
      }}
      aria-label="IVR verb palette"
    >
      {/* Header */}
      <div
        className="px-4 pt-5 pb-3"
        style={{ borderBottom: '1px solid rgba(42,47,69,0.4)' }}
      >
        <div className="flex items-center gap-2">
          <div
            className="w-1.5 h-1.5 rounded-full"
            style={{ backgroundColor: '#06b6d4', boxShadow: '0 0 5px rgba(6,182,212,0.5)' }}
            aria-hidden="true"
          />
          <h2 className="text-[0.65rem] font-bold uppercase tracking-[1.2px] text-[#4a5568]">
            Verbs
          </h2>
        </div>
      </div>

      {/* Cards */}
      <div className="flex flex-col gap-2 px-3 py-3">
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
      <div className="mt-auto px-4 pb-5 pt-2">
        <p
          className="text-[0.65rem] leading-relaxed"
          style={{ color: 'rgba(74,85,104,0.7)' }}
        >
          Drag any verb onto the canvas to add it to the flow.
        </p>
      </div>
    </aside>
  );
}
