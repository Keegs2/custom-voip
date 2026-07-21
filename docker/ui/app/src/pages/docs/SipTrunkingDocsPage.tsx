/**
 * SIP Trunking — public product guide (route `/docs/sip-trunking`).
 * Content lives in `guides/sipTrunking.tsx`. Public (outside RequireAuth),
 * inside AppLayout — no top padding.
 */

import { ProductGuide } from './components/ProductGuide';
import { sipTrunkingGuide } from './guides/sipTrunking';

export function SipTrunkingDocsPage() {
  return <ProductGuide data={sipTrunkingGuide} />;
}
