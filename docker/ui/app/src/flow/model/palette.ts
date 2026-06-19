/**
 * Per-product palette + presentation metadata for the builder.
 *
 * `NODE_META` gives each telephony node a stable accent colour, a short glyph
 * (rendered in the node header + palette), and a one-line blurb. `IVR_PALETTE`
 * is the ordered list of node types the IVR product exposes for dragging onto
 * the canvas — `entry` is created automatically (one per flow) so it is not in
 * the palette.
 */
import type { NodeType, ProductKind } from './types';

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
  ringGroup: { label: 'Ring Group', accent: '#34d399', glyph: '⇉', blurb: 'Find-me/follow-me ring plan' },
  route: { label: 'Route', accent: '#fbbf24', glyph: '⌥', blurb: 'Deliver to trunk PBX endpoints' },
  voicemail: { label: 'Voicemail', accent: '#f59e0b', glyph: '✉', blurb: 'Send caller to voicemail' },
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

/**
 * Conference palette (plan §3): a greeting then join a room. `entry` is
 * auto-created, so it is not listed here.
 */
export const CONFERENCE_PALETTE: NodeType[] = ['say', 'play', 'conference', 'hangup'];

/**
 * RCF palette (plan §0.1 / §12): RCF stays simple — a single forward
 * destination, nothing else. `entry` is auto-created. NO menu/say/conference and
 * NO second-destination/failover node (`rcf_numbers.failover_to` is dead code).
 */
export const RCF_PALETTE: NodeType[] = ['dial', 'hangup'];

/**
 * UCaaS palette (plan §3, find-me/follow-me): an extension's ring plan — ring a
 * group of destinations, then fall back to voicemail / forward / hangup. `entry`
 * is auto-created (one per flow), so it is not listed here. Deliberately focused:
 * a ringGroup + the three terminal fallbacks, nothing else.
 */
export const UCAAS_PALETTE: NodeType[] = ['ringGroup', 'voicemail', 'dial', 'hangup'];

/**
 * SIP-trunk palette (plan §3 / §12): inbound delivery for a trunk DID. Focused —
 * a single `route` node (ordered/parallel PBX endpoints with timeouts) plus the
 * terminal `hangup`. `entry` is auto-created (one per flow), so it is not listed
 * here. No say/menu/conference: trunk inbound is delivery, not programmable voice.
 */
export const TRUNK_PALETTE: NodeType[] = ['route', 'hangup'];

/**
 * Per-product palette. The palette IS the product gate (plan §0.1 decision 2):
 * a product can only express what its palette exposes.
 *
 *  - `ivr` / `api`: the full IVR verb set (same palette + compiler).
 *  - `conference`: greeting + join a room.
 *  - `rcf`: forward + hangup only.
 *  - `ucaas`: find-me/follow-me ring plan (ringGroup + voicemail/forward/hangup).
 *  - `trunk`: SIP-trunk inbound delivery — a single `route` node + hangup.
 */
export const PALETTE_BY_PRODUCT: Record<ProductKind, NodeType[]> = {
  ivr: IVR_PALETTE,
  api: IVR_PALETTE,
  conference: CONFERENCE_PALETTE,
  rcf: RCF_PALETTE,
  trunk: TRUNK_PALETTE,
  ucaas: UCAAS_PALETTE,
};

/** The ordered palette a product exposes for dragging onto the canvas. */
export function paletteForProduct(product: ProductKind): NodeType[] {
  return PALETTE_BY_PRODUCT[product] ?? IVR_PALETTE;
}

/** Human-friendly product names for the toolbar + product selector. */
export const PRODUCT_LABELS: Record<ProductKind, string> = {
  ivr: 'IVR',
  api: 'API Calling',
  rcf: 'RCF',
  conference: 'Conference',
  trunk: 'SIP Trunk',
  ucaas: 'UCaaS',
};

/** Products offered when creating a NEW flow (Task 1). */
export const SELECTABLE_PRODUCTS: ProductKind[] = ['ivr', 'api', 'rcf', 'conference', 'trunk', 'ucaas'];
