/**
 * Billing & Payments — public product guide (route `/docs/billing`).
 * Content lives in `guides/billing.tsx`. Public (outside RequireAuth),
 * inside AppLayout — no top padding.
 */

import { ProductGuide } from './components/ProductGuide';
import { billingGuide } from './guides/billing';

export function BillingDocsPage() {
  return <ProductGuide data={billingGuide} />;
}
