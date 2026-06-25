/**
 * Typed client for the generalized `call_flows` API. Paths are relative to the
 * `/api` base (apiRequest prepends it). List responses are normalised to
 * `{ items, total }` per the codebase convention (CLAUDE.md §5).
 *
 * Pinned contract (backend built in parallel):
 *   GET    /call-flows?product=&customer_id=  -> { items, total }
 *   POST   /call-flows                          -> CallFlow
 *   GET    /call-flows/{id}                     -> CallFlow
 *   PUT    /call-flows/{id}                     -> CallFlow
 *   POST   /call-flows/{id}/publish             -> CallFlow  (409 if live config
 *                                                  diverges and overwrite_existing
 *                                                  is not true)
 *   DELETE /call-flows/{id}                     -> void
 *
 * Version history (admin-only, built in parallel):
 *   GET    /call-flows/{id}/versions                  -> { items, total }
 *   GET    /call-flows/{id}/versions/{version}        -> FlowVersionDetail
 *   POST   /call-flows/{id}/versions/{version}/restore -> CallFlow (now draft)
 */
import { apiRequest } from './client';
import type {
  CallFlow,
  CallFlowCreate,
  CallFlowListParams,
  CallFlowPublish,
  CallFlowUpdate,
  FlowVersion,
  FlowVersionDetail,
  SimulateRequest,
  SimulateResult,
} from '../types/callFlow';

export interface CallFlowListResponse {
  items: CallFlow[];
  total: number;
}

export interface FlowVersionListResponse {
  items: FlowVersion[];
  total: number;
}

export async function listCallFlows(
  params: CallFlowListParams = {},
): Promise<CallFlowListResponse> {
  const query = new URLSearchParams();
  if (params.product) query.set('product', params.product);
  if (params.customer_id !== undefined) {
    query.set('customer_id', String(params.customer_id));
  }
  const qs = query.toString();
  const raw = await apiRequest<CallFlow[] | CallFlowListResponse>(
    'GET',
    `/call-flows${qs ? `?${qs}` : ''}`,
  );
  if (Array.isArray(raw)) {
    return { items: raw, total: raw.length };
  }
  return {
    items: raw.items ?? [],
    total: raw.total ?? raw.items?.length ?? 0,
  };
}

export async function getCallFlow(id: number): Promise<CallFlow> {
  return apiRequest('GET', `/call-flows/${id}`);
}

export async function createCallFlow(data: CallFlowCreate): Promise<CallFlow> {
  return apiRequest('POST', '/call-flows', data);
}

export async function updateCallFlow(
  id: number,
  data: CallFlowUpdate,
): Promise<CallFlow> {
  return apiRequest('PUT', `/call-flows/${id}`, data);
}

export async function publishCallFlow(
  id: number,
  data: CallFlowPublish,
): Promise<CallFlow> {
  return apiRequest('POST', `/call-flows/${id}/publish`, data);
}

export async function deleteCallFlow(id: number): Promise<void> {
  return apiRequest('DELETE', `/call-flows/${id}`);
}

/* ── Version history ──────────────────────────────────────────────────────── */

/** List a flow's published versions (newest first). Normalised to {items,total}. */
export async function listFlowVersions(
  id: number,
): Promise<FlowVersionListResponse> {
  const raw = await apiRequest<FlowVersion[] | FlowVersionListResponse>(
    'GET',
    `/call-flows/${id}/versions`,
  );
  if (Array.isArray(raw)) {
    return { items: raw, total: raw.length };
  }
  return {
    items: raw.items ?? [],
    total: raw.total ?? raw.items?.length ?? 0,
  };
}

/** Fetch a single version's full snapshot (flow_graph + compiled). */
export async function getFlowVersion(
  id: number,
  version: number,
): Promise<FlowVersionDetail> {
  return apiRequest('GET', `/call-flows/${id}/versions/${version}`);
}

/** Restore a version: backend clones it into a new draft and returns the flow. */
export async function restoreFlowVersion(
  id: number,
  version: number,
): Promise<CallFlow> {
  return apiRequest('POST', `/call-flows/${id}/versions/${version}/restore`);
}

/* ── Simulate ─────────────────────────────────────────────────────────────── */

/**
 * Dry-run the flow's stored `compiled` artifact against a synthetic inbound
 * call. Admin-only. The backend reads the last saved/published compiled
 * artifact, so a never-saved flow (or one whose compiled is stale) returns 404
 * — surface a "Save/Publish first" hint to the caller in that case.
 */
export async function simulateFlow(
  id: number,
  params: SimulateRequest = {},
): Promise<SimulateResult> {
  return apiRequest('POST', `/call-flows/${id}/simulate`, params);
}
