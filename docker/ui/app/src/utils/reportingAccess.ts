import type { User } from '../types/auth';

/** Account types whose customers get the Reporting page. */
const REPORTING_ACCOUNT_TYPES: ReadonlyArray<NonNullable<User['account_type']>> = ['rcf', 'trunk', 'hybrid'];

/**
 * Who may open /reporting — the ONE rule shared by the sidebar entry and the
 * route guard so they can never disagree:
 * - admins (by real role — in customer-view mode too, since the API still
 *   treats them as staff and the page keeps the customer picker),
 * - customer users (role user / readonly) on an rcf, trunk or hybrid account.
 * Support staff never see it (a report is a customer-facing view).
 */
export function canSeeReporting(user: User | null): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'support') return false;
  return user.account_type != null && REPORTING_ACCOUNT_TYPES.includes(user.account_type);
}
