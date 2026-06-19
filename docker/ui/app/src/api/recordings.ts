import { apiRequest } from './client';
import type { Recording, RecordingsListResponse } from '../types/recording';

export interface RecordingsListParams {
  kind?: string;
  call_uuid?: string;
  limit?: number;
  offset?: number;
}

/**
 * GET /recordings — tenant-scoped list. Normalised to a consistent
 * `{ recordings, total }` shape regardless of whether the API wraps the list.
 */
export async function listRecordings(
  params: RecordingsListParams = {},
): Promise<RecordingsListResponse> {
  const query = new URLSearchParams();
  if (params.kind) query.set('kind', params.kind);
  if (params.call_uuid) query.set('call_uuid', params.call_uuid);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.offset !== undefined) query.set('offset', String(params.offset));

  const qs = query.toString();
  const raw = await apiRequest<Recording[] | RecordingsListResponse>(
    'GET',
    `/recordings${qs ? `?${qs}` : ''}`,
  );
  if (Array.isArray(raw)) {
    return { recordings: raw, total: raw.length };
  }
  return {
    recordings: raw.recordings ?? [],
    total: raw.total ?? raw.recordings?.length ?? 0,
  };
}

export async function getRecording(id: number): Promise<Recording> {
  return apiRequest('GET', `/recordings/${id}`);
}

/**
 * Absolute href for a recording's audio. The endpoint replies 307 → presigned
 * object-store URL; the browser follows the redirect transparently, so this URL
 * can be used directly as an <audio src> or a download link.
 *
 * The Bearer token cannot ride a plain media element request, so the token is
 * carried as a query param the API also accepts for this read-only audio route.
 */
export function recordingAudioUrl(id: number): string {
  const token = localStorage.getItem('auth_token');
  const suffix = token ? `?token=${encodeURIComponent(token)}` : '';
  return `/api/recordings/${id}/audio${suffix}`;
}
