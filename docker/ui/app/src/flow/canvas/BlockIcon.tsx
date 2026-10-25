/**
 * BlockIcon — one glyph per IVR block, used on the canvas, the palette,
 * the outline and the inspector so a block reads the same everywhere.
 * Colour comes from the surrounding `--ivr-hue` (currentColor).
 */
import {
  AudioLines,
  CalendarClock,
  CornerUpLeft,
  Grid3x3,
  PhoneForwarded,
  PhoneIncoming,
  PhoneOff,
  UserRoundSearch,
  Voicemail,
  type LucideIcon,
} from 'lucide-react';
import type { IvrNodeType } from '../../types/ivr';

const ICONS: Readonly<Record<IvrNodeType, LucideIcon>> = {
  entry: PhoneIncoming,
  play: AudioLines,
  menu: Grid3x3,
  schedule: CalendarClock,
  condition: UserRoundSearch,
  dial: PhoneForwarded,
  voicemail: Voicemail,
  goto: CornerUpLeft,
  hangup: PhoneOff,
};

export function BlockIcon({ type, size = 16 }: { type: IvrNodeType; size?: number }) {
  const Icon = ICONS[type];
  return <Icon size={size} strokeWidth={2} aria-hidden="true" />;
}
