import { apiRequest } from './client';
import type { PresenceStatus } from '../types/softphone';

export interface PresenceRecord {
  user_id: number;
  status: PresenceStatus;
  status_message: string | null;
  updated_at: string;
}

/**
 * Update the authenticated user's presence status.
 * Uses JWT auth — no extension ID needed in the URL.
 * status_message is omitted so the backend preserves any existing message.
 */
export async function updatePresence(status: PresenceStatus): Promise<PresenceRecord> {
  return apiRequest<PresenceRecord>('PUT', '/v1/presence', { status });
}

/**
 * Bulk-fetch presence for multiple extensions.
 * Returns a map of extensionId → PresenceStatus for efficient lookup.
 */
export async function getBulkPresence(extensionIds: number[]): Promise<Record<number, PresenceStatus>> {
  if (extensionIds.length === 0) return {};
  const query = new URLSearchParams();
  query.set('ids', extensionIds.join(','));
  const records = await apiRequest<PresenceRecord[]>('GET', `/extensions/presence?${query.toString()}`);
  return Object.fromEntries(records.map((r) => [r.user_id, r.status]));
}
