import { apiRequest } from './client';
import type { Rate, RateCreate, RateUpdate, RatesResponse, MarginsData } from '../types/rate';

export interface RatesListParams {
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listRates(params: RatesListParams = {}): Promise<RatesResponse> {
  const query = new URLSearchParams();
  if (params.search) query.set('search', params.search);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.offset !== undefined) query.set('offset', String(params.offset));

  const qs = query.toString();
  return apiRequest('GET', `/rates${qs ? `?${qs}` : ''}`);
}

export async function getRate(id: number): Promise<Rate> {
  return apiRequest('GET', `/rates/${id}`);
}

export async function createRate(data: RateCreate): Promise<Rate> {
  return apiRequest('POST', '/rates', data);
}

export async function updateRate(id: number, data: RateUpdate): Promise<Rate> {
  return apiRequest('PATCH', `/rates/${id}`, data);
}

export async function deleteRate(id: number): Promise<void> {
  return apiRequest('DELETE', `/rates/${id}`);
}

export async function getMarginsData(): Promise<MarginsData> {
  return apiRequest('GET', '/rates/margins');
}

export async function lookupRate(destination: string): Promise<Rate | null> {
  return apiRequest('GET', `/rates/lookup?destination=${encodeURIComponent(destination)}`);
}
