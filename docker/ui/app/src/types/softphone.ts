export type CallDirection = 'inbound' | 'outbound';

export type CallState =
  | 'idle'
  | 'dialing'
  | 'ringing'
  | 'early'
  | 'active'
  | 'held'
  | 'ended';

export type PresenceStatus = 'available' | 'busy' | 'away' | 'dnd' | 'offline';

export type SoftphoneConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'registered'
  | 'error';

export interface ActiveCall {
  id: string;
  direction: CallDirection;
  state: CallState;
  remoteNumber: string;
  remoteName: string;
  startTime: Date | null;
  duration: number;
  muted: boolean;
  held: boolean;
  /** True when this call was initiated with video enabled */
  isVideo: boolean;
  /** True when the local video track is a screen capture (not camera) */
  isScreenSharing: boolean;
}

export interface Extension {
  id: number;
  extension: string;
  user_id: number | null;
  customer_id: number;
  display_name: string;
  voicemail_enabled: boolean;
  dnd: boolean;
  status: string;
  presence_status?: PresenceStatus;
  user_name?: string;
  customer_name?: string;
  assigned_did?: string;  // E.164 format, e.g. "+17743260301"
}

export interface WebRTCCredentials {
  ws_url: string;
  login: string;
  password: string;
  display_name: string;
  extension: string;
  extension_id: number;
  ice_servers: RTCIceServer[];
}

export interface VoicemailMessage {
  id: number;
  caller_id: string;
  caller_name: string;
  duration_ms: number;
  is_read: boolean;
  created_at: string;
  audio_url?: string;
}

export interface CallHistoryEntry {
  uuid: string;
  direction: CallDirection;
  remote_number: string;
  remote_name: string;
  duration_seconds: number;
  hangup_cause: string;
  created_at: string;
}
