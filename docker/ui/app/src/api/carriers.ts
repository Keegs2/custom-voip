import { apiRequest } from './client';
import type { Carrier, CarrierCreate, CarrierUpdate, CarrierTestResult } from '../types/carrier';

export async function listCarriers(): Promise<Carrier[]> {
  return apiRequest('GET', '/carriers');
}

export async function getCarrier(id: number): Promise<Carrier> {
  return apiRequest('GET', `/carriers/${id}`);
}

export async function createCarrier(data: CarrierCreate): Promise<Carrier> {
  return apiRequest('POST', '/carriers', data);
}

export async function updateCarrier(id: number, data: CarrierUpdate): Promise<Carrier> {
  return apiRequest('PATCH', `/carriers/${id}`, data);
}

export async function deleteCarrier(id: number): Promise<void> {
  return apiRequest('DELETE', `/carriers/${id}`);
}

export async function testCarrier(id: number): Promise<CarrierTestResult> {
  return apiRequest('POST', `/carriers/${id}/test`);
}
