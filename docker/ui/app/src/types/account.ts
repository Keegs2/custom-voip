import type { AccountType, CustomerStatus, TrafficGrade } from './customer';

/**
 * The authenticated customer's own account summary.
 * Maps 1:1 to `GET /customers/me`.
 *
 * `counts` gives a quick tally of each product the customer owns so the
 * overview can surface totals without fetching every product list.
 */
export interface MyCustomer {
  id: number;
  name: string;
  account_type: AccountType;
  status: CustomerStatus;
  traffic_grade: TrafficGrade;
  daily_limit: number | null;
  cpm_limit: number | null;
  ucaas_enabled: boolean | null;
  created_at: string;
  counts: {
    rcf: number;
    api_dids: number;
    trunks: number;
  };
}

/**
 * One line on a customer's estimated monthly bill.
 *
 * The platform does NOT do real billing — CDRs are exported to an external
 * rating/invoicing system (Equinox). This is a READ-ONLY estimate surfaced to
 * the customer, discriminated on `product` so each product renders its own way:
 *
 * - `rcf` / `voicemail` — a simple `qty × unit_price = subtotal` line.
 * - `trunk` / `api`     — a `subtotal` broken down into named `components`.
 */
export type BillingLineItem =
  | {
      product: 'rcf';
      label: string;
      qty: number;
      unit: 'line';
      unit_price: number;
      subtotal: number;
    }
  | {
      product: 'voicemail';
      label: string;
      qty: number;
      unit: 'mailbox';
      unit_price: number;
      subtotal: number;
    }
  | {
      product: 'trunk' | 'api';
      label: string;
      subtotal: number;
      components: Array<{ label: string; amount: number }>;
    };

/**
 * A customer's estimated monthly bill.
 * Maps 1:1 to `GET /customers/me/billing` (and admin `GET /customers/{id}/billing`).
 *
 * `total_monthly_estimate` is the sum of every line item's `subtotal`. The
 * `disclaimer` is authored server-side and must be shown verbatim — it makes
 * clear this is an estimate, not an invoice.
 */
export interface BillingEstimate {
  currency: 'USD';
  disclaimer: string;
  account_type: string;
  line_items: BillingLineItem[];
  total_monthly_estimate: number;
}

/** Role of a team member on the customer's account. */
export type TeamRole = 'admin' | 'user' | 'readonly';

/**
 * A user account associated with the authenticated customer's account.
 * Maps 1:1 to one element of `GET /auth/team`.
 *
 * `is_self` is set by the backend for the requesting user so the UI can mark
 * the current viewer without any client-side identity comparison.
 */
export interface TeamMember {
  id: number;
  email: string;
  name: string;
  role: TeamRole;
  status: string;
  created_at: string;
  last_login: string | null;
  is_self: boolean;
}
