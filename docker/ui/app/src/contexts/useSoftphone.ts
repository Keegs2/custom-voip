/**
 * Softphone context object + consumer hook, split out of the provider file
 * (`SoftphoneContext.tsx`) so component files export ONLY components
 * (react-refresh/only-export-components — FRONTEND_GLASS_REFACTOR.md §5.3).
 * Import `useSoftphone` from here; the provider stays in `./SoftphoneContext`.
 */
import { createContext, useContext } from 'react';
import type {
  ActiveCall,
  PresenceStatus,
  SoftphoneConnectionState,
  WebRTCCredentials,
} from '../types/softphone';

export interface SoftphoneContextValue {
  /** Current WebSocket + SIP registration state */
  connectionState: SoftphoneConnectionState;
  /** The currently active (or ringing) call, if any */
  activeCall: ActiveCall | null;
  /** An incoming call awaiting answer/reject — separate from activeCall so UI
   *  can show the incoming banner while another call is ongoing */
  incomingCall: ActiveCall | null;
  /** The user's own presence status */
  presence: PresenceStatus;
  /** Whether the softphone widget is expanded */
  isExpanded: boolean;
  /** WebRTC credentials for the current user (null = no extension) */
  credentials: WebRTCCredentials | null;
  /** Unread voicemail count for badge display */
  unreadVoicemailCount: number;
  /** Audio input devices available */
  audioInputDevices: MediaDeviceInfo[];
  /** Audio output devices available */
  audioOutputDevices: MediaDeviceInfo[];
  /** Selected audio input device ID */
  selectedMicId: string | null;
  /** Selected audio output device ID */
  selectedSpeakerId: string | null;

  /* ── Video streams (null when audio-only call or no active call) ── */
  localVideoStream: MediaStream | null;
  remoteVideoStream: MediaStream | null;
  /**
   * Synchronous fallback to read the local stream directly from the VertoClient
   * session. Use this when localVideoStream in state is null but the call is
   * already active (e.g. ConferenceRoom mounts after onStreamChange fired).
   */
  getLocalStream: (callId: string) => MediaStream | null;

  /* ── Actions ── */
  makeCall: (destination: string, options?: { video?: boolean }) => Promise<void>;
  startScreenShare: () => Promise<void>;
  stopScreenShare: () => Promise<void>;
  setCameraEnabled: (enabled: boolean) => void;
  answerCall: () => Promise<void>;
  rejectCall: () => void;
  hangupCall: () => void;
  holdCall: () => void;
  unholdCall: () => void;
  muteCall: () => void;
  unmuteCall: () => void;
  sendDTMF: (digit: string) => void;
  setPresence: (status: PresenceStatus) => Promise<void>;
  setExpanded: (expanded: boolean) => void;
  selectMic: (deviceId: string) => void;
  selectSpeaker: (deviceId: string) => void;
  /** Force refresh of voicemail count (e.g. after viewing voicemails) */
  refreshVoicemailCount: () => void;
}

export const SoftphoneContext = createContext<SoftphoneContextValue | null>(null);

export function useSoftphone(): SoftphoneContextValue {
  const ctx = useContext(SoftphoneContext);
  if (!ctx) {
    throw new Error('useSoftphone must be used within a SoftphoneProvider');
  }
  return ctx;
}
