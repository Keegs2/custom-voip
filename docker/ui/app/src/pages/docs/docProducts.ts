/**
 * Product slugs for the two documentation pages (Guides hub, API Reference).
 * Component-free module so ProductSelector.tsx satisfies
 * react-refresh/only-export-components (same pattern as tokens.ts).
 */

/** Guides hub products — /docs/guides/:product? */
export const GUIDE_PRODUCTS = ['rcf', 'trunking', 'calling', 'voicemail'] as const;
export type GuideProduct = (typeof GUIDE_PRODUCTS)[number];

/** API Reference products — Telemetry replaces Voicemail (no voicemail API yet). */
export const API_PRODUCTS = ['rcf', 'trunking', 'calling', 'telemetry'] as const;
export type ApiProduct = (typeof API_PRODUCTS)[number];

export function isGuideProduct(v: string | undefined): v is GuideProduct {
  return v !== undefined && (GUIDE_PRODUCTS as readonly string[]).includes(v);
}

export function isApiProduct(v: string | undefined): v is ApiProduct {
  return v !== undefined && (API_PRODUCTS as readonly string[]).includes(v);
}
