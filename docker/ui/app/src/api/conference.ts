import { apiRequest } from './client';
import type {
  Conference,
  ConferenceLiveStatus,
  ConferenceSchedule,
  ConferenceJoinInfo,
  CreateConferencePayload,
  UpdateConferencePayload,
  CreateSchedulePayload,
} from '../types/conference';

/** List all conference rooms for the current customer */
export function listConferences(): Promise<Conference[]> {
  return apiRequest<Conference[]>('GET', '/conferences');
}

/** Create a new conference room */
export function createConference(payload: CreateConferencePayload): Promise<Conference> {
  return apiRequest<Conference>('POST', '/conferences', payload);
}

/** Get a single conference by ID, including participants */
export function getConference(id: number): Promise<Conference> {
  return apiRequest<Conference>('GET', `/conferences/${id}`);
}

/** Update conference settings */
export function updateConference(id: number, payload: UpdateConferencePayload): Promise<Conference> {
  return apiRequest<Conference>('PUT', `/conferences/${id}`, payload);
}

/** Delete a conference room */
export function deleteConference(id: number): Promise<void> {
  return apiRequest<void>('DELETE', `/conferences/${id}`);
}

/** Get real-time live status: who is currently in the room */
export function getConferenceLiveStatus(id: number): Promise<ConferenceLiveStatus> {
  return apiRequest<ConferenceLiveStatus>('GET', `/conferences/${id}/live`);
}

/** Get dial-in info (dial code, PIN) for external participants */
export function getConferenceJoinInfo(id: number): Promise<ConferenceJoinInfo> {
  return apiRequest<ConferenceJoinInfo>('GET', `/conferences/${id}/join`);
}

/** Kick a member from a live conference */
export function kickMember(conferenceId: number, memberId: number): Promise<void> {
  return apiRequest<void>('POST', `/conferences/${conferenceId}/kick/${memberId}`);
}

/** Mute or unmute a member in a live conference */
export function muteMember(conferenceId: number, memberId: number): Promise<void> {
  return apiRequest<void>('POST', `/conferences/${conferenceId}/mute/${memberId}`);
}

/** List scheduled sessions for a conference */
export function listSchedules(conferenceId: number): Promise<ConferenceSchedule[]> {
  return apiRequest<ConferenceSchedule[]>('GET', `/conferences/${conferenceId}/schedule`);
}

/** Schedule a new session for a conference */
export function createSchedule(
  conferenceId: number,
  payload: CreateSchedulePayload,
): Promise<ConferenceSchedule> {
  return apiRequest<ConferenceSchedule>('POST', `/conferences/${conferenceId}/schedule`, payload);
}

/** Delete a scheduled session */
export function deleteSchedule(conferenceId: number, scheduleId: number): Promise<void> {
  return apiRequest<void>('DELETE', `/conferences/${conferenceId}/schedule/${scheduleId}`);
}
