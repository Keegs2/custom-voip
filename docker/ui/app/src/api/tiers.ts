import { apiRequest } from './client';
import type { Tier, CustomerTierResponse } from '../types/tier';

export async function listTiers(): Promise<Tier[]> {
  return apiRequest('GET', '/tiers');
}

export async function listTrunkTiers(): Promise<Tier[]> {
  return apiRequest('GET', '/tiers/trunk');
}

export async function listApiTiers(): Promise<Tier[]> {
  return apiRequest('GET', '/tiers/api');
}

export async function getTier(id: number): Promise<Tier> {
  return apiRequest('GET', `/tiers/${id}`);
}

export async function createTier(data: Omit<Tier, 'id'>): Promise<Tier> {
  return apiRequest('POST', '/tiers', data);
}

export async function updateTier(id: number, data: Partial<Omit<Tier, 'id'>>): Promise<Tier> {
  return apiRequest('PATCH', `/tiers/${id}`, data);
}

export async function deleteTier(id: number): Promise<void> {
  return apiRequest('DELETE', `/tiers/${id}`);
}

export async function getCustomerTier(customerId: number): Promise<CustomerTierResponse | null> {
  try {
    return await apiRequest('GET', `/customers/${customerId}/tier`);
  } catch {
    // Endpoint may not exist yet — return null instead of crashing
    return null;
  }
}

export async function assignCustomerTier(customerId: number, tierId: number): Promise<CustomerTierResponse> {
  return apiRequest('PUT', `/customers/${customerId}/tier`, { tier_id: tierId });
}

export async function removeCustomerTier(customerId: number): Promise<void> {
  return apiRequest('DELETE', `/customers/${customerId}/tier`);
}
