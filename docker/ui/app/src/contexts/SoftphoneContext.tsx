import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { VertoClient } from '../lib/verto';
import { getWebRTCCredentials } from '../api/webrtc';
import { updatePresence } from '../api/presence';
import { getUnreadCount } from '../api/voicemail';
import type {
  ActiveCall,
  CallState,
  PresenceStatus,
  SoftphoneConnectionState,
  WebRTCCredentials,
} from '../types/softphone';
import { useAuth } from './AuthContext';

/* ─── Context shape ──────────────────────────────────────── */

interface SoftphoneContextValue {
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

  /* ── Actions ── */
  makeCall: (destination: string) => Promise<void>;
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

const SoftphoneContext = createContext<SoftphoneContextValue | null>(null);

/* ─── Provider ───────────────────────────────────────────── */

export function SoftphoneProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, user } = useAuth();

  const [connectionState, setConnectionState] = useState<SoftphoneConnectionState>('disconnected');
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [incomingCall, setIncomingCall] = useState<ActiveCall | null>(null);
  const [presence, setPresenceState] = useState<PresenceStatus>('available');
  const [isExpanded, setIsExpanded] = useState(false);
  const [credentials, setCredentials] = useState<WebRTCCredentials | null>(null);
  const [unreadVoicemailCount, setUnreadVoicemailCount] = useState(0);
  const [audioInputDevices, setAudioInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputDevices, setAudioOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicId, setSelectedMicId] = useState<string | null>(null);
  const [selectedSpeakerId, setSelectedSpeakerId] = useState<string | null>(null);

  // Duration timer handle
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // VertoClient ref — not state because we never want re-renders from it
  const clientRef = useRef<VertoClient | null>(null);
  // Extension ID for presence updates
  const extensionIdRef = useRef<number | null>(null);
  // Ringtone audio
  const ringtoneRef = useRef<HTMLAudioElement | null>(null);

  /* ─── Duration timer ─────────────────────────────────────── */

  const startDurationTimer = useCallback((callId: string) => {
    stopDurationTimer();
    durationTimerRef.current = setInterval(() => {
      setActiveCall((prev) => {
        if (!prev || prev.id !== callId || !prev.startTime) return prev;
        const elapsed = Math.floor((Date.now() - prev.startTime.getTime()) / 1000);
        return { ...prev, duration: elapsed };
      });
    }, 1000);
  }, []);

  const stopDurationTimer = useCallback(() => {
    if (durationTimerRef.current !== null) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
  }, []);

  /* ─── Ringtone helpers ───────────────────────────────────── */

  const startRingtone = useCallback(() => {
    // Use the Web Audio API to synthesize a simple ring rather than
    // requiring a bundled audio asset. This avoids deployment issues.
    stopRingtone();
    try {
      const audioCtx = new AudioContext();
      let isPlaying = true;

      const ring = () => {
        if (!isPlaying) return;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.frequency.setValueAtTime(480, audioCtx.currentTime);
        osc.frequency.setValueAtTime(440, audioCtx.currentTime + 0.5);
        gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 1.0);
        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 1.0);
        if (isPlaying) {
          setTimeout(ring, 2000);
        }
      };

      ring();

      // Store a pseudo-element with a stop method
      const fakeAudio = {
        pause: () => { isPlaying = false; void audioCtx.close(); },
      } as unknown as HTMLAudioElement;
      ringtoneRef.current = fakeAudio;
    } catch {
      // AudioContext not available — silent ring
    }
  }, []);

  const stopRingtone = useCallback(() => {
    if (ringtoneRef.current) {
      ringtoneRef.current.pause();
      ringtoneRef.current = null;
    }
  }, []);

  /* ─── Call state change handler ──────────────────────────── */

  const handleCallStateChange = useCallback((callId: string, state: CallState) => {
    setActiveCall((prev) => {
      if (!prev || prev.id !== callId) return prev;
      const updated = { ...prev, state };
      if (state === 'active' && !prev.startTime) {
        updated.startTime = new Date();
      }
      return updated;
    });

    if (state === 'active') {
      stopRingtone();
      startDurationTimer(callId);
    }

    if (state === 'ended') {
      stopRingtone();
      stopDurationTimer();
      // Clear active call after a short delay so the UI can show 'ended' briefly
      setTimeout(() => {
        setActiveCall((prev) => (prev?.id === callId ? null : prev));
      }, 1500);
    }
  }, [startDurationTimer, stopDurationTimer, stopRingtone]);

  /* ─── Incoming call handler ──────────────────────────────── */

  const handleIncomingCall = useCallback((call: ActiveCall) => {
    setIncomingCall(call);
    setActiveCall(call);
    setIsExpanded(true);
    startRingtone();
  }, [startRingtone]);

  /* ─── Enumerate audio devices ────────────────────────────── */

  const enumerateDevices = useCallback(async () => {
    try {
      // Request permission first so deviceId/label are populated
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
      stream?.getTracks().forEach((t) => t.stop());

      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === 'audioinput');
      const outputs = devices.filter((d) => d.kind === 'audiooutput');
      setAudioInputDevices(inputs);
      setAudioOutputDevices(outputs);
      if (inputs[0] && !selectedMicId) setSelectedMicId(inputs[0].deviceId);
      if (outputs[0] && !selectedSpeakerId) setSelectedSpeakerId(outputs[0].deviceId);
    } catch {
      // Media devices not available (e.g. no permissions yet)
    }
  }, [selectedMicId, selectedSpeakerId]);

  /* ─── Voicemail count refresh ────────────────────────────── */

  const refreshVoicemailCount = useCallback(() => {
    if (!isAuthenticated) return;
    const extId = extensionIdRef.current ?? undefined;
    void getUnreadCount(extId).then((count) => setUnreadVoicemailCount(count));
  }, [isAuthenticated]);

  /* ─── Main initialization effect ────────────────────────── */

  useEffect(() => {
    if (!isAuthenticated) return;

    let cancelled = false;

    const init = async () => {
      setConnectionState('connecting');

      const creds = await getWebRTCCredentials();
      if (cancelled) return;

      if (!creds) {
        // User has no extension — softphone stays dormant
        setConnectionState('disconnected');
        setCredentials(null);
        return;
      }

      setCredentials(creds);

      // Enumerate audio devices now that we know we'll need them
      await enumerateDevices();
      if (cancelled) return;

      const client = new VertoClient({
        wsUrl: creds.ws_url,
        login: creds.login,
        password: creds.password,
        displayName: creds.display_name,
        iceServers: creds.ice_servers,
      });

      client.onIncomingCall = (call) => {
        if (!cancelled) handleIncomingCall(call);
      };
      client.onCallStateChange = (callId, state) => {
        if (!cancelled) handleCallStateChange(callId, state);
      };
      client.onRegistered = () => {
        if (!cancelled) setConnectionState('registered');
      };
      client.onUnregistered = () => {
        if (!cancelled) setConnectionState('disconnected');
      };
      client.onError = (err) => {
        if (!cancelled) {
          console.error('[Verto]', err.message);
          setConnectionState('error');
        }
      };

      clientRef.current = client;

      try {
        await client.connect();
        if (cancelled) { client.disconnect(); return; }
        setConnectionState('connected');

        await client.login();
        if (cancelled) { client.disconnect(); return; }
      } catch (err) {
        if (!cancelled) {
          console.error('[Verto] Connection failed:', err);
          setConnectionState('error');
        }
      }

      // Fetch initial voicemail count
      void getUnreadCount().then((count) => {
        if (!cancelled) setUnreadVoicemailCount(count);
      });
    };

    void init();

    return () => {
      cancelled = true;
      clientRef.current?.disconnect();
      clientRef.current = null;
      stopDurationTimer();
      stopRingtone();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, user?.id]);

  /* ─── Action implementations ─────────────────────────────── */

  const makeCall = useCallback(async (destination: string): Promise<void> => {
    const client = clientRef.current;
    if (!client) throw new Error('Softphone not connected');

    const call = await client.makeCall(destination);
    setActiveCall(call);
    setIsExpanded(true);
  }, []);

  const answerCall = useCallback(async (): Promise<void> => {
    const client = clientRef.current;
    const incoming = incomingCall;
    if (!client || !incoming) return;

    stopRingtone();
    setIncomingCall(null);
    await client.answerCall(incoming.id);

    setActiveCall((prev) =>
      prev?.id === incoming.id ? { ...prev, state: 'active', startTime: new Date() } : prev,
    );
    startDurationTimer(incoming.id);
  }, [incomingCall, startDurationTimer, stopRingtone]);

  const rejectCall = useCallback((): void => {
    const client = clientRef.current;
    const incoming = incomingCall;
    if (!incoming) return;

    stopRingtone();
    setIncomingCall(null);
    client?.hangupCall(incoming.id);
    setActiveCall((prev) => (prev?.id === incoming.id ? null : prev));
  }, [incomingCall, stopRingtone]);

  const hangupCall = useCallback((): void => {
    const client = clientRef.current;
    const call = activeCall;
    if (!call) return;

    stopRingtone();
    client?.hangupCall(call.id);
    stopDurationTimer();
    setActiveCall((prev) =>
      prev?.id === call.id ? { ...prev, state: 'ended' } : prev,
    );
    setTimeout(() => {
      setActiveCall((prev) => (prev?.id === call.id ? null : prev));
    }, 1500);
  }, [activeCall, stopDurationTimer, stopRingtone]);

  const holdCall = useCallback((): void => {
    const call = activeCall;
    if (!call) return;
    clientRef.current?.holdCall(call.id);
    setActiveCall((prev) => (prev ? { ...prev, held: true, state: 'held' } : prev));
    stopDurationTimer();
  }, [activeCall, stopDurationTimer]);

  const unholdCall = useCallback((): void => {
    const call = activeCall;
    if (!call) return;
    clientRef.current?.unholdCall(call.id);
    setActiveCall((prev) => (prev ? { ...prev, held: false, state: 'active' } : prev));
    startDurationTimer(call.id);
  }, [activeCall, startDurationTimer]);

  const muteCall = useCallback((): void => {
    const call = activeCall;
    if (!call) return;
    clientRef.current?.muteCall(call.id);
    setActiveCall((prev) => (prev ? { ...prev, muted: true } : prev));
  }, [activeCall]);

  const unmuteCall = useCallback((): void => {
    const call = activeCall;
    if (!call) return;
    clientRef.current?.unmuteCall(call.id);
    setActiveCall((prev) => (prev ? { ...prev, muted: false } : prev));
  }, [activeCall]);

  const sendDTMF = useCallback((digit: string): void => {
    const call = activeCall;
    if (!call) return;
    clientRef.current?.sendDTMF(call.id, digit);
  }, [activeCall]);

  const setPresence = useCallback(async (status: PresenceStatus): Promise<void> => {
    setPresenceState(status);
    const extId = extensionIdRef.current;
    if (extId !== null) {
      await updatePresence(extId, status).catch(() => undefined);
    }
  }, []);

  const setExpanded = useCallback((expanded: boolean): void => {
    setIsExpanded(expanded);
  }, []);

  const selectMic = useCallback((deviceId: string): void => {
    setSelectedMicId(deviceId);
  }, []);

  const selectSpeaker = useCallback((deviceId: string): void => {
    setSelectedSpeakerId(deviceId);
  }, []);

  const value: SoftphoneContextValue = {
    connectionState,
    activeCall,
    incomingCall,
    presence,
    isExpanded,
    credentials,
    unreadVoicemailCount,
    audioInputDevices,
    audioOutputDevices,
    selectedMicId,
    selectedSpeakerId,
    makeCall,
    answerCall,
    rejectCall,
    hangupCall,
    holdCall,
    unholdCall,
    muteCall,
    unmuteCall,
    sendDTMF,
    setPresence,
    setExpanded,
    selectMic,
    selectSpeaker,
    refreshVoicemailCount,
  };

  return (
    <SoftphoneContext.Provider value={value}>
      {children}
    </SoftphoneContext.Provider>
  );
}

/* ─── Hook ───────────────────────────────────────────────── */

export function useSoftphone(): SoftphoneContextValue {
  const ctx = useContext(SoftphoneContext);
  if (!ctx) {
    throw new Error('useSoftphone must be used within a SoftphoneProvider');
  }
  return ctx;
}
