/**
 * summary.ts — the plain-English one-liners a block shows on the canvas, in
 * the outline and in the "what callers hear" transcript. Pure; shared so
 * the three surfaces never word the same block differently.
 */
import type { DayKey, Destinations, IvrConfigMap, IvrNodeType, TimeRange } from '../../types/ivr.ts';
import { BLOCKS, DAY_KEYS, DAY_LABELS, timezoneLabel } from './blocks.ts';
import { prettyNumber } from '../compile/policy.ts';

export interface SummaryContext {
  promptName: (id: number) => string | null;
  /** The customer's numbers (for "Sales line · (617) …"). Null = not loaded. */
  destinations: Destinations | null;
  /** Block title by id (for Go to). */
  titleOf: (nodeId: string) => string | null;
}

export interface BlockView {
  id: string;
  type: IvrNodeType;
  data: { label?: string; config: unknown };
}

export function blockTitle(node: { type: IvrNodeType; data: { label?: string } }): string {
  const label = node.data.label?.trim();
  return label ? label : BLOCKS[node.type].label;
}

/** "9:00 AM", "1:30 PM", "noon", "midnight". */
export function formatClockTime(hhmm: string): string {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if ((h === 0 || h === 24) && min === 0) return 'midnight';
  if (h === 12 && min === 0) return 'noon';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const suffix = h < 12 || h === 24 ? 'AM' : 'PM';
  return min === 0 ? `${h12} ${suffix}` : `${h12}:${String(min).padStart(2, '0')} ${suffix}`;
}

export function formatRanges(ranges: readonly TimeRange[]): string {
  if (ranges.length === 0) return 'closed';
  return ranges.map(([a, b]) => `${formatClockTime(a)}–${formatClockTime(b)}`).join(', ');
}

/**
 * "Mon–Fri 9 AM–5 PM · Sat 10 AM–2 PM" — consecutive days with the same
 * hours are grouped; closed days are left out (or "Closed every day").
 */
export function formatWeekly(weekly: Readonly<Record<DayKey, readonly TimeRange[]>>): string {
  const groups: { from: DayKey; to: DayKey; hours: string }[] = [];
  for (const day of DAY_KEYS) {
    const ranges = weekly[day] ?? [];
    if (ranges.length === 0) continue;
    const hours = formatRanges(ranges);
    const last = groups[groups.length - 1];
    const prevDay = DAY_KEYS[DAY_KEYS.indexOf(day) - 1];
    if (last && last.hours === hours && last.to === prevDay) last.to = day;
    else groups.push({ from: day, to: day, hours });
  }
  if (groups.length === 0) return 'Closed every day';
  return groups
    .map((g) =>
      g.from === g.to
        ? `${DAY_LABELS[g.from].short} ${g.hours}`
        : `${DAY_LABELS[g.from].short}–${DAY_LABELS[g.to].short} ${g.hours}`,
    )
    .join(' · ');
}

export function quoteList(names: readonly string[]): string {
  const quoted = names.map((n) => `“${n}”`);
  if (quoted.length <= 1) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} then ${quoted[quoted.length - 1]}`;
}

/** Name + product words for one of the customer's own numbers. */
export function describeOwnNumber(did: string, destinations: Destinations | null): string {
  for (const g of destinations?.groups ?? []) {
    const hit = g.numbers.find((n) => n.did === did);
    if (hit) return hit.name ? `${hit.name} · ${prettyNumber(did)}` : prettyNumber(did);
  }
  return prettyNumber(did);
}

function promptNames(ids: readonly number[] | undefined, ctx: SummaryContext): string[] {
  return (ids ?? []).map((id) => ctx.promptName(id) ?? 'a deleted message');
}

/** The one line under a block's title. */
export function summarizeBlock(node: BlockView, ctx: SummaryContext): string {
  switch (node.type) {
    case 'entry':
      return 'A caller dials one of this flow’s numbers';
    case 'play': {
      const c = node.data.config as IvrConfigMap['play'];
      const names = promptNames(c.prompts, ctx);
      return names.length ? `Plays ${quoteList(names)}` : 'No message chosen yet';
    }
    case 'menu': {
      const c = node.data.config as IvrConfigMap['menu'];
      const names = promptNames(c.prompts, ctx);
      const keys = c.digits.length ? `keys ${c.digits.join(', ')}` : 'no keys yet';
      return names.length ? `Plays ${quoteList(names)}, listens for ${keys}` : `Listens for ${keys}`;
    }
    case 'schedule': {
      const c = node.data.config as IvrConfigMap['schedule'];
      return `${formatWeekly(c.weekly)} (${timezoneLabel(c.tz).replace(/ \(.*$/, '')})`;
    }
    case 'condition': {
      const c = node.data.config as IvrConfigMap['condition'];
      if (c.mode === 'anonymous') return 'Is the caller ID withheld?';
      if (c.values.length === 0) return 'No numbers to check yet';
      const shown = c.values.slice(0, 2).join(', ') + (c.values.length > 2 ? ` +${c.values.length - 2} more` : '');
      return c.mode === 'prefix' ? `Number starts with ${shown}` : `Number is ${shown}`;
    }
    case 'dial': {
      const c = node.data.config as IvrConfigMap['dial'];
      const t = c.target;
      if (t.kind === 'own') return t.did ? describeOwnNumber(t.did, ctx.destinations) : 'No destination chosen yet';
      return t.number ? `Outside number ${prettyNumber(t.number)}` : 'No destination chosen yet';
    }
    case 'voicemail': {
      const c = node.data.config as IvrConfigMap['voicemail'];
      return c.did ? `Mailbox ${describeOwnNumber(c.did, ctx.destinations)}` : 'No mailbox chosen yet';
    }
    case 'goto': {
      const c = node.data.config as IvrConfigMap['goto'];
      const title = c.targetNodeId ? ctx.titleOf(c.targetNodeId) : null;
      return title ? `Back to ${title}` : 'No block chosen yet';
    }
    case 'hangup': {
      const c = node.data.config as IvrConfigMap['hangup'];
      const names = promptNames(c.prompts, ctx);
      return names.length ? `Plays ${quoteList(names)}, then hangs up` : 'Ends the call';
    }
  }
}
