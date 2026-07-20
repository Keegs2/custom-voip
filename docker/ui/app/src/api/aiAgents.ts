/**
 * AI Voice Agents API client. Endpoints are dual-mounted at `/v1/ai-agents` and
 * `/ai-agents`; we use the un-versioned prefix (nginx/Vite proxy `/api` → API).
 * JWT-required + tenant-scoped server-side (admins operate across customers).
 */

import { apiRequest } from './client';
import type {
  AiAgent,
  AiAgentCreate,
  AiAgentUpdate,
  AgentRuntimeConfig,
} from '../types/aiAgent';

export interface ListAiAgentsParams {
  customer_id?: number;
  enabled?: boolean;
  limit?: number;
  offset?: number;
}

/** GET /ai-agents — returns a plain array (newest first). */
export async function listAiAgents(params: ListAiAgentsParams = {}): Promise<AiAgent[]> {
  const qs = new URLSearchParams();
  if (params.customer_id !== undefined) qs.set('customer_id', String(params.customer_id));
  if (params.enabled !== undefined) qs.set('enabled', String(params.enabled));
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const q = qs.toString();
  return apiRequest('GET', `/ai-agents${q ? `?${q}` : ''}`);
}

export async function getAiAgent(id: number): Promise<AiAgent> {
  return apiRequest('GET', `/ai-agents/${id}`);
}

export async function createAiAgent(data: AiAgentCreate): Promise<AiAgent> {
  return apiRequest('POST', '/ai-agents', data);
}

export async function updateAiAgent(id: number, data: AiAgentUpdate): Promise<AiAgent> {
  return apiRequest('PATCH', `/ai-agents/${id}`, data);
}

export async function deleteAiAgent(id: number): Promise<void> {
  await apiRequest('DELETE', `/ai-agents/${id}`);
}

/** GET /ai-agents/{id}/runtime-config — the resolved view incl. the compliance flag. */
export async function getAgentRuntimeConfig(id: number): Promise<AgentRuntimeConfig> {
  return apiRequest('GET', `/ai-agents/${id}/runtime-config`);
}
