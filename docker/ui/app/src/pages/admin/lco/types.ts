/**
 * Local types + consts for the Least-Cost Outbound admin feature.
 *
 * Page-global LCO types live in `src/types/lco.ts`. Only feature-local tab ids,
 * option lists, and page-size consts live here.
 */

export const PAGE_SIZE = 50;

export type LcoTabId = 'route' | 'decks' | 'policy' | 'savings';

export interface LcoTabDef {
  id: LcoTabId;
  label: string;
}

export const LCO_TABS: ReadonlyArray<LcoTabDef> = [
  { id: 'route', label: 'Route Preview' },
  { id: 'decks', label: 'Rate Decks' },
  { id: 'policy', label: 'Carrier Policy' },
  { id: 'savings', label: 'Savings Report' },
];

export const JURISDICTIONS: ReadonlyArray<string> = ['default', 'interstate', 'intrastate', 'intl'];

export const POLICY_MODES: ReadonlyArray<{ value: 'allow' | 'deny'; label: string }> = [
  { value: 'allow', label: 'Allow' },
  { value: 'deny', label: 'Deny' },
];

/** Default savings/report window — trailing 30 days, as `datetime-local` strings. */
export function defaultReportWindow(): { start: string; end: string } {
  const toLocal = (d: Date) => {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 30);
  return { start: toLocal(start), end: toLocal(end) };
}
