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
  balance: number;
  credit_limit: number;
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
