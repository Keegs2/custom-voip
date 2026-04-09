import { apiRequest } from './client';
import type { IvrFlow, IvrFlowListItem, IvrFlowSave } from '../types/ivr';

export async function listIvrFlows(): Promise<IvrFlowListItem[]> {
  return apiRequest('GET', '/ivr/flows');
}

export async function getIvrFlow(id: number): Promise<IvrFlow> {
  return apiRequest('GET', `/ivr/flows/${id}`);
}

export async function createIvrFlow(data: IvrFlowSave): Promise<IvrFlow> {
  return apiRequest('POST', '/ivr/flows', data);
}

export async function updateIvrFlow(id: number, data: IvrFlowSave): Promise<IvrFlow> {
  return apiRequest('PUT', `/ivr/flows/${id}`, data);
}

export async function deleteIvrFlow(id: number): Promise<void> {
  return apiRequest('DELETE', `/ivr/flows/${id}`);
}
