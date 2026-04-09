import { apiRequest } from './client';
import type { Customer, CustomerCreate, CustomerUpdate } from '../types/customer';

export interface CustomersListParams {
  search?: string;
  status?: string;
  account_type?: string;
  limit?: number;
  offset?: number;
}

/**
 * GET /customers returns a plain Customer[] array.
 * We normalise the response into a consistent shape so consumers
 * can always use { items, total }.
 */
export interface CustomersListResponse {
  items: Customer[];
  total: number;
}

export async function listCustomers(params: CustomersListParams = {}): Promise<CustomersListResponse> {
  const query = new URLSearchParams();
  if (params.search) query.set('search', params.search);
  if (params.status) query.set('status', params.status);
  if (params.account_type) query.set('account_type', params.account_type);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.offset !== undefined) query.set('offset', String(params.offset));

  const qs = query.toString();
  // The API returns a plain array; normalise to { items, total } for consumers.
  const raw = await apiRequest<Customer[] | CustomersListResponse>('GET', `/customers${qs ? `?${qs}` : ''}`);
  if (Array.isArray(raw)) {
    return { items: raw, total: raw.length };
  }
  // Already wrapped (future-proof)
  return {
    items: (raw as CustomersListResponse).items ?? [],
    total: (raw as CustomersListResponse).total ?? (raw as CustomersListResponse).items?.length ?? 0,
  };
}

export async function getCustomer(id: number): Promise<Customer> {
  return apiRequest('GET', `/customers/${id}`);
}

export async function createCustomer(data: CustomerCreate): Promise<Customer> {
  return apiRequest('POST', '/customers', data);
}

export async function updateCustomer(id: number, data: CustomerUpdate): Promise<Customer> {
  return apiRequest('PATCH', `/customers/${id}`, data);
}

export async function deleteCustomer(id: number): Promise<void> {
  return apiRequest('DELETE', `/customers/${id}`);
}
