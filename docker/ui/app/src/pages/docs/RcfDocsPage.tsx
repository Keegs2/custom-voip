/**
 * Remote Call Forwarding — public product guide (route `/docs/rcf`).
 *
 * THIN page: hands the RCF guide content to the universal <ProductGuide>, which
 * renders the shared plain-English → who → what → how → getting-started →
 * "for developers" accordion structure. Content lives in `guides/rcf.tsx`.
 * Public (outside RequireAuth), inside AppLayout — no top padding.
 */

import { ProductGuide } from './components/ProductGuide';
import { rcfGuide } from './guides/rcf';

export function RcfDocsPage() {
  return <ProductGuide data={rcfGuide} />;
}
