import { apiRequest } from './client';
import type { PresenceStatus } from '../types/softphone';

export interface PresenceRecord {
  extension_id: number;
  extension: string;
  status: PresenceStatus;
  updated_at: string;
}

/**
 * Get presence for a specific extension.
 */
export async function getPresence(extensionId: number): Promise<PresenceRecord> {
  return apiRequest<PresenceRecord>('GET', `/extensions/${extensionId}/presence`);
}

/**
 * Update the authenticated user's presence status.
 */
export async function updatePresence(extensionId: number, status: PresenceStatus): Promise<PresenceRecord> {
  return apiRequest<PresenceRecord>('PUT', `/extensions/${extensionId}/presence`, { status });
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
  return Object.fromEntries(records.map((r) => [r.extension_id, r.status]));
}
