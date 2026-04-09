import { apiRequest } from './client';
import type { Customer, CustomerCreate, CustomerUpdate } from '../types/customer';

export interface CustomersListResponse {
  items: Customer[];
  total: number;
  limit: number;
  offset: number;
}

export interface CustomersListParams {
  search?: string;
  status?: string;
  account_type?: string;
  limit?: number;
  offset?: number;
}

export async function listCustomers(params: CustomersListParams = {}): Promise<CustomersListResponse> {
  const query = new URLSearchParams();
  if (params.search) query.set('search', params.search);
  if (params.status) query.set('status', params.status);
  if (params.account_type) query.set('account_type', params.account_type);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.offset !== undefined) query.set('offset', String(params.offset));

  const qs = query.toString();
  return apiRequest('GET', `/customers${qs ? `?${qs}` : ''}`);
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
