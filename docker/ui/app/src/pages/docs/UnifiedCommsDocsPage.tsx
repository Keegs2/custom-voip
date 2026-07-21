/**
 * Unified Communications — public product guide
 * (route `/docs/unified-communications`). Content lives in
 * `guides/unifiedComms.tsx`. Public (outside RequireAuth), inside AppLayout.
 */

import { ProductGuide } from './components/ProductGuide';
import { unifiedCommsGuide } from './guides/unifiedComms';

export function UnifiedCommsDocsPage() {
  return <ProductGuide data={unifiedCommsGuide} />;
}
