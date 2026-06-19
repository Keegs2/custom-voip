import { apiRequest } from './client';
import type { QueuesResponse, QueueDetail } from '../types/queue';

/** GET /queues — tenant-scoped queue depths. May be empty when ESL is down. */
export async function listQueues(): Promise<QueuesResponse> {
  const raw = await apiRequest<QueuesResponse>('GET', '/queues');
  return {
    queues: raw.queues ?? [],
    esl_connected: raw.esl_connected,
  };
}

/** GET /queues/{name} — waiting members for a single queue. */
export async function getQueue(name: string): Promise<QueueDetail> {
  const raw = await apiRequest<QueueDetail>('GET', `/queues/${encodeURIComponent(name)}`);
  return {
    name: raw.name,
    depth: raw.depth ?? 0,
    members: raw.members ?? [],
    esl_connected: raw.esl_connected,
  };
}
