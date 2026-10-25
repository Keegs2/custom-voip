/**
 * products.ts — the ONE catalog of the products a customer's number can
 * belong to, and how each reads in the UI (rcf · api · trunk · voicemail · ivr).
 *
 * The API's product-agnostic list of "a customer's numbers" (the
 * `number_routing` view, read through `/reports/my-numbers`,
 * `/customers/me counts.numbers`, `/numbers/owned`) tags every number with a
 * product id. Every surface that lists or counts numbers renders that id
 * through the helpers below, so a NEW product shows up everywhere with no UI
 * change: an id missing from the catalog still renders, with a title-cased
 * label ("fax_line" → "Fax Line"), an upper-case tag and Active / Off words.
 * Adding an entry here is optional polish (nicer words, its place in the
 * order, a "where calls go" line).
 *
 * Not to be confused with `pages/dashboard/products.ts` — that is the
 * dashboard header's product SWITCHER (which product panel is showing).
 */
import { API_CALLING_ENABLED } from './features';

/** Product ids the catalog knows. The API may send others (future products). */
export type KnownProductId = 'rcf' | 'api' | 'trunk' | 'voicemail' | 'ivr';

/** A product id as the API sends it — known ids autocomplete, any string is accepted. */
export type ProductId = KnownProductId | (string & {});

export interface ProductInfo {
  id: string;
  /** Sentence-case name: "Call forwarding", "Voicemail". */
  label: string;
  /** Short tag for pills and table cells: "RCF", "Voicemail". */
  tag: string;
  /** Status word while the number is switched on ("Forwarding", "Taking messages"). */
  onWord: string;
  /** Status word while it is switched off ("Paused", "Off"). */
  offWord: string;
  /** Count noun for a product-mix sentence: "11 forwarding · 1 voicemail". */
  mixWord: string;
  /** "Where calls go" for a number of this product — null = the forwarding target (rcf). */
  destination: { main: string; sub: string | null } | null;
  /** Catalog position; unknown products sort after every known one. */
  order: number;
  /** Never shown to customers as one of "their numbers" (e.g. the retired API Calling). */
  hidden: boolean;
}

const CATALOG: Readonly<Record<KnownProductId, ProductInfo>> = {
  rcf: {
    id: 'rcf',
    label: 'Call forwarding',
    tag: 'RCF',
    onWord: 'Forwarding',
    offWord: 'Paused',
    mixWord: 'forwarding',
    destination: null,
    order: 1,
    hidden: false,
  },
  api: {
    id: 'api',
    label: 'API Calling',
    tag: 'API',
    onWord: 'Active',
    offWord: 'Off',
    mixWord: 'API',
    destination: { main: 'Your application', sub: 'API Calling' },
    order: 2,
    // Retired 2026-09 (config/features.ts); the API hides it from customer lists too.
    hidden: !API_CALLING_ENABLED,
  },
  trunk: {
    id: 'trunk',
    label: 'SIP trunk',
    tag: 'Trunk',
    onWord: 'Active',
    offWord: 'Off',
    mixWord: 'SIP trunk',
    destination: { main: 'Your phone system', sub: 'SIP trunk' },
    order: 3,
    hidden: false,
  },
  voicemail: {
    id: 'voicemail',
    label: 'Voicemail',
    tag: 'Voicemail',
    onWord: 'Taking messages',
    offWord: 'Off',
    mixWord: 'voicemail',
    destination: { main: 'Voicemail', sub: 'Callers leave a message' },
    order: 4,
    hidden: false,
  },
  // Visual IVR (docs/IVR_INTERFACES.md): a number answered by a menu the
  // customer builds in /ivr. `number_routing` lists it like any product.
  ivr: {
    id: 'ivr',
    label: 'IVR',
    tag: 'IVR',
    onWord: 'Answering',
    offWord: 'Off',
    mixWord: 'IVR',
    destination: { main: 'Your IVR menu', sub: 'IVR' },
    order: 5,
    hidden: false,
  },
};

/** Unknown products sort after the catalog, alphabetically among themselves. */
const UNKNOWN_ORDER = 1000;

function isKnown(id: string): id is KnownProductId {
  return Object.prototype.hasOwnProperty.call(CATALOG, id);
}

/** "fax_line" / "fax-line" / "FAX LINE" → ["fax", "line"]. */
function words(id: string): string[] {
  return id
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** The fallback for an id the catalog doesn't know — still readable, never blank. */
function fallbackInfo(id: string): ProductInfo {
  const parts = words(id);
  const label = parts.length ? parts.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : 'Other';
  return {
    id,
    label,
    tag: parts.length ? parts.join(' ').toUpperCase() : 'OTHER',
    onWord: 'Active',
    offWord: 'Off',
    mixWord: label.toLowerCase(),
    destination: { main: label, sub: null },
    order: UNKNOWN_ORDER,
    hidden: false,
  };
}

const fallbackCache = new Map<string, ProductInfo>();

/** Everything the UI says about a product. Unknown / empty ids get a readable fallback. */
export function productInfo(id: string | null | undefined): ProductInfo {
  const key = (id ?? '').trim();
  if (isKnown(key)) return CATALOG[key];
  let info = fallbackCache.get(key);
  if (!info) {
    info = fallbackInfo(key);
    fallbackCache.set(key, info);
  }
  return info;
}

/** "Call forwarding", "Voicemail", "Fax Line". */
export function productLabel(id: string | null | undefined): string {
  return productInfo(id).label;
}

/** "RCF", "Trunk", "Voicemail", "FAX LINE". */
export function productTag(id: string | null | undefined): string {
  return productInfo(id).tag;
}

/** True for products never shown to customers as one of their numbers. */
export function isProductHidden(id: string | null | undefined): boolean {
  return productInfo(id).hidden;
}

/** Sort comparator: catalog order, then unknown ids alphabetically. */
export function compareProducts(a: string, b: string): number {
  const oa = productInfo(a).order;
  const ob = productInfo(b).order;
  if (oa !== ob) return oa - ob;
  return a.localeCompare(b);
}

/** How many numbers an account has of one product. */
export interface ProductCount {
  product: string;
  count: number;
}

/**
 * `{rcf: 11, voicemail: 1}` (or a list of products, one entry per number) →
 * visible products with a non-zero count, in catalog order.
 */
export function productMix(counts: Readonly<Record<string, number>>): ProductCount[] {
  return Object.entries(counts)
    .filter(([product, count]) => count > 0 && !isProductHidden(product))
    .sort(([a], [b]) => compareProducts(a, b))
    .map(([product, count]) => ({ product, count }));
}

/** Counts per product from any list of product ids. */
export function countByProduct(products: Iterable<string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of products) out[p] = (out[p] ?? 0) + 1;
  return out;
}

/** "11 forwarding · 1 voicemail · 1 SIP trunk". */
export function mixSentence(mix: readonly ProductCount[]): string {
  return mix.map((m) => `${m.count.toLocaleString()} ${productInfo(m.product).mixWord}`).join(' · ');
}

/**
 * A number's sub-label: its name, plus the product for anything that isn't
 * call forwarding — "Front desk · Voicemail", "Voicemail" (no name),
 * "Boston office" (rcf, unchanged). null when there is nothing to say.
 */
export function nameWithProduct(name: string | null | undefined, product: string | null | undefined): string | null {
  const parts: string[] = [];
  if (name) parts.push(name);
  if (product && product !== 'rcf') parts.push(productLabel(product));
  return parts.length ? parts.join(' · ') : null;
}
