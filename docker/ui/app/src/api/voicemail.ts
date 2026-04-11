import { apiRequest } from './client';
import type { VoicemailMessage } from '../types/softphone';

export interface VoicemailListParams {
  extension_id?: number;
  unread_only?: boolean;
  limit?: number;
  offset?: number;
}

export interface VoicemailListResult {
  items: VoicemailMessage[];
  total: number;
  unread_count: number;
}

/**
 * List voicemail messages for the current user's extension.
 */
export async function listVoicemails(params: VoicemailListParams = {}): Promise<VoicemailListResult> {
  const query = new URLSearchParams();
  if (params.extension_id !== undefined) query.set('extension_id', String(params.extension_id));
  if (params.unread_only) query.set('unread_only', 'true');
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.offset !== undefined) query.set('offset', String(params.offset));
  const qs = query.toString();
  return apiRequest<VoicemailListResult>('GET', `/voicemail${qs ? `?${qs}` : ''}`);
}

/**
 * Fetch a single voicemail message by ID.
 */
export async function getVoicemail(id: number): Promise<VoicemailMessage> {
  return apiRequest<VoicemailMessage>('GET', `/voicemail/${id}`);
}

/**
 * Delete a voicemail message.
 */
export async function deleteVoicemail(id: number): Promise<void> {
  return apiRequest<void>('DELETE', `/voicemail/${id}`);
}

/**
 * Mark a voicemail message as read.
 */
export async function markVoicemailRead(id: number): Promise<VoicemailMessage> {
  return apiRequest<VoicemailMessage>('PATCH', `/voicemail/${id}/read`);
}

/**
 * Get unread voicemail count for the current user's extension.
 * Used to display the badge in the sidebar nav.
 */
export async function getUnreadCount(extensionId?: number): Promise<number> {
  const query = new URLSearchParams();
  query.set('unread_only', 'true');
  if (extensionId !== undefined) query.set('extension_id', String(extensionId));
  try {
    const result = await apiRequest<{ unread_count: number }>('GET', `/voicemail/count?${query.toString()}`);
    return result.unread_count;
  } catch {
    return 0;
  }
}
