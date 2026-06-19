import { apiRequest } from './client';
import type {
  LiveCallsResponse,
  CallUpdateRequest,
  CallUpdateResponse,
} from '../types/liveCall';

/** GET /calls/live — tenant-scoped active calls. `esl_connected:false` when the
 *  FreeSWITCH control bridge is unreachable. */
export async function listLiveCalls(): Promise<LiveCallsResponse> {
  const raw = await apiRequest<LiveCallsResponse>('GET', '/calls/live');
  return {
    calls: raw.calls ?? [],
    esl_connected: raw.esl_connected,
  };
}

/** POST /calls/{uuid}/update — in-dialog control (hangup/transfer/redirect/dtmf). */
export async function updateCall(
  uuid: string,
  body: CallUpdateRequest,
): Promise<CallUpdateResponse> {
  return apiRequest<CallUpdateResponse>('POST', `/calls/${encodeURIComponent(uuid)}/update`, body);
}
