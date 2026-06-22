/**
 * Calendar Integration API client — Unified Comms (v1, read-only).
 *
 * Thin wrappers over `apiRequest` for the endpoints mounted under the
 * `/calendar` prefix (plan §2). All require a valid JWT (injected by
 * `apiRequest`) and operate on the authenticated user.
 */
import { apiRequest } from './client';
import type {
  Connection,
  ConnectUrlResponse,
  ListEventsParams,
  ListEventsResponse,
  CalendarProvider,
} from '../types/calendar';

/** `GET /calendar/connections` → the user's provider connections. */
export async function listConnections(): Promise<Connection[]> {
  return apiRequest<Connection[]>('GET', '/calendar/connections');
}

/**
 * `GET /calendar/connect/{provider}?return_to=<spa-path>` → `{ authorize_url }`.
 *
 * `returnTo` must be a relative SPA path starting with `/` (the backend applies
 * an open-redirect guard and defaults to `/calendar`). The caller then does
 * `window.location.assign(authorize_url)` to begin the OAuth dance.
 */
export async function getConnectUrl(
  provider: CalendarProvider,
  returnTo: string,
): Promise<ConnectUrlResponse> {
  const qs = new URLSearchParams({ return_to: returnTo });
  return apiRequest<ConnectUrlResponse>(
    'GET',
    `/calendar/connect/${provider}?${qs.toString()}`,
  );
}

/**
 * `DELETE /calendar/connections/{provider}` — best-effort revoke + row delete.
 *
 * The endpoint returns `200 { status, provider }`, but the body carries no
 * information the UI needs, so it is intentionally ignored here.
 */
export async function disconnect(provider: CalendarProvider): Promise<void> {
  await apiRequest<unknown>('DELETE', `/calendar/connections/${provider}`);
}

/**
 * `GET /calendar/events?start&end[&provider]` → `{ events, providers }`.
 *
 * One provider failing never fails the aggregate — partial failures surface
 * through `providers[].error` (e.g. "needs_reauth").
 */
export async function listEvents(
  params: ListEventsParams,
): Promise<ListEventsResponse> {
  const qs = new URLSearchParams({ start: params.start, end: params.end });
  if (params.provider) qs.set('provider', params.provider);
  return apiRequest<ListEventsResponse>('GET', `/calendar/events?${qs.toString()}`);
}
