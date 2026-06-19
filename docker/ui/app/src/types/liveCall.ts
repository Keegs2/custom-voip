/**
 * Live (in-progress) calls and the in-dialog control plane.
 *
 * `GET /calls/live` is tenant-scoped and may be empty. When the FreeSWITCH ESL
 * bridge is unreachable the API returns `esl_connected: false` so the UI can show
 * a "control plane offline" state instead of an empty table.
 *
 * Control is `POST /calls/{uuid}/update` with a discriminated action body, which
 * resolves to `{ ok, confirmed }` — `confirmed` is true once FreeSWITCH emits the
 * matching event (hangup/transfer/redirect/dtmf), false on a fire-and-forget.
 */
export type CallDirection = 'inbound' | 'outbound';

export interface LiveCall {
  uuid: string;
  customer_id: number;
  caller: string;
  dest: string;
  direction: CallDirection;
  state: string;
  answered_at: string | null;
}

export interface LiveCallsResponse {
  calls: LiveCall[];
  esl_connected?: boolean;
}

export type CallAction = 'hangup' | 'transfer' | 'redirect' | 'dtmf';

export interface CallUpdateRequest {
  action: CallAction;
  /** transfer destination number (action=transfer) */
  destination?: string;
  /** programmable-voice TwiML URL to redirect to (action=redirect) */
  voice_url?: string;
  /** DTMF digits to play in-band (action=dtmf) */
  digits?: string;
}

export interface CallUpdateResponse {
  ok: boolean;
  confirmed: boolean;
}
