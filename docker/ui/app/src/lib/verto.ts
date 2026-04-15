/** Generate a UUID that works in both secure and insecure contexts */
function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for non-secure contexts (HTTP)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Lightweight Verto JSON-RPC 2.0 client for FreeSWITCH mod_verto.
 *
 * Protocol overview:
 *   - Transport: WebSocket (WSS)
 *   - Encoding: JSON-RPC 2.0
 *   - Auth: verto.login (session-based, not SIP REGISTER)
 *   - Calls: verto.invite / verto.answer / verto.bye / verto.info / verto.modify
 *
 * This is intentionally written without any external dependencies — only native
 * browser WebSocket and RTCPeerConnection APIs are used.
 */

import type { ActiveCall, CallState } from '../types/softphone';

/* ─── Internal Types ─────────────────────────────────────── */

interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
  id: number;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRpc {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

interface VertoDialogParams {
  callID: string;
  destination_number?: string;
  caller_id_number?: string;
  caller_id_name?: string;
  remote_caller_id_number?: string;
  remote_caller_id_name?: string;
  login?: string;
}

interface VertoCallSession {
  call: ActiveCall;
  peerConnection: RTCPeerConnection;
  localStream: MediaStream | null;
  remoteStream: MediaStream;
  /**
   * The original camera stream, held separately so we can revert to it after
   * screen share stops. Null for audio-only calls.
   */
  cameraStream: MediaStream | null;
}

export interface VertoConfig {
  wsUrl: string;
  login: string;
  password: string;
  displayName: string;
  iceServers: RTCIceServer[];
}

/* ─── Event Callback Types ───────────────────────────────── */

export type IncomingCallHandler = (call: ActiveCall) => void;
export type CallStateChangeHandler = (callId: string, state: CallState) => void;
export type RegistrationHandler = () => void;
export type ErrorHandler = (error: Error) => void;

/* ─── Stream event callback ──────────────────────────────── */

/** Fired when local or remote streams change (e.g. screen share started) */
export type StreamChangeHandler = (
  callId: string,
  kind: 'local' | 'remote',
  stream: MediaStream | null,
) => void;

/* ─── RPC timeout (ms) ───────────────────────────────────── */
// verto.invite needs extra time for ICE gathering + FS processing
const RPC_TIMEOUT_MS = 30_000;

/* ─── Reconnect back-off ─────────────────────────────────── */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * VertoClient — manages one WebSocket connection to a FreeSWITCH mod_verto
 * endpoint. Handles login, call lifecycle, and SDP negotiation via
 * RTCPeerConnection entirely without SIP.
 *
 * Usage:
 *   const client = new VertoClient(config);
 *   client.onIncomingCall = (call) => { ... };
 *   client.onCallStateChange = (id, state) => { ... };
 *   await client.connect();
 *   await client.login();
 *   const call = await client.makeCall('1002');
 */
export class VertoClient {
  /* Public event handlers — assign before connecting */
  onIncomingCall: IncomingCallHandler = () => undefined;
  onCallStateChange: CallStateChangeHandler = () => undefined;
  onRegistered: RegistrationHandler = () => undefined;
  onUnregistered: RegistrationHandler = () => undefined;
  onError: ErrorHandler = () => undefined;
  /** Fires when local/remote streams are updated — use this to wire up <video> elements */
  onStreamChange: StreamChangeHandler = () => undefined;

  private config: VertoConfig;
  private ws: WebSocket | null = null;
  private sessId: string;
  private rpcIdCounter = 0;
  private pendingRpcs = new Map<number, PendingRpc>();
  private sessions = new Map<string, VertoCallSession>();
  private isLoggedIn = false;
  private destroyed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: VertoConfig) {
    this.config = config;
    // Session ID persists across reconnects in the same browser session
    this.sessId = `sess-${generateUUID()}`;
  }

  /* ─── Connection management ────────────────────────────── */

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.destroyed) {
        reject(new Error('VertoClient has been destroyed'));
        return;
      }

      this.ws = new WebSocket(this.config.wsUrl, 'verto');

      const onOpen = () => {
        this.reconnectAttempt = 0;
        resolve();
      };

      const onError = (ev: Event) => {
        reject(new Error(`WebSocket connection failed: ${(ev as ErrorEvent).message ?? 'unknown'}`));
      };

      this.ws.addEventListener('open', onOpen, { once: true });
      this.ws.addEventListener('error', onError, { once: true });
      this.ws.addEventListener('message', this.handleMessage);
      this.ws.addEventListener('close', this.handleClose);
    });
  }

  disconnect(): void {
    this.destroyed = true;
    this.cancelReconnect();
    this.cleanupAllSessions();
    if (this.ws) {
      this.ws.removeEventListener('message', this.handleMessage);
      this.ws.removeEventListener('close', this.handleClose);
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.isLoggedIn = false;
    this.rejectAllPending(new Error('Client disconnected'));
  }

  /* ─── Authentication ───────────────────────────────────── */

  async login(): Promise<boolean> {
    console.log(`[Verto] login → ${this.config.login}`);
    try {
      await this.sendRpc('login', {
        login: this.config.login,
        passwd: this.config.password,
        sessid: this.sessId,
      });
      this.isLoggedIn = true;
      console.log(`[Verto] login succeeded for ${this.config.login}`);
      this.onRegistered();
      return true;
    } catch (err) {
      console.error(`[Verto] login failed for ${this.config.login}:`, err);
      this.onError(err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  /* ─── Outbound call ────────────────────────────────────── */

  async makeCall(
    destination: string,
    options?: { video?: boolean },
  ): Promise<ActiveCall> {
    if (!this.isLoggedIn) throw new Error('Not logged in to Verto');

    const callId = generateUUID();
    const isVideo = options?.video === true;

    console.log(`[Verto] makeCall → ${destination} (video=${isVideo}, callId=${callId})`);

    const localStream = await this.acquireMedia(isVideo).catch((err: unknown) => {
      console.error('[Verto] Failed to acquire local media:', err);
      throw err;
    });

    const pc = this.createPeerConnection(callId);
    const remoteStream = new MediaStream();
    pc.ontrack = (ev) => {
      const stream = ev.streams[0];
      if (stream) {
        stream.getTracks().forEach((track) => remoteStream.addTrack(track));
      } else {
        // Some browsers don't include streams; add the track directly
        remoteStream.addTrack(ev.track);
      }
      console.log(`[Verto] ontrack: kind=${ev.track.kind} streamTracks=${remoteStream.getTracks().length}`);
      this.playRemoteAudio(callId, remoteStream);
      // Create a new MediaStream instance so React's referential equality check
      // in useState detects a change when subsequent tracks (e.g. audio after
      // video) are added to the same underlying stream object.
      const snapshot = new MediaStream(remoteStream.getTracks());
      this.onStreamChange(callId, 'remote', snapshot);
    };

    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: isVideo,
    });
    await pc.setLocalDescription(offer);

    // Wait for ICE gathering to complete before sending the SDP
    const sdp = await this.gatherIceCandidates(pc);

    const audioLines = sdp.match(/^m=audio.*/m)?.[0] ?? 'none';
    const videoLines = sdp.match(/^m=video.*/m)?.[0] ?? 'none';
    console.log(`[Verto] SDP offer ready — audio: ${audioLines} | video: ${videoLines}`);

    const call: ActiveCall = {
      id: callId,
      direction: 'outbound',
      state: 'dialing',
      remoteNumber: destination,
      remoteName: destination,
      startTime: null,
      duration: 0,
      muted: false,
      held: false,
      isVideo,
      isScreenSharing: false,
    };

    this.sessions.set(callId, {
      call,
      peerConnection: pc,
      localStream,
      remoteStream,
      cameraStream: isVideo ? localStream : null,
    });

    // Notify listener so the UI can attach the local stream to a <video> element
    if (isVideo) {
      this.onStreamChange(callId, 'local', localStream);
    }

    const [callerNumber, callerName] = this.parseLogin();

    try {
      console.log(`[Verto] Sending verto.invite for callId=${callId}`);
      await this.sendRpc('verto.invite', {
        dialogParams: {
          callID: callId,
          destination_number: destination,
          caller_id_number: callerNumber,
          caller_id_name: callerName,
          login: this.config.login,
        } satisfies VertoDialogParams,
        sdp,
      });
      console.log(`[Verto] verto.invite acknowledged by FS for callId=${callId}`);
    } catch (err) {
      // FS rejected the invite or the RPC timed out — clean up and propagate
      console.error(`[Verto] verto.invite failed for callId=${callId}:`, err);
      this.cleanupSession(callId);
      this.sessions.delete(callId);
      this.onCallStateChange(callId, 'ended');
      throw err;
    }

    this.updateCallState(callId, 'ringing');
    return call;
  }

  /* ─── Answer incoming call ─────────────────────────────── */

  async answerCall(callId: string): Promise<void> {
    const session = this.sessions.get(callId);
    if (!session) throw new Error(`No session for call ${callId}`);

    // For incoming calls, answer with audio only unless the offer included video
    const hasRemoteVideo = session.peerConnection
      .getTransceivers()
      .some((t) => t.receiver.track.kind === 'video');

    const localStream = await this.acquireMedia(hasRemoteVideo);
    session.localStream = localStream;
    if (hasRemoteVideo) {
      session.cameraStream = localStream;
    }

    const pc = session.peerConnection;
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    const sdp = await this.gatherIceCandidates(pc);

    await this.sendRpc('verto.answer', {
      dialogParams: { callID: callId, login: this.config.login } satisfies VertoDialogParams,
      sdp,
    });

    this.updateCallState(callId, 'active');
    session.call.startTime = new Date();

    if (hasRemoteVideo) {
      this.onStreamChange(callId, 'local', localStream);
    }
  }

  /* ─── Hangup ───────────────────────────────────────────── */

  hangupCall(callId: string): void {
    const session = this.sessions.get(callId);
    if (!session) return;

    // Fire and forget — we still clean up locally regardless of ws state
    void this.sendRpc('verto.bye', {
      dialogParams: { callID: callId, login: this.config.login } satisfies VertoDialogParams,
    }).catch(() => undefined);

    this.cleanupSession(callId);
    this.updateCallState(callId, 'ended');
    // Remove after brief delay so listeners can process the 'ended' transition
    setTimeout(() => this.sessions.delete(callId), 500);
  }

  /* ─── Hold / Unhold ────────────────────────────────────── */

  holdCall(callId: string): void {
    const session = this.sessions.get(callId);
    if (!session) return;
    void this.sendRpc('verto.modify', {
      dialogParams: { callID: callId, login: this.config.login } satisfies VertoDialogParams,
      action: 'hold',
    }).catch(() => undefined);
    session.call.held = true;
    this.updateCallState(callId, 'held');
  }

  unholdCall(callId: string): void {
    const session = this.sessions.get(callId);
    if (!session) return;
    void this.sendRpc('verto.modify', {
      dialogParams: { callID: callId, login: this.config.login } satisfies VertoDialogParams,
      action: 'unhold',
    }).catch(() => undefined);
    session.call.held = false;
    this.updateCallState(callId, 'active');
  }

  /* ─── Mute / Unmute ────────────────────────────────────── */

  muteCall(callId: string): void {
    const session = this.sessions.get(callId);
    if (!session?.localStream) return;
    session.localStream.getAudioTracks().forEach((t) => { t.enabled = false; });
    session.call.muted = true;
  }

  unmuteCall(callId: string): void {
    const session = this.sessions.get(callId);
    if (!session?.localStream) return;
    session.localStream.getAudioTracks().forEach((t) => { t.enabled = true; });
    session.call.muted = false;
  }

  /* ─── Camera on / off ──────────────────────────────────── */

  setCameraEnabled(callId: string, enabled: boolean): void {
    const session = this.sessions.get(callId);
    if (!session?.localStream) return;
    session.localStream.getVideoTracks().forEach((t) => { t.enabled = enabled; });
  }

  /* ─── Screen sharing ───────────────────────────────────── */

  /**
   * Replace the video sender's track with a screen capture track.
   * When the user stops sharing via the browser's native stop button,
   * we automatically revert to the camera via the track's `onended` handler.
   */
  async startScreenShare(callId: string): Promise<void> {
    const session = this.sessions.get(callId);
    if (!session) throw new Error(`No session for call ${callId}`);

    const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const screenTrack = displayStream.getVideoTracks()[0];
    if (!screenTrack) throw new Error('No video track in display media stream');

    const pc = session.peerConnection;
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video');

    if (sender) {
      await sender.replaceTrack(screenTrack);
    } else {
      // No video sender yet (audio-only call upgraded to screen share)
      pc.addTrack(screenTrack, displayStream);
    }

    // When the user clicks "Stop sharing" in the browser UI, revert to camera
    screenTrack.onended = () => {
      void this.stopScreenShare(callId);
    };

    session.call.isScreenSharing = true;
    // Notify UI with the display stream so it can show a preview
    this.onStreamChange(callId, 'local', displayStream);
  }

  /**
   * Revert the video sender's track back to the original camera track.
   */
  async stopScreenShare(callId: string): Promise<void> {
    const session = this.sessions.get(callId);
    if (!session) return;

    const cameraStream = session.cameraStream;
    const cameraTrack = cameraStream?.getVideoTracks()[0] ?? null;

    const pc = session.peerConnection;
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video');

    if (sender) {
      if (cameraTrack) {
        await sender.replaceTrack(cameraTrack);
      } else {
        // No camera to revert to — acquire a fresh one
        try {
          const freshCamera = await this.acquireMedia(true);
          session.cameraStream = freshCamera;
          const freshTrack = freshCamera.getVideoTracks()[0];
          if (freshTrack) await sender.replaceTrack(freshTrack);
        } catch {
          // Camera unavailable — leave video sender with null track
          await sender.replaceTrack(null);
        }
      }
    }

    session.call.isScreenSharing = false;
    // Notify UI to revert to the camera stream preview
    this.onStreamChange(callId, 'local', session.cameraStream ?? session.localStream);
  }

  /* ─── DTMF ─────────────────────────────────────────────── */

  sendDTMF(callId: string, digit: string): void {
    // Try in-band DTMF first via RTCDTMFSender
    const session = this.sessions.get(callId);
    if (session) {
      const sender = session.peerConnection.getSenders().find((s) => s.track?.kind === 'audio');
      if (sender?.dtmf) {
        try {
          sender.dtmf.insertDTMF(digit, 100, 50);
          return;
        } catch {
          // Fall through to out-of-band INFO
        }
      }
    }

    // Out-of-band DTMF via verto.info
    void this.sendRpc('verto.info', {
      dialogParams: { callID: callId, login: this.config.login } satisfies VertoDialogParams,
      dtmf: digit,
    }).catch(() => undefined);
  }

  /* ─── Stream accessors ─────────────────────────────────── */

  getLocalStream(callId: string): MediaStream | null {
    return this.sessions.get(callId)?.localStream ?? null;
  }

  getRemoteStream(callId: string): MediaStream | null {
    return this.sessions.get(callId)?.remoteStream ?? null;
  }

  /* ─── Active call accessor ─────────────────────────────── */

  getActiveCalls(): ActiveCall[] {
    return Array.from(this.sessions.values()).map((s) => s.call);
  }

  /* ─── Private: WebSocket message handling ──────────────── */

  private handleMessage = (ev: MessageEvent): void => {
    let msg: JsonRpcResponse | JsonRpcRequest;
    try {
      msg = JSON.parse(ev.data as string) as JsonRpcResponse | JsonRpcRequest;
    } catch {
      return;
    }

    // Incoming server notifications (method present, no id or id may be present)
    if ('method' in msg) {
      this.handleServerEvent(msg as JsonRpcRequest);
      return;
    }

    // Response to one of our outbound RPC calls
    if ('id' in msg && msg.id !== undefined) {
      const pending = this.pendingRpcs.get(msg.id as number);
      if (!pending) return;
      clearTimeout(pending.timeoutHandle);
      this.pendingRpcs.delete(msg.id as number);

      if (msg.error) {
        pending.reject(new Error(`Verto RPC error ${msg.error.code}: ${msg.error.message}`));
      } else {
        pending.resolve(msg.result);
      }
    }
  };

  private handleServerEvent(msg: JsonRpcRequest): void {
    const params = msg.params ?? {};

    // Log all server-pushed events so we can trace the call lifecycle
    if (msg.method !== 'verto.event') {
      const callID = (params['dialogParams'] as VertoDialogParams | undefined)?.callID ?? 'n/a';
      console.log(`[Verto] ← server event: ${msg.method} (callId=${callID})`);
    }

    switch (msg.method) {
      case 'verto.invite': {
        // Incoming call from FreeSWITCH
        void this.handleIncomingInvite(params);
        break;
      }
      case 'verto.answer': {
        // Remote party answered our outbound call
        this.handleRemoteAnswer(params, 'verto.answer').catch((err) => {
          console.error('[Verto] Failed to process verto.answer:', err);
          this.onError(err instanceof Error ? err : new Error(String(err)));
        });
        break;
      }
      case 'verto.bye': {
        const dp = params['dialogParams'] as VertoDialogParams | undefined;

        // Apply the same three-step callID resolution used in handleRemoteAnswer —
        // mod_verto conferences may omit dialogParams.callID here too.
        let byeCallId: string | undefined;
        let byeCallIdSource: string;

        if (dp?.callID) {
          byeCallId = dp.callID;
          byeCallIdSource = 'dialogParams.callID';
        } else if (typeof params['callID'] === 'string' && params['callID']) {
          byeCallId = params['callID'];
          byeCallIdSource = 'params.callID (top-level)';
        } else {
          const pendingEntries = Array.from(this.sessions.entries()).filter(
            ([, s]) => s.call.direction === 'outbound' && (s.call.state === 'dialing' || s.call.state === 'ringing' || s.call.state === 'active'),
          );
          if (pendingEntries.length === 1) {
            byeCallId = pendingEntries[0][0];
            byeCallIdSource = 'single outbound session (conference fallback)';
          } else {
            byeCallIdSource = 'unresolvable';
          }
        }

        if (byeCallId) {
          console.log(`[Verto] verto.bye received — callId=${byeCallId} (resolved via ${byeCallIdSource})`);
          this.cleanupSession(byeCallId);
          this.updateCallState(byeCallId, 'ended');
          setTimeout(() => this.sessions.delete(byeCallId!), 500);
        } else {
          console.warn(`[Verto] verto.bye received without resolvable callID (strategy: ${byeCallIdSource})`);
        }
        break;
      }
      case 'verto.media': {
        // Early media from FS — carries an SDP answer so we can set up the media path
        // before the far end formally answers. For conferences, this is the primary
        // path: FS sends verto.media with the SDP answer, then verto.answer to confirm.
        this.handleRemoteAnswer(params, 'verto.media').catch((err) => {
          console.error('[Verto] Failed to process verto.media:', err);
          this.onError(err instanceof Error ? err : new Error(String(err)));
        });
        break;
      }
      case 'verto.event': {
        // Generic event (presence, etc.) — no specific handling needed at this layer
        break;
      }
      default:
        break;
    }
  }

  private async handleIncomingInvite(params: Record<string, unknown>): Promise<void> {
    const dp = params['dialogParams'] as VertoDialogParams | undefined;
    const remoteSdp = params['sdp'] as string | undefined;

    // Resolve callID — same multi-step approach as verto.bye/verto.answer.
    // For inbound calls via verto.rtc, FS may place the callID at different
    // locations in the params depending on the origination path.
    let callId: string | undefined;
    if (dp?.callID) {
      callId = dp.callID;
    } else if (typeof params['callID'] === 'string' && params['callID']) {
      callId = params['callID'];
    }

    console.log(`[Verto] handleIncomingInvite: callId=${callId ?? 'MISSING'}, hasSdp=${!!remoteSdp}, params keys=${Object.keys(params).join(',')}`);

    if (!callId || !remoteSdp) {
      console.warn('[Verto] Dropping inbound invite — missing callId or SDP', { callId, hasSdp: !!remoteSdp });
      return;
    }

    const pc = this.createPeerConnection(callId);
    const remoteStream = new MediaStream();
    pc.ontrack = (ev) => {
      ev.streams[0]?.getTracks().forEach((track) => remoteStream.addTrack(track));
      this.playRemoteAudio(callId!, remoteStream);
      // Snapshot so React sees a new reference on every track arrival.
      const snapshot = new MediaStream(remoteStream.getTracks());
      this.onStreamChange(callId!, 'remote', snapshot);
    };

    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: remoteSdp }));

    // Detect whether the remote party offered video
    const offersVideo = remoteSdp.includes('m=video');

    const call: ActiveCall = {
      id: callId,
      direction: 'inbound',
      state: 'ringing',
      remoteNumber: dp?.remote_caller_id_number ?? dp?.caller_id_number ?? (params['caller_id_number'] as string | undefined) ?? 'Unknown',
      remoteName: dp?.remote_caller_id_name ?? dp?.caller_id_name ?? (params['caller_id_name'] as string | undefined) ?? 'Unknown',
      startTime: null,
      duration: 0,
      muted: false,
      held: false,
      isVideo: offersVideo,
      isScreenSharing: false,
    };

    console.log(`[Verto] Inbound call: ${call.remoteName} <${call.remoteNumber}> -> callId=${callId}`);

    this.sessions.set(callId, {
      call,
      peerConnection: pc,
      localStream: null,
      remoteStream,
      cameraStream: null,
    });

    this.onIncomingCall(call);
  }

  private async handleRemoteAnswer(params: Record<string, unknown>, eventName: string): Promise<void> {
    const dp = params['dialogParams'] as VertoDialogParams | undefined;
    const remoteSdp = params['sdp'] as string | undefined;

    // Resolve the callID using a three-step fallback. mod_verto's conference
    // application sometimes sends verto.media / verto.answer without populating
    // dialogParams.callID, so we need alternative ways to identify the session.
    let callId: string | undefined;
    let callIdSource: string;

    if (dp?.callID) {
      // Step 1 (normal path): callID is in dialogParams
      callId = dp.callID;
      callIdSource = 'dialogParams.callID';
    } else if (typeof params['callID'] === 'string' && params['callID']) {
      // Step 2: FreeSWITCH placed it at the top level of params
      callId = params['callID'];
      callIdSource = 'params.callID (top-level)';
    } else {
      // Step 3: No callID anywhere in the message. If there is exactly one
      // outbound session that is still pending (dialing or ringing), this
      // event must belong to it — a Verto client has at most one active call.
      const pendingEntries = Array.from(this.sessions.entries()).filter(
        ([, s]) => s.call.direction === 'outbound' && (s.call.state === 'dialing' || s.call.state === 'ringing'),
      );
      if (pendingEntries.length === 1) {
        callId = pendingEntries[0][0];
        callIdSource = 'single pending outbound session (conference fallback)';
      } else {
        callIdSource = 'unresolvable';
      }
    }

    if (!callId) {
      console.warn(`[Verto] ${eventName} received without callID (resolution strategy: ${callIdSource})`);
      return;
    }

    console.log(`[Verto] ${eventName} callID resolved via ${callIdSource} → ${callId}`);

    const session = this.sessions.get(callId);
    if (!session) {
      console.warn(`[Verto] ${eventName} for unknown callId=${callId} (session not found)`);
      return;
    }

    const { peerConnection: pc } = session;

    console.log(
      `[Verto] ${eventName} received — callId=${callId}` +
      ` signalingState=${pc.signalingState}` +
      ` iceConnectionState=${pc.iceConnectionState}` +
      ` hasSDP=${Boolean(remoteSdp)}`,
    );

    if (!remoteSdp) {
      // Some early-media notifications carry no SDP (just a state change signal).
      // Treat this as a ringing confirmation — the actual SDP answer comes later.
      console.log(`[Verto] ${eventName} has no SDP — treating as ringing confirmation`);
      return;
    }

    // Log the remote SDP m-lines so we can see what FS is sending back
    const remoteAudio = remoteSdp.match(/^m=audio.*/m)?.[0] ?? 'none';
    const remoteVideo = remoteSdp.match(/^m=video.*/m)?.[0] ?? 'none';
    console.log(`[Verto] Remote SDP — audio: ${remoteAudio} | video: ${remoteVideo}`);

    if (pc.signalingState === 'have-local-offer') {
      // Normal path: we have our offer pending, apply the answer
      try {
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: remoteSdp }));
        console.log(`[Verto] setRemoteDescription succeeded for callId=${callId}`);
        this.updateCallState(callId, 'active');
        session.call.startTime = new Date();
      } catch (err) {
        console.error(`[Verto] setRemoteDescription failed for callId=${callId}:`, err);
        // SDP negotiation failed — tear down the call so the UI doesn't hang
        this.hangupCall(callId);
        throw err;
      }
    } else if (pc.signalingState === 'stable') {
      // verto.answer sometimes arrives after verto.media already moved us to 'stable'.
      // The SDP is already applied — just ensure the call is marked active.
      console.log(`[Verto] ${eventName} received in 'stable' state — SDP already applied, ensuring active state`);
      if (session.call.state !== 'active') {
        this.updateCallState(callId, 'active');
        session.call.startTime = new Date();
      }
    } else {
      console.warn(
        `[Verto] ${eventName} received in unexpected signalingState=${pc.signalingState}` +
        ` for callId=${callId} — skipping setRemoteDescription`,
      );
    }
  }

  /* ─── Private: WebSocket close handling ────────────────── */

  private handleClose = (ev: CloseEvent): void => {
    this.isLoggedIn = false;
    this.rejectAllPending(new Error('WebSocket closed'));
    this.onUnregistered();

    if (this.destroyed) return;

    // Attempt to reconnect unless it was a clean close we initiated
    if (ev.code !== 1000) {
      this.scheduleReconnect();
    }
  };

  private scheduleReconnect(): void {
    this.cancelReconnect();

    // Max 5 reconnect attempts to prevent infinite loops
    if (this.reconnectAttempt >= 5) {
      console.warn('[Verto] Max reconnect attempts reached, giving up');
      this.onError?.(new Error('Max reconnect attempts reached'));
      return;
    }

    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt++;

    this.reconnectTimer = setTimeout(async () => {
      if (this.destroyed) return;
      try {
        await this.connect();
        await this.login();
        this.reconnectAttempt = 0; // Reset on success
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /* ─── Private: RPC helpers ─────────────────────────────── */

  private sendRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket is not open'));
        return;
      }

      const id = ++this.rpcIdCounter;
      const timeoutHandle = setTimeout(() => {
        this.pendingRpcs.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, RPC_TIMEOUT_MS);

      this.pendingRpcs.set(id, { resolve, reject, timeoutHandle });

      // mod_verto requires sessid at the top-level params for all verto.* methods
      const enrichedParams = method.startsWith('verto.')
        ? { sessid: this.sessId, ...params }
        : params;

      const message: JsonRpcRequest = { jsonrpc: '2.0', method, params: enrichedParams, id };
      this.ws.send(JSON.stringify(message));
    });
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRpcs) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(error);
      this.pendingRpcs.delete(id);
    }
  }

  /* ─── Private: WebRTC helpers ──────────────────────────── */

  private createPeerConnection(callId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({
      iceServers: this.config.iceServers.length > 0
        ? this.config.iceServers
        : [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    pc.oniceconnectionstatechange = () => {
      console.log(`[Verto] ICE state → ${pc.iceConnectionState} (callId=${callId})`);
      const session = this.sessions.get(callId);
      if (!session) return;

      switch (pc.iceConnectionState) {
        case 'connected':
        case 'completed':
          // ICE succeeded — if signaling already completed (stable) but the call
          // state wasn't flipped to active yet (e.g. setRemoteDescription raced
          // ahead of the state update), flip it now as a safety net.
          if (session.call.state !== 'active') {
            console.log(`[Verto] ICE connected — promoting callId=${callId} to active`);
            this.updateCallState(callId, 'active');
            if (!session.call.startTime) session.call.startTime = new Date();
          }
          break;
        case 'failed':
          console.error(`[Verto] ICE failed for callId=${callId}`);
          this.onError(new Error(`ICE connection failed for call ${callId}`));
          this.hangupCall(callId);
          break;
        case 'disconnected':
          // May recover — wait for 'failed' before tearing down
          console.warn(`[Verto] ICE disconnected for callId=${callId} — waiting for recovery`);
          break;
        default:
          break;
      }
    };

    pc.onsignalingstatechange = () => {
      console.log(`[Verto] Signaling state → ${pc.signalingState} (callId=${callId})`);
    };

    // Note: onicegatheringstatechange property is NOT set here because
    // gatherIceCandidates() adds its own listener via addEventListener.
    // Using addEventListener from both places avoids handler overwriting.
    pc.addEventListener('icegatheringstatechange', () => {
      console.log(`[Verto] ICE gathering → ${pc.iceGatheringState} (callId=${callId})`);
    });

    return pc;
  }

  /**
   * Wait for ICE gathering to complete, then return the full SDP.
   * Uses an event listener (not the property assignment) so it does not
   * overwrite the diagnostic handler set in createPeerConnection.
   * Falls back after 5 s so we never hang indefinitely.
   */
  private gatherIceCandidates(pc: RTCPeerConnection): Promise<string> {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve(pc.localDescription!.sdp);
        return;
      }

      // Resolve as soon as we have at least one candidate (host candidate
      // is typically available within ~100ms). STUN candidates may take 2-5s
      // to arrive from Google, but they aren't needed — FS is on a public IP
      // and can reach the browser's host candidate directly.
      let hasCandidate = false;
      let candidateTimer: ReturnType<typeof setTimeout> | null = null;

      const finish = () => {
        if (candidateTimer) clearTimeout(candidateTimer);
        clearTimeout(timeout);
        pc.removeEventListener('icegatheringstatechange', onStateChange);
        pc.removeEventListener('icecandidate', onCandidate);
        resolve(pc.localDescription?.sdp ?? '');
      };

      // Hard timeout — safety net if no candidates arrive at all
      const timeout = setTimeout(() => {
        console.warn('[Verto] ICE gathering timed out — using partial SDP');
        finish();
      }, 3_000);

      const onCandidate = (ev: RTCPeerConnectionIceEvent) => {
        if (ev.candidate && !hasCandidate) {
          hasCandidate = true;
          // Got first candidate — wait a short window for more host candidates
          // then resolve immediately without waiting for STUN/TURN
          candidateTimer = setTimeout(() => {
            console.log(`[Verto] ICE fast-resolve: sending SDP after first candidates`);
            finish();
          }, 200);
        }
      };

      const onStateChange = () => {
        if (pc.iceGatheringState === 'complete') {
          finish();
        }
      };

      pc.addEventListener('icecandidate', onCandidate);
      pc.addEventListener('icegatheringstatechange', onStateChange);
    });
  }

  /**
   * Acquire local media. When video is true, requests camera + mic with
   * HD constraints suitable for video calls.
   */
  private async acquireMedia(video: boolean): Promise<MediaStream> {
    // getUserMedia requires a secure context (HTTPS or localhost).
    // On plain HTTP, navigator.mediaDevices is undefined.
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        'Microphone/camera access requires HTTPS. ' +
        'Please access this site using https:// instead of http://'
      );
    }

    if (video) {
      return navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
      });
    }
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  }

  /**
   * Remote audio/video playback is handled entirely by the React layer via
   * onStreamChange → remoteVideoStream. A detached Audio() element cannot
   * reliably autoplay without a prior user gesture (NotAllowedError). The
   * ConferenceRoom and Softphone widget bind remoteVideoStream to DOM
   * <audio>/<video> elements that are already in a user-gesture context.
   *
   * This method is intentionally a no-op; callers are retained for clarity
   * but the actual work now happens in the UI layer.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private playRemoteAudio(_callId: string, _stream: MediaStream): void {
    // No-op: React components bind remoteVideoStream to <audio muted={false}>
    // elements inside ConferenceRoom / the softphone widget, which inherit
    // the user-gesture context from the Join / Answer click.
  }

  private cleanupSession(callId: string): void {
    const session = this.sessions.get(callId);
    if (!session) return;

    session.localStream?.getTracks().forEach((t) => t.stop());
    // Also stop any separately held camera stream (e.g. during screen share)
    if (session.cameraStream && session.cameraStream !== session.localStream) {
      session.cameraStream.getTracks().forEach((t) => t.stop());
    }
    session.peerConnection.close();
    // Remote audio cleanup is handled by the React component unmounting its
    // <audio> element (srcObject cleared when remoteVideoStream → null).
  }

  private cleanupAllSessions(): void {
    for (const callId of this.sessions.keys()) {
      this.cleanupSession(callId);
    }
    this.sessions.clear();
  }

  private updateCallState(callId: string, state: CallState): void {
    const session = this.sessions.get(callId);
    if (session) {
      session.call.state = state;
    }
    this.onCallStateChange(callId, state);
  }

  private parseLogin(): [string, string] {
    // login format: "1001@domain" or just "1001"
    const parts = this.config.login.split('@');
    const number = parts[0] ?? this.config.login;
    const name = this.config.displayName || number;
    return [number, name];
  }
}
