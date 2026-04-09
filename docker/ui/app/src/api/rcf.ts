import { apiRequest } from './client';
import type { RcfEntry, RcfCreate, RcfUpdate } from '../types/rcf';

export interface RcfListResponse {
  items: RcfEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface RcfListParams {
  customer_id?: number;
  search?: string;
  enabled?: boolean;
  limit?: number;
  offset?: number;
}

export async function listRcf(params: RcfListParams = {}): Promise<RcfListResponse> {
  const query = new URLSearchParams();
  if (params.customer_id !== undefined) query.set('customer_id', String(params.customer_id));
  if (params.search) query.set('search', params.search);
  if (params.enabled !== undefined) query.set('enabled', String(params.enabled));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.offset !== undefined) query.set('offset', String(params.offset));

  const qs = query.toString();
  return apiRequest('GET', `/rcf${qs ? `?${qs}` : ''}`);
}

export async function getRcfEntry(id: number): Promise<RcfEntry> {
  return apiRequest('GET', `/rcf/${id}`);
}

export async function createRcfEntry(data: RcfCreate): Promise<RcfEntry> {
  return apiRequest('POST', '/rcf', data);
}

export async function updateRcfEntry(id: number, data: RcfUpdate): Promise<RcfEntry> {
  return apiRequest('PATCH', `/rcf/${id}`, data);
}

export async function deleteRcfEntry(id: number): Promise<void> {
  return apiRequest('DELETE', `/rcf/${id}`);
}
