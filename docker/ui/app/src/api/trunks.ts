import { apiRequest } from './client';
import type { Trunk, TrunkCreate, TrunkIp, TrunkDid, TrunkStats, CallPathPackage } from '../types/trunk';

export interface TrunksListParams {
  customer_id?: number;
  search?: string;
  enabled?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * GET /trunks returns a plain Trunk[] array.
 * Normalised to a consistent shape for consumers.
 */
export interface TrunksListResponse {
  items: Trunk[];
  total: number;
}

export async function listTrunks(params: TrunksListParams = {}): Promise<TrunksListResponse> {
  const query = new URLSearchParams();
  if (params.customer_id !== undefined) query.set('customer_id', String(params.customer_id));
  if (params.search) query.set('search', params.search);
  if (params.enabled !== undefined) query.set('enabled', String(params.enabled));
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.offset !== undefined) query.set('offset', String(params.offset));

  const qs = query.toString();
  const raw = await apiRequest<Trunk[] | TrunksListResponse>('GET', `/trunks${qs ? `?${qs}` : ''}`);
  if (Array.isArray(raw)) {
    return { items: raw, total: raw.length };
  }
  return {
    items: (raw as TrunksListResponse).items ?? [],
    total: (raw as TrunksListResponse).total ?? (raw as TrunksListResponse).items?.length ?? 0,
  };
}

export async function getTrunk(id: number): Promise<Trunk> {
  return apiRequest('GET', `/trunks/${id}`);
}

export async function createTrunk(data: TrunkCreate): Promise<Trunk> {
  return apiRequest('POST', '/trunks', data);
}

export async function updateTrunk(id: number, data: Partial<TrunkCreate>): Promise<Trunk> {
  return apiRequest('PATCH', `/trunks/${id}`, data);
}

export async function deleteTrunk(id: number): Promise<void> {
  return apiRequest('DELETE', `/trunks/${id}`);
}

export async function getTrunkIps(trunkId: number): Promise<TrunkIp[]> {
  return apiRequest('GET', `/trunks/${trunkId}/ips`);
}

export async function addTrunkIp(trunkId: number, ip_address: string, description?: string): Promise<TrunkIp> {
  return apiRequest('POST', `/trunks/${trunkId}/ips`, { ip_address, description });
}

export async function deleteTrunkIp(trunkId: number, ipId: number): Promise<void> {
  return apiRequest('DELETE', `/trunks/${trunkId}/ips/${ipId}`);
}

export async function getTrunkDids(trunkId: number): Promise<TrunkDid[]> {
  return apiRequest('GET', `/trunks/${trunkId}/dids`);
}

export async function getTrunkStats(trunkId: number): Promise<TrunkStats> {
  return apiRequest('GET', `/trunks/${trunkId}/stats`);
}

export async function listCallPathPackages(): Promise<CallPathPackage[]> {
  return apiRequest('GET', '/trunks/packages');
}

export interface CallPathEntry {
  id: number;
  name: string;
  call_paths?: number | null;
  paths?: number | null;
  monthly_fee: number;
  description?: string | null;
}

export async function listCallPaths(): Promise<CallPathEntry[]> {
  return apiRequest('GET', '/trunks/call-paths');
}
