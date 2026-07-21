/**
 * Platform: Quality, Tooling & Trust — public product guide
 * (route `/docs/platform`). Content lives in `guides/platform.tsx`, which also
 * carries the SHARED API conventions the other guides link to. Public (outside
 * RequireAuth), inside AppLayout — no top padding.
 */

import { ProductGuide } from './components/ProductGuide';
import { platformGuide } from './guides/platform';

export function PlatformDocsPage() {
  return <ProductGuide data={platformGuide} />;
}
