import { apiRequest } from './client';
import type { LiveConferencesResponse } from '../types/conferenceLive';

/** GET /conferences/live — every active FS conference room + live roster. */
export async function listLiveConferences(): Promise<LiveConferencesResponse> {
  const raw = await apiRequest<LiveConferencesResponse>('GET', '/conferences/live');
  return {
    esl_connected: raw.esl_connected ?? false,
    count: raw.count ?? raw.conferences?.length ?? 0,
    conferences: raw.conferences ?? [],
  };
}

/** POST /conferences/live/{room}/kick/{member_id} — eject a live member. */
export async function kickLiveMember(room: string, memberId: number): Promise<void> {
  return apiRequest<void>(
    'POST',
    `/conferences/live/${encodeURIComponent(room)}/kick/${memberId}`,
  );
}

/** POST /conferences/live/{room}/mute/{member_id} — toggle mute on a live member. */
export async function muteLiveMember(room: string, memberId: number): Promise<void> {
  return apiRequest<void>(
    'POST',
    `/conferences/live/${encodeURIComponent(room)}/mute/${memberId}`,
  );
}
