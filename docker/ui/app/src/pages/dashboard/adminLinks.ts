/**
 * adminLinks.ts — where the admin dashboard's links go, in one place.
 *
 * Every staff page that is about "one customer" takes the same
 * `?customer=<id>` query param (`?customer=all` where All customers is a
 * choice). The dashboard and the /rcf console read it today; Calls &
 * Quality and Reporting still open on their own picker, so the link copy
 * says so. When one of them starts reading the param, flip its flag below —
 * the hrefs already carry it and the copy follows the flag.
 */

/** Pages that pre-select the customer from `?customer=`. */
export const READS_CUSTOMER_PARAM = {
  dashboard: true,
  rcfConsole: true,
  calls: true,
  reporting: true,
} as const;

export type CustomerScopeParam = number | 'all';

function withCustomer(path: string, scope: CustomerScopeParam | null): string {
  if (scope === null) return path;
  return `${path}?customer=${encodeURIComponent(String(scope))}`;
}

/** The admin dashboard, scoped (null / 'all' = All customers). */
export function dashboardHref(scope: CustomerScopeParam | null): string {
  return scope === null || scope === 'all' ? '/dashboard' : withCustomer('/dashboard', scope);
}

/** The Administrative Call Forwarding Console, scoped. */
export function rcfConsoleHref(scope: CustomerScopeParam): string {
  return withCustomer('/rcf', scope);
}

/** The admin Visual Voicemail console, scoped (`/voicemail?customer=<id>`). */
export function voicemailConsoleHref(scope: CustomerScopeParam): string {
  return withCustomer('/voicemail', scope);
}

/** Calls & Quality (staff route). */
export function callsHref(customerId: number | null): string {
  return withCustomer('/cdrs', customerId);
}

/** Reporting (one customer per report). */
export function reportingHref(customerId: number | null): string {
  return withCustomer('/reporting', customerId);
}

export const TROUBLESHOOTING_HREF = '/troubleshooting';

/**
 * Reads `?customer=` — absent / unparseable → 'all'. Positive integers only,
 * so a hand-edited URL can't ask the API for customer 0 or NaN.
 */
export function parseCustomerParam(raw: string | null): CustomerScopeParam {
  if (!raw || raw === 'all') return 'all';
  if (!/^\d{1,9}$/.test(raw)) return 'all';
  const id = Number(raw);
  return id > 0 ? id : 'all';
}
