import { apiRequest } from './client';
import type {
  ProgrammableDid,
  ProgrammableDidUpdate,
  WebhookSecret,
} from '../types/programmableVoice';

export interface ProgrammableDidsListParams {
  customer_id?: number;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ProgrammableDidsListResponse {
  items: ProgrammableDid[];
  total: number;
}

/** GET /api-dids — programmable DIDs (voice_url / fallback_url). Tenant-scoped. */
export async function listProgrammableDids(
  params: ProgrammableDidsListParams = {},
): Promise<ProgrammableDidsListResponse> {
  const query = new URLSearchParams();
  if (params.customer_id !== undefined) query.set('customer_id', String(params.customer_id));
  if (params.search) query.set('search', params.search);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.offset !== undefined) query.set('offset', String(params.offset));

  const qs = query.toString();
  const raw = await apiRequest<ProgrammableDid[] | ProgrammableDidsListResponse>(
    'GET',
    `/api-dids${qs ? `?${qs}` : ''}`,
  );
  if (Array.isArray(raw)) {
    return { items: raw, total: raw.length };
  }
  return {
    items: raw.items ?? [],
    total: raw.total ?? raw.items?.length ?? 0,
  };
}

/** PUT /api-dids/{id} — update voice_url / fallback_url / enabled for a DID. */
export async function updateProgrammableDid(
  id: number,
  data: ProgrammableDidUpdate,
): Promise<ProgrammableDid> {
  return apiRequest('PUT', `/api-dids/${id}`, data);
}

/** GET /customers/{id}/webhook-secret — current signing secret (admin-scoped). */
export async function getWebhookSecret(customerId: number): Promise<WebhookSecret> {
  return apiRequest('GET', `/customers/${customerId}/webhook-secret`);
}

/** POST /customers/{id}/webhook-secret/rotate — mint a new signing secret. */
export async function rotateWebhookSecret(customerId: number): Promise<WebhookSecret> {
  return apiRequest('POST', `/customers/${customerId}/webhook-secret/rotate`);
}
