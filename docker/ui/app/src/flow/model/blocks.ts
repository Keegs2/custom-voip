/**
 * blocks.ts — the IVR block catalog: names, palette groups, defaults and the
 * exits ("out handles") each block offers. Pure (no React, no DOM), so the
 * builder, the client compile mirror and the node-run self-tests share ONE
 * definition of the §2 handle vocabulary:
 *
 *   entry/play  next
 *   menu        d:<digit> for each digit in `digits`, noInput, noMatch
 *   schedule    open, closed
 *   condition   match, noMatch
 *   dial        noAnswer
 *   voicemail · goto · hangup — none (they end the path)
 *
 * Names are the customer-facing labels from contract §2 (Start, Play
 * message, Menu, Business hours, Caller check, Transfer, Voicemail, Go to,
 * Hang up). Colours live in CSS as `--ivr-<type>` (styles/ivr.css).
 */
import type {
  DayKey,
  IvrConfigMap,
  IvrNodeType,
  IvrTimezone,
  MenuDigit,
  TimeRange,
} from '../../types/ivr.ts';

export interface BlockMeta {
  type: IvrNodeType;
  /** Customer-facing name (contract §2 "UI label"). */
  label: string;
  /** One sentence for the inspector header and the add-block menu. */
  description: string;
  /** A few words for the compact palette. */
  hint: string;
  /** True when the path ends here (no exits). */
  terminal: boolean;
}

export const BLOCKS: Readonly<Record<IvrNodeType, BlockMeta>> = {
  entry: { type: 'entry', label: 'Start', description: 'Where every call begins.', hint: 'Where calls begin', terminal: false },
  play: {
    type: 'play',
    label: 'Play message',
    description: 'Play one or more recordings or read text aloud.',
    hint: 'Recordings or speech',
    terminal: false,
  },
  menu: {
    type: 'menu',
    label: 'Menu',
    description: 'Ask the caller to press a key, then branch on it.',
    hint: 'Press 1, press 2…',
    terminal: false,
  },
  schedule: {
    type: 'schedule',
    label: 'Business hours',
    description: 'Route differently when you are open or closed.',
    hint: 'Open and closed routes',
    terminal: false,
  },
  condition: {
    type: 'condition',
    label: 'Caller check',
    description: 'Branch on the caller’s number.',
    hint: 'Branch on the caller',
    terminal: false,
  },
  dial: {
    type: 'dial',
    label: 'Transfer',
    description: 'Ring one of your numbers or an outside US number.',
    hint: 'Ring a number',
    terminal: false,
  },
  voicemail: {
    type: 'voicemail',
    label: 'Voicemail',
    description: 'Let the caller leave a message in one of your mailboxes.',
    hint: 'Take a message',
    terminal: true,
  },
  goto: {
    type: 'goto',
    label: 'Go to',
    description: 'Jump back to another block, such as “repeat the menu”.',
    hint: 'Jump back, e.g. repeat',
    terminal: true,
  },
  hangup: {
    type: 'hangup',
    label: 'Hang up',
    description: 'Optionally say goodbye, then end the call.',
    hint: 'End the call',
    terminal: true,
  },
};

export interface PaletteGroup {
  id: 'talk' | 'decide' | 'connect' | 'finish';
  label: string;
  types: readonly IvrNodeType[];
}

/** The palette, in the order a caller meets the blocks. Start is never in it. */
export const PALETTE_GROUPS: readonly PaletteGroup[] = [
  { id: 'talk', label: 'Talk to the caller', types: ['play', 'menu'] },
  { id: 'decide', label: 'Decide', types: ['schedule', 'condition'] },
  { id: 'connect', label: 'Connect the call', types: ['dial', 'voicemail'] },
  { id: 'finish', label: 'Finish', types: ['goto', 'hangup'] },
];

export const PALETTE_TYPES: readonly IvrNodeType[] = PALETTE_GROUPS.flatMap((g) => g.types);

export function isIvrNodeType(value: unknown): value is IvrNodeType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BLOCKS, value);
}

export function blockLabel(type: IvrNodeType): string {
  return BLOCKS[type].label;
}

/* ─── Keys, days, timezones, limits ───────────────────────── */

/** Keypad order (1–9, 0, *, #) — how digits are listed everywhere. */
export const DIGIT_ORDER: readonly MenuDigit[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '*', '#'];

export function isMenuDigit(value: unknown): value is MenuDigit {
  return typeof value === 'string' && (DIGIT_ORDER as readonly string[]).includes(value);
}

/** Sort digits into keypad order, dropping duplicates and anything else. */
export function sortDigits(digits: readonly string[]): MenuDigit[] {
  const set = new Set(digits);
  return DIGIT_ORDER.filter((d) => set.has(d));
}

export const DAY_KEYS: readonly DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export const DAY_LABELS: Readonly<Record<DayKey, { short: string; long: string }>> = {
  mon: { short: 'Mon', long: 'Monday' },
  tue: { short: 'Tue', long: 'Tuesday' },
  wed: { short: 'Wed', long: 'Wednesday' },
  thu: { short: 'Thu', long: 'Thursday' },
  fri: { short: 'Fri', long: 'Friday' },
  sat: { short: 'Sat', long: 'Saturday' },
  sun: { short: 'Sun', long: 'Sunday' },
};

