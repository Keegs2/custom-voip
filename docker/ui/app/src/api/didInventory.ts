import { apiRequest } from './client';
import type {
  DidInventoryItem,
  DidAvailableParams,
} from '../types/didInventory';

/**
 * GET /numbers/available
 * Returns only available (unassigned) DIDs. Available to all authenticated users.
 */
export async function listAvailableDids(
  params: DidAvailableParams = {},
): Promise<DidInventoryItem[]> {
  const qs = new URLSearchParams();
  if (params.state) qs.set('state', params.state);
  if (params.search) qs.set('search', params.search);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));

  const raw = await apiRequest<DidInventoryItem[] | { items: DidInventoryItem[] }>(
    'GET',
    `/numbers/available${qs.toString() ? `?${qs.toString()}` : ''}`,
  );

  if (Array.isArray(raw)) return raw;
  return (raw as { items: DidInventoryItem[] }).items ?? [];
}

/**
 * GET /numbers/my
 * Customer endpoint — returns DIDs assigned to the calling user's customer account.
 */
export async function listMyDids(): Promise<DidInventoryItem[]> {
  const raw = await apiRequest<DidInventoryItem[] | { items: DidInventoryItem[] }>(
    'GET',
    '/numbers/my',
  );
  if (Array.isArray(raw)) return raw;
  return (raw as { items: DidInventoryItem[] }).items ?? [];
}

/**
 * POST /numbers/{did}/request
 * Customer endpoint — customer requests a specific available DID.
 */
export async function requestDid(
  did: string,
  notes?: string,
): Promise<DidInventoryItem> {
  return apiRequest<DidInventoryItem>(
    'POST',
    `/numbers/${encodeURIComponent(did)}/request`,
    notes !== undefined ? { notes } : undefined,
  );
}

/**
 * POST /numbers/{did}/request-release
 * Customer endpoint (admin also allowed) — requests release of an assigned DID.
 * Status transitions 'assigned' → 'release_requested'; an admin then approves
 * via unassignDid() or denies via cancelDidRelease().
 */
export async function requestDidRelease(
  did: string,
  notes?: string,
): Promise<DidInventoryItem> {
  return apiRequest<DidInventoryItem>(
    'POST',
    `/numbers/${encodeURIComponent(did)}/request-release`,
    notes !== undefined ? { notes } : undefined,
  );
}

/**
 * POST /numbers/{did}/cancel-release
 * Customer withdraw OR admin deny — 'release_requested' → back to 'assigned'.
 */
export async function cancelDidRelease(did: string): Promise<DidInventoryItem> {
  return apiRequest<DidInventoryItem>(
    'POST',
    `/numbers/${encodeURIComponent(did)}/cancel-release`,
  );
}
