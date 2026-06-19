/**
 * Platform-wide live conference monitoring (Phase 7).
 *
 * `GET /conferences/live` returns every active FreeSWITCH conference room across
 * the tenant with its live member roster. This is distinct from the per-room
 * `GET /conferences/{id}/live` used by the meeting-room manager — this view is
 * keyed by FS room name, and control acts on the live FS member id:
 *   POST /conferences/live/{room}/kick/{member_id}
 *   POST /conferences/live/{room}/mute/{member_id}
 */
export interface LiveConferenceMember {
  /** FreeSWITCH member id — the handle kick/mute act on */
  id: number;
  name?: string;
  caller_id_number?: string;
  caller_id_name?: string;
  uuid?: string;
  muted?: boolean;
  talking?: boolean;
  energy?: number;
  [key: string]: unknown;
}

export interface LiveConference {
  name: string;
  member_count: number;
  members: LiveConferenceMember[];
}

export interface LiveConferencesResponse {
  esl_connected: boolean;
  count: number;
  conferences: LiveConference[];
}
