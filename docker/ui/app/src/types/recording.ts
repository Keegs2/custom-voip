/**
 * Call recordings (Phase 6 — media plane).
 *
 * Maps to the API's `recordings` table rows served tenant-scoped by
 * `GET /recordings`. Audio is fetched separately via the presigned-redirect
 * endpoint `GET /recordings/{id}/audio` (a 307 to a short-lived object-store URL
 * that can be used directly as an <audio src> / download href).
 */
export type RecordingKind = 'programmable' | 'call' | 'conference';

export interface Recording {
  id: number;
  customer_id: number;
  call_uuid: string | null;
  recording_uuid: string;
  object_key: string;
  duration_ms: number | null;
  kind: RecordingKind;
  created_at: string;
}

export interface RecordingsListResponse {
  recordings: Recording[];
  total?: number;
}
