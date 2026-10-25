/**
 * destinations.ts — how the customer's own numbers are grouped and named in
 * the transfer picker and the Voicemail block (plan D3). Fixed order and
 * names for the four products; an unknown product follows with the
 * server's own label.
 */
import type { DestinationGroup, DestinationProduct, Destinations } from '../../types/ivr';

const GROUP_ORDER: readonly DestinationProduct[] = ['rcf', 'voicemail', 'ivr', 'trunk'];
const GROUP_LABEL: Readonly<Record<DestinationProduct, string>> = {
  rcf: 'Call forwarding (RCF)',
  voicemail: 'Voicemail boxes',
  ivr: 'Other IVRs',
  trunk: 'SIP trunk numbers',
};

export function groupLabel(g: DestinationGroup): string {
  return GROUP_LABEL[g.product] ?? g.label;
}

export function orderedGroups(destinations: Destinations | null | undefined): DestinationGroup[] {
  const groups = [...(destinations?.groups ?? [])];
  return groups.sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a.product);
    const ib = GROUP_ORDER.indexOf(b.product);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}


/** The group and number for a DID, if it is one of the customer's. */
export function findOwnNumber(destinations: Destinations | null | undefined, did: string) {
  for (const g of destinations?.groups ?? []) {
    const n = g.numbers.find((x) => x.did === did);
    if (n) return { group: g, number: n };
  }
  return null;
}
