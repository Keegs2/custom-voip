import { apiRequest } from './client';
import type { HealthCheck, DetailedHealth } from '../types/health';

export async function getHealth(): Promise<HealthCheck> {
  return apiRequest('GET', '/health');
}

export async function getDetailedHealth(): Promise<DetailedHealth> {
  return apiRequest('GET', '/health/detailed');
}
