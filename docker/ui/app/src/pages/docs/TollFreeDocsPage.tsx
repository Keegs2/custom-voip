/**
 * Toll-Free & Wholesale — public product guide (route `/docs/toll-free`).
 * Content lives in `guides/tollFree.tsx`. Public (outside RequireAuth),
 * inside AppLayout — no top padding.
 */

import { ProductGuide } from './components/ProductGuide';
import { tollFreeGuide } from './guides/tollFree';

export function TollFreeDocsPage() {
  return <ProductGuide data={tollFreeGuide} />;
}
