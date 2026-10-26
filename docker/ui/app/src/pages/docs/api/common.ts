/**
 * Shared pieces of the API Reference content: the base URL placeholder,
 * the status-code lines every endpoint repeats, and the curl prelude.
 * Data only (no components) — see types.ts for the truth contract.
 */
import type { StatusDoc } from './types';

/** The base URL as customers see it — a placeholder, never a real host. */
export const BASE_URL = 'https://<your portal host>/api/v1';

/** Every authenticated route (JWT middleware, middleware/auth.py). */
export const S401: StatusDoc = { code: 401, when: 'The token is missing, invalid or expired — sign in again.' };

/** Tenant-scoped by-id routes answer 404 for anything that isn’t yours. */
export const notFound = (what: string): StatusDoc => ({
  code: 404,
  when: `${what} doesn’t exist or isn’t on your account.`,
});

export const ok = (when = 'Success.'): StatusDoc => ({ code: 200, when });

export const S403_EDIT: StatusDoc = {
  code: 403,
  when: 'Your role can’t make this change (read-only users can only read).',
};

export const S422: StatusDoc = { code: 422, when: 'A parameter or body field is missing or invalid — see `detail`.' };

export const S503: StatusDoc = {
  code: 503,
  when: 'Briefly unavailable, or the query ran too long — retry shortly (honour `Retry-After` when present).',
};

/** The two lines every curl example starts from (defined in Getting started). */
export const AUTH_HEADER = '-H "Authorization: Bearer $TOKEN"';
