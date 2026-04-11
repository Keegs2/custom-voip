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

/* ─── RPC timeout (ms) ───────────────────────────────────── */
const RPC_TIMEOUT_MS = 15_000;

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
    try {
      await this.sendRpc('login', {
        login: this.config.login,
        passwd: this.config.password,
        sessid: this.sessId,
      });
      this.isLoggedIn = true;
      this.onRegistered();
      return true;
    } catch (err) {
      this.onError(err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  /* ─── Outbound call ────────────────────────────────────── */

  async makeCall(destination: string): Promise<ActiveCall> {
    if (!this.isLoggedIn) throw new Error('Not logged in to Verto');

    const callId = generateUUID();
    const localStream = await this.acquireMedia();

    const pc = this.createPeerConnection(callId);
    const remoteStream = new MediaStream();
    pc.ontrack = (ev) => {
      ev.streams[0]?.getTracks().forEach((track) => remoteStream.addTrack(track));
      this.playRemoteStream(callId, remoteStream);
    };

    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false });
    await pc.setLocalDescription(offer);

    // Wait for ICE gathering to complete before sending the SDP
    const sdp = await this.gatherIceCandidates(pc);

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
    };

    this.sessions.set(callId, { call, peerConnection: pc, localStream, remoteStream });

    const [callerNumber, callerName] = this.parseLogin();

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

    this.updateCallState(callId, 'ringing');
    return call;
  }

  /* ─── Answer incoming call ─────────────────────────────── */

  async answerCall(callId: string): Promise<void> {
    const session = this.sessions.get(callId);
    if (!session) throw new Error(`No session for call ${callId}`);

    const localStream = await this.acquireMedia();
    session.localStream = localStream;

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

    switch (msg.method) {
      case 'verto.invite': {
        // Incoming call from FreeSWITCH
        void this.handleIncomingInvite(params);
        break;
      }
      case 'verto.answer': {
        // Remote party answered our outbound call
        void this.handleRemoteAnswer(params);
        break;
      }
      case 'verto.bye': {
        const dp = params['dialogParams'] as VertoDialogParams | undefined;
        if (dp?.callID) {
          this.cleanupSession(dp.callID);
          this.updateCallState(dp.callID, 'ended');
          setTimeout(() => this.sessions.delete(dp.callID), 500);
        }
        break;
      }
      case 'verto.media': {
        // Early media — update SDP if a new one is provided
        void this.handleRemoteAnswer(params);
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

    if (!dp?.callID || !remoteSdp) return;

    const pc = this.createPeerConnection(dp.callID);
    const remoteStream = new MediaStream();
    pc.ontrack = (ev) => {
      ev.streams[0]?.getTracks().forEach((track) => remoteStream.addTrack(track));
      this.playRemoteStream(dp.callID, remoteStream);
    };

    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: remoteSdp }));

    const call: ActiveCall = {
      id: dp.callID,
      direction: 'inbound',
      state: 'ringing',
      remoteNumber: dp.remote_caller_id_number ?? dp.caller_id_number ?? 'Unknown',
      remoteName: dp.remote_caller_id_name ?? dp.caller_id_name ?? 'Unknown',
      startTime: null,
      duration: 0,
      muted: false,
      held: false,
    };

    this.sessions.set(dp.callID, { call, peerConnection: pc, localStream: null, remoteStream });
    this.onIncomingCall(call);
  }

  private async handleRemoteAnswer(params: Record<string, unknown>): Promise<void> {
    const dp = params['dialogParams'] as VertoDialogParams | undefined;
    const remoteSdp = params['sdp'] as string | undefined;

    if (!dp?.callID || !remoteSdp) return;

    const session = this.sessions.get(dp.callID);
    if (!session) return;

    const { peerConnection: pc } = session;

    // Only apply if we're in the right signaling state
    if (pc.signalingState === 'have-local-offer') {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: remoteSdp }));
      this.updateCallState(dp.callID, 'active');
      session.call.startTime = new Date();
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
      const session = this.sessions.get(callId);
      if (!session) return;

      switch (pc.iceConnectionState) {
        case 'connected':
        case 'completed':
          if (session.call.state !== 'active') {
            this.updateCallState(callId, 'active');
          }
          break;
        case 'failed':
          this.onError(new Error(`ICE connection failed for call ${callId}`));
          this.hangupCall(callId);
          break;
        case 'disconnected':
          // May recover — wait for 'failed' before tearing down
          break;
        default:
          break;
      }
    };

    return pc;
  }

  /**
   * Wait for ICE gathering to complete, then return the full SDP.
   * Uses a promise with a 5s timeout fallback so we don't hang forever.
   */
  private gatherIceCandidates(pc: RTCPeerConnection): Promise<string> {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve(pc.localDescription!.sdp);
        return;
      }

      const timeout = setTimeout(() => {
        resolve(pc.localDescription?.sdp ?? '');
      }, 5_000);

      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timeout);
          resolve(pc.localDescription!.sdp);
        }
      };
    });
  }

  private async acquireMedia(): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  }

  private remoteAudioElements = new Map<string, HTMLAudioElement>();

  private playRemoteStream(callId: string, stream: MediaStream): void {
    // Reuse existing element for this call if it exists
    let audio = this.remoteAudioElements.get(callId);
    if (!audio) {
      audio = new Audio();
      audio.autoplay = true;
      this.remoteAudioElements.set(callId, audio);
    }
    audio.srcObject = stream;
    void audio.play().catch(() => undefined);
  }

  private cleanupSession(callId: string): void {
    const session = this.sessions.get(callId);
    if (!session) return;

    session.localStream?.getTracks().forEach((t) => t.stop());
    session.peerConnection.close();

    const audio = this.remoteAudioElements.get(callId);
    if (audio) {
      audio.srcObject = null;
      audio.pause();
      this.remoteAudioElements.delete(callId);
    }
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
