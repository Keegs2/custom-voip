import { apiRequest } from './client';
import type { ApiDid, ApiDidCreate, ApiDidUpdate } from '../types/apiDid';

export interface ApiDidsListResponse {
  items: ApiDid[];
  total: number;
  limit: number;
  offset: number;
}

export interface ApiDidsListParams {
  customer_id?: number;
  search?: string;
  enabled?: boolean;
  limit?: number;
  offset?: number;
}

export async function listApiDids(params: ApiDidsListParams = {}): Promise<ApiDidsListResponse> {
  const query = new URLSearchParams();
  if (params.customer_id !== undefined) query.set('customer_id', String(params.customer_id));
  if (params.search) query.set('search', params.search);
  if (params.enabled !== undefined) query.set('enabled', String(params.enabled));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.offset !== undefined) query.set('offset', String(params.offset));

  const qs = query.toString();
  return apiRequest('GET', `/api-dids${qs ? `?${qs}` : ''}`);
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
