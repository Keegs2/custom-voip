/**
 * Product slugs for the two documentation pages (Guides hub, API Reference).
 * Component-free (react-refresh/only-export-components, same pattern as
 * tokens.ts).
 */

import { API_CALLING_ENABLED } from '../../config/features';

/**
 * `calling` (API Calling) is switched off (customer copy: "on our roadmap") —
 * it is only listed while API_CALLING_ENABLED is on (the API Reference has no
 * calling section; see API_SECTIONS_ALL below). The *_ALL tuples define the
 * slug types (so the content maps stay exhaustive); the exported lists are
 * what counts as a valid URL slug, so /docs/{guides,api}/calling redirects to
 * the hub default.
 */
const visible = <P extends string>(all: readonly P[]): readonly P[] =>
  API_CALLING_ENABLED ? all : all.filter(p => p !== 'calling');

/** Guides hub products — /docs/guides/:product? */
const GUIDE_PRODUCTS_ALL = ['rcf', 'trunking', 'calling', 'voicemail'] as const;
export type GuideProduct = (typeof GUIDE_PRODUCTS_ALL)[number];
export const GUIDE_PRODUCTS: readonly GuideProduct[] = visible(GUIDE_PRODUCTS_ALL);

/* ─── API Reference — /docs/api/:product? ───────────────────────────────── */

/**
 * The API Reference's sections. `start` (Getting started) lives at the bare
 * /docs/api; every other section at /docs/api/<slug>. Only endpoints a
 * tenant (`user` / `readonly`) can call are documented — see
 * pages/docs/api/types.ts. API Calling (/v1/calls) is NOT a section: it is
 * switched off (API_CALLING_ENABLED) and the reference mentions it only as
 * "on our roadmap".
 */
const API_SECTIONS_ALL = ['start', 'numbers', 'calls', 'voicemail', 'trunking'] as const;
export type ApiSection = (typeof API_SECTIONS_ALL)[number];
export const API_SECTIONS: readonly ApiSection[] = API_SECTIONS_ALL;

/** URL of a section (Getting started is the bare /docs/api). */
export function apiSectionHref(section: ApiSection): string {
  return section === 'start' ? '/docs/api' : `/docs/api/${section}`;
}

/** A /docs/api/:product slug that names a section (`start` has no slug). */
export function isApiSectionSlug(v: string | undefined): v is Exclude<ApiSection, 'start'> {
  return v !== undefined && v !== 'start' && (API_SECTIONS as readonly string[]).includes(v);
}

/**
 * An earlier /docs/api slug → today's section, so old links and bookmarks
 * still land (`rcf` → numbers, `telemetry` → calls); null for anything else
 * (`calling` included — the page sends it to Getting started).
 */
export function apiSectionForLegacySlug(slug: string): ApiSection | null {
  switch (slug) {
    case 'rcf':
      return 'numbers';
    case 'telemetry':
      return 'calls';
    default:
      return null;
  }
}

export function isGuideProduct(v: string | undefined): v is GuideProduct {
  return v !== undefined && (GUIDE_PRODUCTS as readonly string[]).includes(v);
}
