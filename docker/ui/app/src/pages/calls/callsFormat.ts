/**
 * callsFormat.ts — carrier + trunk display formatting for the Calls & Quality
 * page. The ONE mapping shared by the results table, the call-detail modal,
 * and the CSV export, so the three can never drift.
 *
 * Carrier semantics (see root CLAUDE.md "Sinch Carrier Behaviors" + on-net):
 * - INBOUND rows carry `inbound_carrier` ('bandwidth' | 'sinch'; NULL on
 *   legacy/pre-attribution rows → the platform default 'bandwidth') plus
 *   `inbound_carrier_pop` (e.g. 'denver', 'chicago').
 * - OUTBOUND rows carry `carrier_used`: either a legacy 2-carrier-era enum
 *   ('carrier_primary' → Bandwidth Dallas, 'carrier_secondary' → Bandwidth
 *   LA, 'local' → on-net) or a table-driven '<carrier>[-<pop…>]' label from
 *   the carrier_trunks failover loop ('bandwidth-dallas', 'sinch-denver',
 *   'sinch-atlanta-ld', …).
 * - On-net rows (`on_net` true / carrier_used 'local') read "On-net" — the
 *   call never left the platform, so no carrier applies.
 */
import type { Cdr } from '../../types/cdr';

/** Em dash placeholder for "nothing recorded" (matches the table idiom). */
export const EMPTY = '—';

/** Compact carrier display names. Unknown carriers fall back to Capitalized. */
const CARRIER_NAMES: Record<string, string> = {
  bandwidth: 'BW',
  sinch: 'Sinch',
};

/** Legacy 2-carrier-era `carrier_used` values → human label. */
const LEGACY_CARRIER_USED: Record<string, string> = {
  carrier_primary: 'BW·Dallas', // Bandwidth Dallas (67.231.2.12)
  carrier_secondary: 'BW·LA', // Bandwidth Los Angeles (216.82.238.134)
  local: 'On-net',
};

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** 'atlanta-ld' → 'Atlanta LD' — short tokens (≤2 chars) read as acronyms. */
function popLabel(raw: string): string {
  return raw
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 2 ? w.toUpperCase() : capitalize(w)))
    .join(' ');
}

function carrierName(raw: string): string {
  const key = raw.toLowerCase();
  return CARRIER_NAMES[key] ?? capitalize(key);
}

function fold(carrier: string, pop: string | null | undefined): string {
  const name = carrierName(carrier);
  return pop ? `${name}·${popLabel(pop)}` : name;
}

/** True when the call was delivered internally (no carrier B-leg). */
export function isOnNetCall(cdr: Pick<Cdr, 'on_net' | 'carrier_used'>): boolean {
  return cdr.on_net === true || cdr.carrier_used === 'local';
}

/**
 * Compact human carrier label for a CDR: "BW·Dallas", "Sinch·Denver",
 * "On-net", or EMPTY when nothing is recorded. Direction decides which field
 * wins: inbound rows → origination carrier (+PoP, NULL = Bandwidth default);
 * outbound rows → the `carrier_used` fold.
 */
export function carrierLabel(
  cdr: Pick<Cdr, 'direction' | 'carrier_used' | 'inbound_carrier' | 'inbound_carrier_pop' | 'on_net'>,
): string {
  if (isOnNetCall(cdr)) return 'On-net';

  if (cdr.direction === 'inbound') {
    // NULL on pre-attribution rows = implicit Bandwidth (platform default).
    const carrier = cdr.inbound_carrier?.trim() || 'bandwidth';
    return fold(carrier, cdr.inbound_carrier_pop?.trim() || null);
  }

  const used = cdr.carrier_used?.trim();
  if (!used) return EMPTY;
  const legacy = LEGACY_CARRIER_USED[used];
  if (legacy) return legacy;
  // Table-driven '<carrier>[-<pop…>]' — carrier is everything before the
  // FIRST dash, the remainder is the PoP ('sinch-atlanta-ld' → Sinch·Atlanta LD).
  const dash = used.indexOf('-');
  if (dash === -1) return fold(used, null);
  return fold(used.slice(0, dash), used.slice(dash + 1));
}

/**
 * Trunk display: trunk name when the id resolves against the page's
 * already-fetched /v1/trunks list, '#id' when it doesn't (deleted trunk,
 * list cap), EMPTY for non-trunk calls (RCF rows have no trunk).
 */
export function trunkLabel(
  trunkId: Cdr['trunk_id'],
  trunkNames: Record<string, string> | undefined,
): string {
  if (trunkId == null || trunkId === '') return EMPTY;
  return trunkNames?.[String(trunkId)] ?? `#${trunkId}`;
}
