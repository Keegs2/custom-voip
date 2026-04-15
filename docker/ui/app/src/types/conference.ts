export interface Conference {
  id: number;
  customer_id: number;
  name: string;
  room_number: string;
  pin: string | null;
  moderator_pin: string | null;
  max_members: number;
  recording_enabled: boolean;
  video_enabled: boolean;
  status: string;
  created_at: string;
  // Only present when fetched via GET /conferences/{id} (detail endpoint).
  // The list endpoint (GET /conferences) does not include this field.
  participants?: ConferenceParticipant[];
}

export interface ConferenceParticipant {
  user_id: number;
  // API returns this as user_name (joined from the users table)
  user_name: string | null;
  user_email: string | null;
  extension: string | null;
  role: 'moderator' | 'participant';
}

export interface ConferenceLiveStatus {
  is_active: boolean;
  members: LiveMember[];
  recording: boolean;
}

export interface LiveMember {
  id: number;
  name: string;
  /** The raw caller-ID number from FreeSWITCH (e.g. "100"). Use this field
   *  to identify the local user's tile — `name` is a display name that will
   *  NOT match `credentials.extension`. */
  caller_id_number: string;
  talking: boolean;
  muted: boolean;
  video: boolean;
}

export interface ConferenceSchedule {
  id: number;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string;
}

export interface CreateConferencePayload {
  name: string;
  customer_id?: number;
  max_members?: number;
  recording_enabled?: boolean;
  video_enabled?: boolean;
  pin?: string | null;
  moderator_pin?: string | null;
}

export interface UpdateConferencePayload {
  name?: string;
  max_members?: number;
  recording_enabled?: boolean;
  video_enabled?: boolean;
  pin?: string | null;
  moderator_pin?: string | null;
}

export interface CreateSchedulePayload {
  title: string;
  description?: string | null;
  start_time: string;
  end_time: string;
}

export interface ConferenceJoinInfo {
  dial_code: string;
  pin: string | null;
  room_number: string;
}