/** The pinned list (§2), with the names customers know them by. */
export const TIMEZONES: readonly { id: IvrTimezone; label: string }[] = [
  { id: 'America/New_York', label: 'Eastern (New York)' },
  { id: 'America/Detroit', label: 'Eastern (Detroit)' },
  { id: 'America/Chicago', label: 'Central (Chicago)' },
  { id: 'America/Denver', label: 'Mountain (Denver)' },
  { id: 'America/Phoenix', label: 'Arizona (Phoenix, no daylight saving)' },
  { id: 'America/Los_Angeles', label: 'Pacific (Los Angeles)' },
  { id: 'America/Anchorage', label: 'Alaska (Anchorage)' },
  { id: 'Pacific/Honolulu', label: 'Hawaii (Honolulu)' },
  { id: 'America/Puerto_Rico', label: 'Atlantic (Puerto Rico, no daylight saving)' },
];

export function isIvrTimezone(value: unknown): value is IvrTimezone {
  return typeof value === 'string' && TIMEZONES.some((t) => t.id === value);
}

export function timezoneLabel(tz: string): string {
  return TIMEZONES.find((t) => t.id === tz)?.label ?? tz;
}

/** Contract §2 bounds (the server enforces the same). */
export const LIMITS = {
  promptsPerBlock: 10,
  digitsMin: 1,
  digitsMax: 12,
  timeoutSec: { min: 1, max: 30 },
  retries: { min: 0, max: 5 },
  ringTimeoutSec: { min: 5, max: 120 },
  conditionValues: { min: 1, max: 50 },
  rangesPerDay: 4,
  /** Plan §1 proposed default (200 blocks per flow). `summary.limits.max_blocks` overrides. */
  blocks: 200,
} as const;

/* ─── Defaults ────────────────────────────────────────────── */

const WEEKDAY: TimeRange[] = [['09:00', '17:00']];

export function defaultConfig<T extends IvrNodeType>(type: T): IvrConfigMap[T] {
  const configs: { [K in IvrNodeType]: () => IvrConfigMap[K] } = {
    entry: () => ({}),
    play: () => ({ prompts: [] }),
    menu: () => ({ prompts: [], digits: ['1', '2'], timeoutSec: 5, retries: 2 }),
    schedule: () => ({
      tz: 'America/New_York',
      weekly: {
        mon: WEEKDAY.map((r) => [...r] as TimeRange),
        tue: WEEKDAY.map((r) => [...r] as TimeRange),
        wed: WEEKDAY.map((r) => [...r] as TimeRange),
        thu: WEEKDAY.map((r) => [...r] as TimeRange),
        fri: WEEKDAY.map((r) => [...r] as TimeRange),
        sat: [],
        sun: [],
      },
      closedDates: [],
    }),
    condition: () => ({ mode: 'prefix', values: [] }),
    dial: () => ({ target: { kind: 'own', did: '' }, passCallerId: true, ringTimeoutSec: 30 }),
    voicemail: () => ({ did: '' }),
    goto: () => ({ targetNodeId: '' }),
    hangup: () => ({}),
  };
  return configs[type]() as IvrConfigMap[T];
}

/* ─── Exits ───────────────────────────────────────────────── */

export type HandleKind = 'next' | 'digit' | 'positive' | 'negative' | 'fallback';

export interface OutHandle {
  /** The §2 `sourceHandle` id. */
  id: string;
  /** How the exit reads to a customer ("Press 1", "No answer or busy"). */
  label: string;
  kind: HandleKind;
  digit?: MenuDigit;
}

export const NEXT = 'next';
export const NO_INPUT = 'noInput';
export const NO_MATCH = 'noMatch';
export const OPEN = 'open';
export const CLOSED = 'closed';
export const MATCH = 'match';
export const NO_ANSWER = 'noAnswer';

export function digitHandle(digit: MenuDigit): string {
  return `d:${digit}`;
}

/** `d:5` → `'5'`; anything else → null. */
export function digitOfHandle(handle: string | null | undefined): MenuDigit | null {
  if (!handle || !handle.startsWith('d:')) return null;
  const d = handle.slice(2);
  return isMenuDigit(d) ? d : null;
}

/** Minimal structural view of a block (the store's nodes and §2 nodes both fit). */
export interface BlockLike {
  type: IvrNodeType;
  data: { config: unknown };
}

/**
 * The exits a block offers right now (a menu's follow its `digits`). The
 * builder prunes any edge whose handle is not in this list, which is how a
 * removed menu key can never leave an invisible live edge behind.
 */
export function outHandles(node: BlockLike): OutHandle[] {
  switch (node.type) {
    case 'entry':
      return [{ id: NEXT, label: 'First', kind: 'next' }];
    case 'play':
      return [{ id: NEXT, label: 'Then', kind: 'next' }];
    case 'menu': {
      const cfg = node.data.config as Partial<IvrConfigMap['menu']>;
      const digits = sortDigits(Array.isArray(cfg.digits) ? cfg.digits : []);
      return [
        ...digits.map((d): OutHandle => ({ id: digitHandle(d), label: `Press ${d}`, kind: 'digit', digit: d })),
        { id: NO_INPUT, label: 'No key pressed', kind: 'fallback' },
        { id: NO_MATCH, label: 'Wrong key', kind: 'fallback' },
      ];
    }
    case 'schedule':
      return [
        { id: OPEN, label: 'Open', kind: 'positive' },
        { id: CLOSED, label: 'Closed', kind: 'negative' },
      ];
    case 'condition':
      return [
        { id: MATCH, label: 'Matches', kind: 'positive' },
        { id: NO_MATCH, label: 'Doesn’t match', kind: 'negative' },
      ];
    case 'dial':
      return [{ id: NO_ANSWER, label: 'No answer or busy', kind: 'fallback' }];
    case 'voicemail':
    case 'goto':
    case 'hangup':
      return [];
  }
}

export function handleLabel(node: BlockLike, handle: string): string {
  return outHandles(node).find((h) => h.id === handle)?.label ?? handle;
}
