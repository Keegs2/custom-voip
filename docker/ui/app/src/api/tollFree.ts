/**
 * Toll-Free / RespOrg API client (`/toll-free`). Reads are tenant-scoped;
 * provisioning (import / reassign / update / cr-submit) is admin-only server-side.
 */

import { apiRequest } from './client';
import type {
  Tfn,
  TfnDetail,
  TfnListResponse,
  TfnStats,
  TfnImportBatch,
  TfnImportRequest,
  ReassignCarrierRequest,
  ReassignCarrierResult,
  TfnUpdate,
  TfnCrStatus,
  TfnCrSubmitResult,
} from '../types/tollFree';

export interface ListTfnParams {
  status?: string;
  cr_status?: string;
  resp_org_id?: string;
  carrier_id?: number;
  customer_id?: number;
  search?: string;
  limit?: number;
  offset?: number;
}

/** GET /toll-free — searchable, paginated (server-side). */
export async function listTfns(params: ListTfnParams = {}): Promise<TfnListResponse> {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.cr_status) qs.set('cr_status', params.cr_status);
  if (params.resp_org_id) qs.set('resp_org_id', params.resp_org_id);
  if (params.carrier_id !== undefined) qs.set('carrier_id', String(params.carrier_id));
  if (params.customer_id !== undefined) qs.set('customer_id', String(params.customer_id));
  if (params.search) qs.set('search', params.search);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const q = qs.toString();
  const raw = await apiRequest<TfnListResponse | Tfn[]>('GET', `/toll-free${q ? `?${q}` : ''}`);
  if (Array.isArray(raw)) return { items: raw, total: raw.length, limit: params.limit ?? raw.length, offset: params.offset ?? 0 };
  return raw;
}

export async function getTfnStats(customerId?: number): Promise<TfnStats> {
  const qs = new URLSearchParams();
  if (customerId !== undefined) qs.set('customer_id', String(customerId));
  const q = qs.toString();
  return apiRequest('GET', `/toll-free/stats${q ? `?${q}` : ''}`);
}

export async function getTfn(tfn: string): Promise<TfnDetail> {
  return apiRequest('GET', `/toll-free/${encodeURIComponent(tfn)}`);
}

export async function getTfnCrStatus(tfn: string): Promise<TfnCrStatus> {
  return apiRequest('GET', `/toll-free/${encodeURIComponent(tfn)}/cr-status`);
}

/** POST /toll-free/import — bulk import; returns the batch (poll for progress). */
export async function importTfns(body: TfnImportRequest): Promise<TfnImportBatch> {
  return apiRequest('POST', '/toll-free/import', body);
}

export async function getImportBatch(batchKey: string): Promise<TfnImportBatch> {
  return apiRequest('GET', `/toll-free/import/${encodeURIComponent(batchKey)}`);
}

/** POST /toll-free/reassign-carrier — bulk per-TFN inbound carrier steering. */
export async function reassignCarrier(body: ReassignCarrierRequest): Promise<ReassignCarrierResult> {
  return apiRequest('POST', '/toll-free/reassign-carrier', body);
}

export async function updateTfn(tfn: string, body: TfnUpdate): Promise<TfnDetail> {
  return apiRequest('PATCH', `/toll-free/${encodeURIComponent(tfn)}`, body);
}

/** POST /toll-free/{tfn}/cr-submit — records local CR intent (Somos default-off). */
export async function submitCr(tfn: string): Promise<TfnCrSubmitResult> {
  return apiRequest('POST', `/toll-free/${encodeURIComponent(tfn)}/cr-submit`);
}
