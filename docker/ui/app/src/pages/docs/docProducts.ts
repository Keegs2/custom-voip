/**
 * Product slugs for the two documentation pages (Guides hub, API Reference).
 * Component-free module so ProductSelector.tsx satisfies
 * react-refresh/only-export-components (same pattern as tokens.ts).
 */

import { API_CALLING_ENABLED } from '../../config/features';

/**
 * `calling` (API Calling) is RETIRED — its guide and REST-reference sections are
 * kept in code but only listed while API_CALLING_ENABLED is on. The *_ALL
 * tuples define the slug types (so the content maps stay exhaustive); the
 * exported lists are what the selector renders and what counts as a valid
 * URL slug, so /docs/{guides,api}/calling redirects to the hub default.
 */
const visible = <P extends string>(all: readonly P[]): readonly P[] =>
  API_CALLING_ENABLED ? all : all.filter(p => p !== 'calling');

/** Guides hub products — /docs/guides/:product? */
const GUIDE_PRODUCTS_ALL = ['rcf', 'trunking', 'calling', 'voicemail'] as const;
export type GuideProduct = (typeof GUIDE_PRODUCTS_ALL)[number];
export const GUIDE_PRODUCTS: readonly GuideProduct[] = visible(GUIDE_PRODUCTS_ALL);

/** API Reference products — Telemetry replaces Voicemail (no voicemail API yet). */
const API_PRODUCTS_ALL = ['rcf', 'trunking', 'calling', 'telemetry'] as const;
export type ApiProduct = (typeof API_PRODUCTS_ALL)[number];
export const API_PRODUCTS: readonly ApiProduct[] = visible(API_PRODUCTS_ALL);

export function isGuideProduct(v: string | undefined): v is GuideProduct {
  return v !== undefined && (GUIDE_PRODUCTS as readonly string[]).includes(v);
}

export function isApiProduct(v: string | undefined): v is ApiProduct {
  return v !== undefined && (API_PRODUCTS as readonly string[]).includes(v);
}
