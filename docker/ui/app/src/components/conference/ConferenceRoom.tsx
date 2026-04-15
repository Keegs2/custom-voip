/**
 * ConferenceRoom — in-call overlay shown when the active call is to a
 * conference room (*88XX). Displays an equal-grid video layout where every
 * participant (including the local user) gets a same-sized tile, a controls
 * bar, and a toggleable participant list sidebar.
 *
 * Video rendering is ready for FreeSWITCH passthrough mode: there is exactly
 * one remote video stream (the active speaker). The local user's tile shows
 * their own camera feed (selfViewStream, mirrored). All other tiles show the
 * single remoteVideoStream; non-speaking participants fall back to an avatar.
 *
 * Grid sizing: 1 member → 1 col, 2-4 → 2 cols, 5-9 → 3 cols, 10+ → 4 cols.
 *
 * Flow:
 *   ConferenceRoom mounts → Lobby shown (camera preview, mic level meter)
 *   User clicks "Join Meeting" → onJoin() fires (makeCall) → activeCall becomes
 *   non-null → lobbyState transitions to 'joined' → conference grid renders.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Mic, MicOff, Video, VideoOff, Monitor, MonitorOff,
  PhoneOff, Users, Square, Circle,
} from 'lucide-react';
import { useSoftphone } from '../../contexts/SoftphoneContext';
import {
  getConferenceLiveStatus,
  kickMember,
  muteMember,
  startRecording,
  stopRecording,
} from '../../api/conference';
import type { ConferenceLiveStatus, LiveMember } from '../../types/conference';

/* ─── Types ─────────────────────────────────────────────── */

interface ConferenceRoomProps {
  /** Conference ID for live status polling */
  conferenceId: number;
  /** Conference name for display */
  conferenceName: string;
  /** Room number (e.g. "01") for the dial code label */
  roomNumber: string;
  /** Whether this user has moderator privileges */
  isModerator: boolean;
  /**
   * Called when the user confirms they want to join from the lobby.
   * Should trigger makeCall(*88XX). The conference grid renders once
   * activeCall becomes non-null following this call.
   */
  onJoin: () => void;
  /**
   * Called when the user dismisses the lobby without joining.
   * Should close/unmount the ConferenceRoom overlay entirely.
   */
  onCancel: () => void;
}

/* ─── Video tile ─────────────────────────────────────────── */

interface VideoTileProps {
  member: LiveMember;
  isModerator: boolean;
  onKick: (id: number) => void;
  onMute: (id: number) => void;
  /** When provided, render a live video feed instead of the avatar placeholder. */
  videoStream?: MediaStream | null;
  /** Mirror the video horizontally (for local self-view). */
  mirrorVideo?: boolean;
}

