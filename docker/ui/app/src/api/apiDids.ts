import { apiRequest } from './client';
import type { ApiDid, ApiDidCreate, ApiDidUpdate } from '../types/apiDid';

export interface ApiDidsListParams {
  customer_id?: number;
  search?: string;
  enabled?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * GET /api-dids returns a plain ApiDid[] array.
 * Normalised to a consistent shape for consumers.
 */
export interface ApiDidsListResponse {
  items: ApiDid[];
  total: number;
}

export async function listApiDids(params: ApiDidsListParams = {}): Promise<ApiDidsListResponse> {
  const query = new URLSearchParams();
  if (params.customer_id !== undefined) query.set('customer_id', String(params.customer_id));
  if (params.search) query.set('search', params.search);
  if (params.enabled !== undefined) query.set('enabled', String(params.enabled));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.offset !== undefined) query.set('offset', String(params.offset));

  const qs = query.toString();
  const raw = await apiRequest<ApiDid[] | ApiDidsListResponse>('GET', `/api-dids${qs ? `?${qs}` : ''}`);
  if (Array.isArray(raw)) {
    return { items: raw, total: raw.length };
  }
  return {
    items: (raw as ApiDidsListResponse).items ?? [],
    total: (raw as ApiDidsListResponse).total ?? (raw as ApiDidsListResponse).items?.length ?? 0,
  };
}

export async function getApiDid(id: number): Promise<ApiDid> {
  return apiRequest('GET', `/api-dids/${id}`);
}

export async function createApiDid(data: ApiDidCreate): Promise<ApiDid> {
  return apiRequest('POST', '/api-dids', data);
}

export async function updateApiDid(id: number, data: ApiDidUpdate): Promise<ApiDid> {
  return apiRequest('PATCH', `/api-dids/${id}`, data);
}

export async function deleteApiDid(id: number): Promise<void> {
  return apiRequest('DELETE', `/api-dids/${id}`);
}
