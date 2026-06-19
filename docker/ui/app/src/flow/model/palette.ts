/**
 * Per-product palette + presentation metadata for the builder.
 *
 * `NODE_META` gives each telephony node a stable accent colour, a short glyph
 * (rendered in the node header + palette), and a one-line blurb. `IVR_PALETTE`
 * is the ordered list of node types the IVR product exposes for dragging onto
 * the canvas — `entry` is created automatically (one per flow) so it is not in
 * the palette.
 */
import type { NodeType } from './types';

export interface NodeMeta {
  label: string;
  /** Accent colour (design tokens, docker/ui/CLAUDE.md §15). */
  accent: string;
  /** Single-character glyph shown in the node header + palette chip. */
  glyph: string;
  /** One-line description shown in the palette. */
  blurb: string;
}

export const NODE_META: Record<string, NodeMeta> = {
  entry: { label: 'Call Arrives', accent: '#22d3ee', glyph: '●', blurb: 'Inbound call trigger' },
  say: { label: 'Say', accent: '#3b82f6', glyph: 'A', blurb: 'Speak text (TTS)' },
  play: { label: 'Play Audio', accent: '#8b5cf6', glyph: '♪', blurb: 'Play an audio URL' },
  pause: { label: 'Pause', accent: '#64748b', glyph: '⏸', blurb: 'Wait N seconds' },
  menu: { label: 'Menu', accent: '#c084fc', glyph: '#', blurb: 'Gather digits, branch per key' },
  dial: { label: 'Dial', accent: '#4ade80', glyph: '☎', blurb: 'Forward to a destination' },
  record: { label: 'Record', accent: '#f472b6', glyph: '⏺', blurb: 'Record the caller' },
  redirect: { label: 'Redirect', accent: '#22d3ee', glyph: '↪', blurb: 'Hand control to another flow/URL' },
  reject: { label: 'Reject', accent: '#ef4444', glyph: '⊘', blurb: 'Reject the call' },
  hangup: { label: 'Hangup', accent: '#ef4444', glyph: '✕', blurb: 'End the call' },
  conference: { label: 'Conference', accent: '#fbbf24', glyph: '⊞', blurb: 'Join a conference room' },
};

/** Fallback accent for any node type without explicit metadata. */
export const DEFAULT_ACCENT = '#3b82f6';

export function nodeAccent(type: NodeType | undefined): string {
  return (type && NODE_META[type]?.accent) || DEFAULT_ACCENT;
}

/** Ordered IVR palette (entry excluded — auto-created, one per flow). */
export const IVR_PALETTE: NodeType[] = [
  'say',
  'play',
  'pause',
  'menu',
  'dial',
  'record',
  'redirect',
  'conference',
  'reject',
  'hangup',
];