function VideoTile({ member, isModerator, onKick, onMute, videoStream, mirrorVideo }: VideoTileProps) {
  const isTalking = member.talking;
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = videoStream ?? null;
    if (videoStream) {
      void el.play().catch(() => undefined);
    }
  }, [videoStream]);

  return (
    <div
      style={{
        position: 'relative',
        background: 'rgba(255,255,255,0.03)',
        borderRadius: 12,
        overflow: 'hidden',
        aspectRatio: '16/9',
        border: isTalking
          ? '2px solid #3b82f6'
          : '1px solid rgba(255,255,255,0.07)',
        boxShadow: isTalking
          ? '0 0 0 2px rgba(59,130,246,0.25), 0 4px 24px rgba(0,0,0,0.4)'
          : '0 4px 16px rgba(0,0,0,0.3)',
        transition: 'border-color 0.2s, box-shadow 0.2s',
      }}
    >
      {/*
       * Live video feed — rendered unconditionally so the ref is always
       * attached. Visibility is controlled by the display style so the
       * element stays mounted and the srcObject assignment in the effect
       * above is always valid.
       */}
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform: mirrorVideo ? 'scaleX(-1)' : 'none',
          display: videoStream ? 'block' : 'none',
        }}
      />

      {/* Avatar placeholder — shown only when there is no video stream */}
      <div
        style={{
          width: '100%',
          height: '100%',
          display: videoStream ? 'none' : 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: `linear-gradient(135deg, rgba(59,130,246,0.12) 0%, rgba(99,102,241,0.10) 100%)`,
        }}
      >
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, #2563eb 0%, #7c3aed 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1.4rem',
            fontWeight: 700,
            color: '#fff',
            boxShadow: '0 4px 16px rgba(59,130,246,0.4)',
          }}
        >
          {(member.name || '?').charAt(0).toUpperCase()}
        </div>
      </div>

      {/* Talking pulse ring */}
      {isTalking && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 12,
            border: '2px solid #3b82f6',
            animation: 'conferencePulse 1.2s ease-in-out infinite',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Name + status bar at bottom */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          padding: '20px 10px 10px',
          background: 'linear-gradient(to top, rgba(0,0,0,0.75) 0%, transparent 100%)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span style={{ flex: 1, fontSize: '0.78rem', fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {member.name || 'Unknown'}
        </span>
        {member.muted && (
          <MicOff size={12} color="#ef4444" />
        )}
        {isTalking && !member.muted && (
          <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 12 }}>
            {[4, 8, 6].map((h, i) => (
              <div
                key={i}
                style={{
                  width: 3,
                  height: h,
                  background: '#22c55e',
                  borderRadius: 2,
                  animation: `talkBar${i} 0.6s ease-in-out infinite alternate`,
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Moderator controls overlay (top-right) */}
      {isModerator && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            display: 'flex',
            gap: 4,
            opacity: 0,
            transition: 'opacity 0.15s',
          }}
          className="tile-controls"
        >
          <button
            type="button"
            onClick={() => onMute(member.id)}
            title={member.muted ? 'Unmute' : 'Mute'}
            style={tileBtn}
          >
            {member.muted ? <Mic size={12} /> : <MicOff size={12} />}
          </button>
          <button
            type="button"
            onClick={() => onKick(member.id)}
            title="Remove from call"
            style={{ ...tileBtn, color: '#ef4444' }}
          >
            <PhoneOff size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

const tileBtn: React.CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 6,
  background: 'rgba(0,0,0,0.65)',
  border: '1px solid rgba(255,255,255,0.15)',
  color: '#e2e8f0',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  backdropFilter: 'blur(4px)',
};

/* ─── Control button ─────────────────────────────────────── */

interface CtrlBtnProps {
  onClick: () => void;
  label: string;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}

function CtrlBtn({ onClick, label, active, danger, disabled, children }: CtrlBtnProps) {
  const bg = danger
    ? 'linear-gradient(135deg, #dc2626 0%, #ef4444 100%)'
    : active
    ? 'rgba(59,130,246,0.25)'
    : 'rgba(255,255,255,0.06)';

  const border = danger
    ? '1px solid rgba(239,68,68,0.5)'
    : active
    ? '1px solid rgba(59,130,246,0.45)'
    : '1px solid rgba(255,255,255,0.09)';

  const color = danger ? '#fff' : active ? '#60a5fa' : '#94a3b8';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        style={{
          width: 48,
          height: 48,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: bg,
          border,
          color,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.4 : 1,
          boxShadow: danger
            ? '0 4px 18px rgba(239,68,68,0.5)'
            : active
            ? '0 0 12px rgba(59,130,246,0.3)'
            : 'none',
          transition: 'background 0.15s, box-shadow 0.15s, color 0.15s',
        }}
      >
        {children}
      </button>
      <span style={{ fontSize: '0.6rem', color: danger ? '#ef4444' : color, fontWeight: 500 }}>
        {label}
      </span>
    </div>
  );
}

/* ─── Participant sidebar ────────────────────────────────── */

interface ParticipantSidebarProps {
  members: LiveMember[];
  isModerator: boolean;
  onKick: (id: number) => void;
  onMute: (id: number) => void;
  onClose: () => void;
}

function ParticipantSidebar({ members, isModerator, onKick: _onKick, onMute, onClose }: ParticipantSidebarProps) {
  return (
    <div
      style={{
        width: 260,
        flexShrink: 0,
        background: '#131520',
        borderLeft: '1px solid rgba(255,255,255,0.06)',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '16px 16px 12px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Users size={15} color="#60a5fa" />
          <span style={{ fontSize: '0.875rem', fontWeight: 600, color: '#e2e8f0' }}>
            Participants
          </span>
          <span
            style={{
              minWidth: 18,
              height: 18,
              borderRadius: 9,
              background: '#3b82f6',
              color: '#fff',
              fontSize: '0.65rem',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 5px',
            }}
          >
            {members.length}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: '#475569',
            cursor: 'pointer',
            fontSize: '1rem',
            lineHeight: 1,
            padding: 4,
          }}
        >
          ×
        </button>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {members.length === 0 ? (
          <div style={{ padding: '24px 16px', textAlign: 'center', color: '#475569', fontSize: '0.8rem' }}>
            No participants yet
          </div>
        ) : (
          members.map((m) => (
            <div
              key={m.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 12px',
                borderRadius: 8,
                margin: '1px 6px',
                background: m.talking ? 'rgba(59,130,246,0.06)' : 'transparent',
                border: m.talking ? '1px solid rgba(59,130,246,0.15)' : '1px solid transparent',
                transition: 'background 0.15s, border-color 0.15s',
              }}
            >
              {/* Avatar */}
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  background: 'linear-gradient(135deg, rgba(59,130,246,0.25) 0%, rgba(99,102,241,0.25) 100%)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.8rem',
                  fontWeight: 700,
                  color: '#818cf8',
                  flexShrink: 0,
                  border: m.talking ? '1.5px solid #3b82f6' : '1.5px solid transparent',
                  transition: 'border-color 0.2s',
                }}
              >
                {(m.name || '?').charAt(0).toUpperCase()}
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.name || 'Unknown'}
                </div>
                {m.talking && (
                  <div style={{ fontSize: '0.68rem', color: '#22c55e', fontWeight: 500 }}>
                    Speaking...
                  </div>
                )}
              </div>

              {/* Icons */}
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                {m.muted && <MicOff size={13} color="#ef4444" />}
                {m.video && <Video size={13} color="#60a5fa" />}
                {isModerator && (
                  <button
                    type="button"
                    onClick={() => onMute(m.id)}
                    title={m.muted ? 'Unmute' : 'Mute'}
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 5,
                      background: 'rgba(255,255,255,0.05)',
                      border: '1px solid rgba(255,255,255,0.07)',
                      color: '#64748b',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {m.muted ? <Mic size={10} /> : <MicOff size={10} />}
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ─── Lobby ──────────────────────────────────────────────── */

interface LobbyProps {
  conferenceName: string;
  onJoin: () => void;
  onCancel: () => void;
}

function Lobby({ conferenceName, onJoin, onCancel }: LobbyProps) {
  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [micLevel, setMicLevel] = useState(0);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  /*
   * All media resource handles live in refs so cleanup functions always
   * reach the current values regardless of which render closure runs.
   */
  const previewStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const videoElRef = useRef<HTMLVideoElement>(null);

  /* ── Acquire preview stream on mount ──────────────────── */

  useEffect(() => {
    let cancelled = false;

    async function acquireMedia() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: true,
        });

        if (cancelled) {
          // Component unmounted before getUserMedia resolved — release immediately.
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        previewStreamRef.current = stream;

        // Bind to the video preview element.
        const videoEl = videoElRef.current;
        if (videoEl) {
          videoEl.srcObject = stream;
          void videoEl.play().catch(() => undefined);
        }

        // Wire up AudioContext analyser for the mic level meter.
        // Chrome creates AudioContext in 'suspended' state; resume() is
        // required before the analyser will produce non-zero frequency data.
        const audioCtx = new AudioContext();
        void audioCtx.resume();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        audioCtxRef.current = audioCtx;
        analyserRef.current = analyser;

        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        function tick() {
          if (!analyserRef.current) return;
          analyserRef.current.getByteFrequencyData(dataArray);
          const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
          setMicLevel((avg / 255) * 100);
          rafIdRef.current = requestAnimationFrame(tick);
        }

        rafIdRef.current = requestAnimationFrame(tick);
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          setMediaError(`Could not access camera or microphone: ${message}`);
        }
      }
    }

    void acquireMedia();

    return () => {
      cancelled = true;
      stopPreview();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Stop all preview resources ───────────────────────── */

  function stopPreview() {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (analyserRef.current) {
      analyserRef.current.disconnect();
      analyserRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    if (previewStreamRef.current) {
      previewStreamRef.current.getTracks().forEach((t) => t.stop());
      previewStreamRef.current = null;
    }
  }

  /* ── Camera toggle — enable/disable the video track ───── */

  function handleCameraToggle() {
    const stream = previewStreamRef.current;
    if (!stream) return;
    const next = !cameraOn;
    stream.getVideoTracks().forEach((t) => {
      t.enabled = next;
    });
    setCameraOn(next);
  }

  /* ── Mic toggle — enable/disable the audio track ───────── */

  function handleMicToggle() {
    const stream = previewStreamRef.current;
    if (!stream) return;
    const next = !micOn;
    stream.getAudioTracks().forEach((t) => {
      t.enabled = next;
    });
    setMicOn(next);
    // Freeze the level meter display at 0 when muted.
    if (!next) setMicLevel(0);
  }

  /* ── Join — stop preview then call onJoin ─────────────── */

  function handleJoin() {
    setJoining(true);
    stopPreview();
    onJoin();
  }

  /* ── Styles ───────────────────────────────────────────── */

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    background: '#0a0c13',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 200,
  };

  const cardStyle: React.CSSProperties = {
    background: '#1a1d2e',
    border: '1px solid rgba(42,47,69,0.6)',
    borderRadius: 16,
    padding: '32px 32px 28px',
    width: '100%',
    maxWidth: 560,
    display: 'flex',
    flexDirection: 'column',
    gap: 24,
    boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
  };

  const previewContainerStyle: React.CSSProperties = {
    position: 'relative',
    width: '100%',
    aspectRatio: '4/3',
    borderRadius: 12,
    overflow: 'hidden',
    background: '#0d0f1a',
    border: '1px solid rgba(42,47,69,0.5)',
  };

  const cameraOffOverlayStyle: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'linear-gradient(135deg, rgba(15,17,30,1) 0%, rgba(26,29,46,1) 100%)',
    flexDirection: 'column',
    gap: 12,
  };

  const toggleBtnBase: React.CSSProperties = {
    width: 48,
    height: 48,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: 'background 0.15s, border-color 0.15s, box-shadow 0.15s',
    background: 'rgba(255,255,255,0.05)',
  };

  const toggleBtnOn: React.CSSProperties = {
    ...toggleBtnBase,
    border: '1.5px solid #22c55e',
    color: '#22c55e',
    boxShadow: '0 0 10px rgba(34,197,94,0.25)',
  };

  const toggleBtnOff: React.CSSProperties = {
    ...toggleBtnBase,
    border: '1.5px solid #475569',
    color: '#475569',
  };

  return (
    <div style={overlayStyle}>
      <div style={cardStyle}>

        {/* Meeting title */}
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 600, color: '#475569', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 6 }}>
            You&apos;re about to join
          </div>
          <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700, color: '#e2e8f0', letterSpacing: '-0.02em' }}>
            {conferenceName}
          </h2>
        </div>

        {/* Camera preview */}
        <div style={previewContainerStyle}>
          <video
            ref={videoElRef}
            autoPlay
            muted
            playsInline
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              transform: 'scaleX(-1)', // mirror self-view
              display: cameraOn ? 'block' : 'none',
            }}
          />

          {/* Camera-off placeholder */}
          {!cameraOn && (
            <div style={cameraOffOverlayStyle}>
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: '50%',
                  background: 'linear-gradient(135deg, rgba(59,130,246,0.18) 0%, rgba(99,102,241,0.14) 100%)',
                  border: '1px solid rgba(59,130,246,0.2)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#3b82f6',
                }}
              >
                <VideoOff size={28} strokeWidth={1.5} />
              </div>
              <span style={{ fontSize: '0.8rem', color: '#475569', fontWeight: 500 }}>
                Camera is off
              </span>
            </div>
          )}

          {/* Media error message */}
          {mediaError && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexDirection: 'column',
                gap: 8,
                padding: 16,
                background: 'rgba(10,12,19,0.92)',
                textAlign: 'center',
              }}
            >
              <VideoOff size={24} color="#ef4444" />
              <span style={{ fontSize: '0.78rem', color: '#94a3b8', lineHeight: 1.5 }}>
                {mediaError}
              </span>
            </div>
          )}
        </div>

        {/* Mic level meter */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Mic size={13} color={micOn ? '#22c55e' : '#475569'} />
            <span style={{ fontSize: '0.72rem', color: '#475569', fontWeight: 500 }}>
              {micOn ? 'Microphone' : 'Microphone (muted)'}
            </span>
          </div>
          {/* Track */}
          <div
            style={{
              width: '100%',
              height: 6,
              borderRadius: 3,
              background: 'rgba(255,255,255,0.06)',
              overflow: 'hidden',
            }}
          >
            {/* Fill */}
            <div
              style={{
                height: '100%',
                width: `${micOn ? micLevel : 0}%`,
                borderRadius: 3,
                background: micLevel > 70
                  ? '#f59e0b'
                  : '#22c55e',
                transition: 'width 80ms linear, background 200ms',
              }}
            />
          </div>
        </div>

        {/* Toggle buttons */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20 }}>
          {/* Camera toggle */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              onClick={handleCameraToggle}
              disabled={!!mediaError}
              aria-label={cameraOn ? 'Turn camera off' : 'Turn camera on'}
              style={cameraOn ? toggleBtnOn : toggleBtnOff}
            >
              {cameraOn ? <Video size={20} /> : <VideoOff size={20} />}
            </button>
            <span style={{ fontSize: '0.65rem', color: cameraOn ? '#22c55e' : '#475569', fontWeight: 500 }}>
              {cameraOn ? 'Camera On' : 'Camera Off'}
            </span>
          </div>

          {/* Mic toggle */}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              onClick={handleMicToggle}
              disabled={!!mediaError}
              aria-label={micOn ? 'Mute microphone' : 'Unmute microphone'}
              style={micOn ? toggleBtnOn : toggleBtnOff}
            >
              {micOn ? <Mic size={20} /> : <MicOff size={20} />}
            </button>
            <span style={{ fontSize: '0.65rem', color: micOn ? '#22c55e' : '#475569', fontWeight: 500 }}>
              {micOn ? 'Mic On' : 'Mic Off'}
            </span>
          </div>
        </div>

        {/* Join + Cancel */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <button
            type="button"
            onClick={handleJoin}
            disabled={joining}
            style={{
              width: '100%',
              height: 48,
              borderRadius: 10,
              background: joining ? 'rgba(34,197,94,0.4)' : '#22c55e',
              border: 'none',
              color: '#fff',
              fontSize: '0.95rem',
              fontWeight: 700,
              cursor: joining ? 'not-allowed' : 'pointer',
              letterSpacing: '-0.01em',
              transition: 'background 0.15s, opacity 0.15s',
              boxShadow: joining ? 'none' : '0 4px 18px rgba(34,197,94,0.35)',
            }}
          >
            {joining ? 'Joining...' : 'Join Meeting'}
          </button>

          <button
            type="button"
            onClick={onCancel}
            style={{
              background: 'none',
              border: 'none',
              color: '#475569',
              cursor: 'pointer',
              fontSize: '0.82rem',
              fontWeight: 500,
              padding: '4px 0',
              textDecoration: 'underline',
              textDecorationColor: 'rgba(71,85,105,0.4)',
              transition: 'color 0.15s',
            }}
          >
            Cancel
          </button>
        </div>

      </div>
    </div>
  );
}

