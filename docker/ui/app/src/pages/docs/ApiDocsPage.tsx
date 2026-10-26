/**
 * API Reference — /docs/api/:product? (route entry).
 *
 * The bare /docs/api is Getting started; /docs/api/{numbers,calls,voicemail,
 * trunking} are the product sections (docProducts.ts API_SECTIONS). Earlier
 * slugs still land: /docs/api/rcf → numbers, /docs/api/telemetry → calls;
 * anything else (incl. the switched-off `calling`) → Getting started.
 *
 * Customer-facing only: every endpoint documented is one a tenant `user` /
 * `readonly` can call today, with the fields a tenant actually receives —
 * no admin/staff routes or fields, no internal components, vendors, hosts
 * or addresses. Content: pages/docs/api/sections/*.ts (truth contract in
 * pages/docs/api/types.ts). Layout: docker/ui/CLAUDE.md §20.
 *
 * React #310: hooks (useParams/useLocation) run unconditionally at the top.
 */
import { Navigate, useLocation, useParams } from 'react-router-dom';

import { ApiReference } from './api/ApiReference';
import { apiSectionForLegacySlug, apiSectionHref, isApiSectionSlug, type ApiSection } from './docProducts';

export function ApiDocsPage() {
  const { product } = useParams<{ product: string }>();
  const { hash } = useLocation();

  if (product !== undefined && !isApiSectionSlug(product)) {
    const legacy = apiSectionForLegacySlug(product);
    return <Navigate to={legacy ? `${apiSectionHref(legacy)}${hash}` : '/docs/api'} replace />;
  }

  const section: ApiSection = product ?? 'start';
  // Keyed: a section switch remounts the view (fresh open state, no hook-order change).
  return <ApiReference key={section} section={section} />;
}
