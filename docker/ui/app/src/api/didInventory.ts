import { apiRequest } from './client';
import type {
  DidInventoryItem,
  DidInventoryListParams,
  DidInventoryListResponse,
  DidStats,
  DidAssignRequest,
  DidAvailableParams,
} from '../types/didInventory';

/**
 * GET /numbers/inventory
 * Admin endpoint — returns paginated full inventory with optional filters.
 */
export async function listDidInventory(
  params: DidInventoryListParams = {},
): Promise<DidInventoryListResponse> {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.state) qs.set('state', params.state);
  if (params.search) qs.set('search', params.search);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));

  const raw = await apiRequest<DidInventoryItem[] | DidInventoryListResponse>(
    'GET',
    `/numbers/inventory${qs.toString() ? `?${qs.toString()}` : ''}`,
  );

  if (Array.isArray(raw)) {
    return { items: raw, total: raw.length };
  }
  return {
    items: (raw as DidInventoryListResponse).items ?? [],
    total:
      (raw as DidInventoryListResponse).total ??
      (raw as DidInventoryListResponse).items?.length ??
      0,
  };
}

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
 * GET /numbers/stats
 * Admin endpoint — aggregate inventory stats (totals by status/product/state).
 */
export async function getDidStats(): Promise<DidStats> {
  return apiRequest<DidStats>('GET', '/numbers/stats');
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
 * POST /numbers/sync
 * Admin endpoint — triggers a sync of the number inventory from Bandwidth.
 */
export async function syncDidInventory(): Promise<{ synced: number; message: string }> {
  return apiRequest<{ synced: number; message: string }>('POST', '/numbers/sync');
}

/**
 * POST /numbers/{did}/assign
 * Admin endpoint — assigns a DID to a customer with a product type.
 */
export async function assignDid(
  did: string,
  data: DidAssignRequest,
): Promise<DidInventoryItem> {
  return apiRequest<DidInventoryItem>(
    'POST',
    `/numbers/${encodeURIComponent(did)}/assign`,
    data,
  );
}

/**
 * POST /numbers/{did}/unassign
 * Admin endpoint — removes a DID from its current customer assignment.
 */
export async function unassignDid(did: string): Promise<DidInventoryItem> {
  return apiRequest<DidInventoryItem>(
    'POST',
    `/numbers/${encodeURIComponent(did)}/unassign`,
  );
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