/* ─── Main component ─────────────────────────────────────── */

const GLOBAL_STYLES = `
  @keyframes conferencePulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%       { opacity: 0.6; transform: scale(1.02); }
  }
  @keyframes talkBar0 { from { height: 4px; } to { height: 10px; } }
  @keyframes talkBar1 { from { height: 8px; } to { height: 14px; } }
  @keyframes talkBar2 { from { height: 6px; } to { height: 11px; } }
  .tile-container:hover .tile-controls { opacity: 1 !important; }
`;

export function ConferenceRoom({
  conferenceId,
  conferenceName,
  isModerator,
  onJoin,
  onCancel,
}: ConferenceRoomProps) {
  const {
    activeCall,
    hangupCall,
    muteCall,
    unmuteCall,
    localVideoStream,
    remoteVideoStream,
    getLocalStream,
    startScreenShare,
    stopScreenShare,
    setCameraEnabled,
    credentials,
  } = useSoftphone();

  /*
   * ── Lobby state ─────────────────────────────────────────
   *
   * Starts as 'lobby'. Transitions to 'joined' when the user clicks
   * "Join Meeting" in the Lobby. The conference grid becomes visible once
   * activeCall is also non-null (makeCall has completed).
   *
   * IMPORTANT: this useState must remain above ALL early returns to satisfy
   * React rule #310 (hooks must not be called conditionally).
   */
  const [lobbyState, setLobbyState] = useState<'lobby' | 'joined'>('lobby');

  const [liveStatus, setLiveStatus] = useState<ConferenceLiveStatus | null>(null);
  const [showParticipants, setShowParticipants] = useState(false);
  const [cameraOn, setCameraOn] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Ref for the hidden <audio> element that plays remote audio/video. */
  const remoteAudioRef = useRef<HTMLAudioElement>(null);

  /*
   * ── Self-view stream resolution ─────────────────────────
   *
   * localVideoStream from context is set via onStreamChange, which fires
   * during makeCall — potentially before ConferenceRoom mounts. If the
   * context state is already populated we use it directly. If it is null
   * (race: component mounted before the state update propagated), we read
   * the stream synchronously from the VertoClient session via getLocalStream.
   */
  const selfViewStream = activeCall
    ? (localVideoStream ?? getLocalStream(activeCall.id))
    : null;

  /*
   * ── Remote audio binding ─────────────────────────────────
   *
   * A detached new Audio() element cannot reliably autoplay without a prior
   * user gesture (NotAllowedError). Instead we render a hidden <audio> inside
   * this component — which is already inside the user-gesture context from
   * the "Join Conference" click — and bind remoteVideoStream to it here.
   *
   * WHY !!activeCall is in the dependency array:
   * The <audio> element lives below the `if (!activeCall) return null` guard,
   * so remoteAudioRef.current is null until activeCall is truthy and the
   * element mounts. remoteVideoStream can arrive via ontrack before the first
   * render that includes the <audio> element. Including !!activeCall ensures
   * the effect re-runs once the element actually exists in the DOM, so the
   * srcObject assignment is never silently skipped on a null ref.
   */
  useEffect(() => {
    const el = remoteAudioRef.current;
    if (!el) return;
    el.srcObject = remoteVideoStream;
    if (remoteVideoStream) {
      void el.play().catch(() => undefined);
    }
  }, [remoteVideoStream, activeCall]);

  /* ── Poll live status every 3 seconds ─────────────────── */

  const fetchLiveStatus = useCallback(async () => {
    try {
      const status = await getConferenceLiveStatus(conferenceId);
      setLiveStatus(status);
      setIsRecording(status.recording);
    } catch {
      // Silently ignore — conference may not be active yet
    }
  }, [conferenceId]);

  useEffect(() => {
    void fetchLiveStatus();
    pollRef.current = setInterval(() => void fetchLiveStatus(), 3_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchLiveStatus]);

  /*
   * ── Transition to 'joined' once activeCall arrives ──────
   *
   * When makeCall completes and the SoftphoneContext sets activeCall, we
   * flip lobbyState so the conference grid replaces the "Joining..." state.
   */
  useEffect(() => {
    if (activeCall && lobbyState === 'lobby') {
      setLobbyState('joined');
    }
  }, [activeCall, lobbyState]);

  /* ── Recording ─────────────────────────────────────────── */

  const toggleRecording = useCallback(async () => {
    try {
      if (isRecording) {
        await stopRecording(conferenceId);
        setIsRecording(false);
      } else {
        await startRecording(conferenceId);
        setIsRecording(true);
      }
    } catch {
      // Ignore — moderator action; next live-status poll will sync the flag
    }
  }, [isRecording, conferenceId]);

  /* ── Handlers ──────────────────────────────────────────── */

  const handleKick = useCallback(async (memberId: number) => {
    try {
      await kickMember(conferenceId, memberId);
      await fetchLiveStatus();
    } catch {
      // Ignore — moderator action
    }
  }, [conferenceId, fetchLiveStatus]);

  const handleMute = useCallback(async (memberId: number) => {
    try {
      await muteMember(conferenceId, memberId);
      await fetchLiveStatus();
    } catch {
      // Ignore
    }
  }, [conferenceId, fetchLiveStatus]);

  const toggleCamera = useCallback(() => {
    const next = !cameraOn;
    setCameraOn(next);
    setCameraEnabled(next);
  }, [cameraOn, setCameraEnabled]);

  const toggleScreenShare = useCallback(async () => {
    if (activeCall?.isScreenSharing) {
      await stopScreenShare();
    } else {
      await startScreenShare();
    }
  }, [activeCall?.isScreenSharing, startScreenShare, stopScreenShare]);

  const toggleMute = useCallback(() => {
    if (activeCall?.muted) unmuteCall();
    else muteCall();
  }, [activeCall?.muted, muteCall, unmuteCall]);

  /* ── Lobby handler ─────────────────────────────────────── */

  const handleLobbyJoin = useCallback(() => {
    /*
     * Preview stream is stopped inside the Lobby component before this
     * fires, so the conference call's getUserMedia can claim the same
     * hardware tracks without conflict.
     */
    onJoin();
  }, [onJoin]);

  /* ── Lobby render path ─────────────────────────────────── */

  if (lobbyState === 'lobby') {
    return (
      <>
        <style>{GLOBAL_STYLES}</style>
        <Lobby
          conferenceName={conferenceName}
          onJoin={handleLobbyJoin}
          onCancel={onCancel}
        />
      </>
    );
  }

  /* ── Conference grid — only after activeCall is set ─────── */

  if (!activeCall) {
    /*
     * Edge case: lobbyState is 'joined' but makeCall has not resolved yet
     * (the context hasn't propagated activeCall). Show a brief connecting
     * screen rather than nothing, so the user knows their click registered.
     */
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: '#0a0c13',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 200,
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <style>{GLOBAL_STYLES}</style>
        <div
          style={{
            width: 64,
            height: 64,
            borderRadius: 18,
            background: 'linear-gradient(135deg, rgba(34,197,94,0.16) 0%, rgba(16,185,129,0.10) 100%)',
            border: '1px solid rgba(34,197,94,0.25)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#22c55e',
            animation: 'conferencePulse 2s ease-in-out infinite',
          }}
        >
          <Users size={30} strokeWidth={1.5} />
        </div>
        <span style={{ fontSize: '0.9rem', color: '#475569', fontWeight: 500 }}>
          Connecting to {conferenceName}...
        </span>
      </div>
    );
  }

  const members = liveStatus?.members ?? [];
  const memberCount = members.length;
  const isScreenSharing = activeCall.isScreenSharing;

  /* ── Grid column count based on member count ─────────── */

  const cols = memberCount <= 1 ? 1 : memberCount <= 4 ? 2 : memberCount <= 9 ? 3 : 4;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#0a0c12',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 200,
      }}
    >
      <style>{GLOBAL_STYLES}</style>

      {/*
       * Hidden audio element for remote audio playback.
       * Binding happens in the remoteVideoStream useEffect above.
       * Living inside this component — which mounts on user "Join" click —
       * means the browser considers it within a user-gesture context and
       * will not throw NotAllowedError on play().
       */}
      <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: 'none' }} />

      {/* Top bar */}
      <div
        style={{
          height: 56,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          padding: '0 20px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          gap: 12,
          background: 'rgba(10,12,18,0.95)',
          backdropFilter: 'blur(12px)',
        }}
      >
        {/* Recording indicator */}
        {isRecording && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '3px 10px',
              borderRadius: 20,
              background: 'rgba(239,68,68,0.15)',
              border: '1px solid rgba(239,68,68,0.35)',
            }}
          >
            <Circle size={8} fill="#ef4444" color="#ef4444" style={{ animation: 'conferencePulse 1.5s ease-in-out infinite' }} />
            <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#ef4444', letterSpacing: '0.06em' }}>REC</span>
          </div>
        )}

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: '0.9rem', fontWeight: 700, color: '#e2e8f0', letterSpacing: '-0.01em' }}>
            {conferenceName}
          </span>
          <span style={{ fontSize: '0.7rem', color: '#475569' }}>
            {activeCall.state === 'active'
              ? liveStatus?.is_active
                ? `${memberCount} participant${memberCount !== 1 ? 's' : ''} in room`
                : 'Connected'
              : 'Connecting...'}
          </span>
        </div>

        {/* Participant toggle */}
        <button
          type="button"
          onClick={() => setShowParticipants((v) => !v)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            borderRadius: 8,
            background: showParticipants ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.04)',
            border: showParticipants ? '1px solid rgba(59,130,246,0.35)' : '1px solid rgba(255,255,255,0.07)',
            color: showParticipants ? '#60a5fa' : '#64748b',
            cursor: 'pointer',
            fontSize: '0.8rem',
            fontWeight: 500,
            transition: 'all 0.15s',
          }}
        >
          <Users size={14} />
          {memberCount > 0 && memberCount}
        </button>
      </div>

      {/* Main body: video grid + optional sidebar */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Video grid — equal tiles for every participant including self */}
        <div
          style={{
            flex: 1,
            padding: 8,
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {members.length === 0 ? (
            /* Empty state while waiting for others */
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 16,
              }}
            >
              <div
                style={{
                  width: 80,
                  height: 80,
                  borderRadius: 22,
                  background: 'linear-gradient(135deg, rgba(59,130,246,0.16) 0%, rgba(129,140,248,0.10) 100%)',
                  border: '1px solid rgba(59,130,246,0.20)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#3b82f6',
                  animation: 'conferencePulse 3s ease-in-out infinite',
                }}
              >
                <Users size={36} strokeWidth={1.5} />
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '1rem', fontWeight: 600, color: '#64748b', marginBottom: 6 }}>
                  Waiting for participants
                </div>
                <div style={{ fontSize: '0.8rem', color: '#334155' }}>
                  Share the room code so others can join
                </div>
              </div>
            </div>
          ) : (
            /*
             * Equal grid — every participant gets the same-sized tile.
             *
             * Column count:   1 person → 1 col, 2-4 → 2 cols, 5-9 → 3 cols, 10+ → 4 cols.
             * The grid fills the available flex space and tiles stretch to fill it,
             * so a 2-person call gets two side-by-side tiles of equal size.
             *
             * Stream assignment (FreeSWITCH passthrough sends ONE remote stream):
             *   - Local tile (caller_id_number === credentials.extension):
             *       → selfViewStream (own camera), mirrored.
             *   - Remote tiles: → remoteVideoStream (the active speaker feed).
             *       If remoteVideoStream is null (not yet connected), show avatar.
             *   - When credentials are unavailable, index 0 is treated as local.
             */
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${cols}, 1fr)`,
                gap: 8,
                width: '100%',
                height: '100%',
                alignContent: 'center',
              }}
            >
              {members.map((m, index) => {
                const localExtension = credentials?.extension ?? null;
                const isLocalTile = localExtension !== null
                  ? m.caller_id_number === localExtension
                  : index === 0;

                const tileStream: MediaStream | null = isLocalTile
                  ? (cameraOn ? (selfViewStream ?? null) : null)
                  : (remoteVideoStream ?? null);

                return (
                  <div key={m.id} className="tile-container" style={{ position: 'relative' }}>
                    <VideoTile
                      member={m}
                      isModerator={isModerator}
                      onKick={handleKick}
                      onMute={handleMute}
                      videoStream={tileStream}
                      mirrorVideo={isLocalTile && cameraOn}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Participant sidebar */}
        {showParticipants && (
          <ParticipantSidebar
            members={members}
            isModerator={isModerator}
            onKick={handleKick}
            onMute={handleMute}
            onClose={() => setShowParticipants(false)}
          />
        )}
      </div>

      {/* Controls bar */}
      <div
        style={{
          height: 80,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 20,
          borderTop: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(10,12,18,0.95)',
          backdropFilter: 'blur(12px)',
          padding: '0 24px',
        }}
      >
        {/* Mute */}
        <CtrlBtn
          onClick={toggleMute}
          label={activeCall.muted ? 'Unmute' : 'Mute'}
          active={activeCall.muted}
        >
          {activeCall.muted ? <MicOff size={20} /> : <Mic size={20} />}
        </CtrlBtn>

        {/* Camera */}
        {activeCall.isVideo && (
          <CtrlBtn
            onClick={toggleCamera}
            label={cameraOn ? 'Camera Off' : 'Camera On'}
            active={!cameraOn}
          >
            {cameraOn ? <Video size={20} /> : <VideoOff size={20} />}
          </CtrlBtn>
        )}

        {/* Screen share */}
        <CtrlBtn
          onClick={() => void toggleScreenShare()}
          label={isScreenSharing ? 'Stop Share' : 'Share'}
          active={isScreenSharing}
        >
          {isScreenSharing ? <MonitorOff size={20} /> : <Monitor size={20} />}
        </CtrlBtn>

        {/* Recording indicator/toggle (moderator only) */}
        {isModerator && (
          <CtrlBtn
            onClick={() => void toggleRecording()}
            label={isRecording ? 'Stop Rec' : 'Record'}
            active={isRecording}
          >
            {isRecording ? <Square size={20} /> : <Circle size={20} />}
          </CtrlBtn>
        )}

        {/* Leave */}
        <CtrlBtn onClick={hangupCall} label="Leave" danger>
          <PhoneOff size={20} />
        </CtrlBtn>
      </div>
    </div>
  );
}
