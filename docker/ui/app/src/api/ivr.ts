import { apiRequest } from './client';
import type { IvrFlow, IvrFlowListItem, IvrFlowSave } from '../types/ivr';

export async function listIvrFlows(): Promise<IvrFlowListItem[]> {
  return apiRequest('GET', '/ivr');
}

export async function getIvrFlow(id: number): Promise<IvrFlow> {
  return apiRequest('GET', `/ivr/${id}`);
}

export async function createIvrFlow(data: IvrFlowSave): Promise<IvrFlow> {
  return apiRequest('POST', '/ivr', data);
}

export async function updateIvrFlow(id: number, data: IvrFlowSave): Promise<IvrFlow> {
  return apiRequest('PUT', `/ivr/${id}`, data);
}

export async function deleteIvrFlow(id: number): Promise<void> {
  return apiRequest('DELETE', `/ivr/${id}`);
}
