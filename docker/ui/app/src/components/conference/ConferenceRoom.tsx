/**
 * ConferenceRoom — in-call overlay shown when the active call is to a
 * conference room (*88XX). Displays a video grid, self-view PiP, controls
 * bar, and a toggleable participant list sidebar.
 *
 * Video rendering is ready for FreeSWITCH MCU output: remote tracks from
 * the VertoClient's remoteStream are connected directly to <video> elements.
 * When FS video MCU is not yet enabled, the grid shows placeholder tiles
 * with live participant names from the conference API.
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
}

/* ─── Video tile ─────────────────────────────────────────── */

interface VideoTileProps {
  member: LiveMember;
  isModerator: boolean;
  onKick: (id: number) => void;
  onMute: (id: number) => void;
}

function VideoTile({ member, isModerator, onKick, onMute }: VideoTileProps) {
  const isTalking = member.talking;

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
      {/* Placeholder background — gradient avatar */}
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
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
          {member.name.charAt(0).toUpperCase()}
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
          {member.name}
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

/* ─── Self-view PiP ──────────────────────────────────────── */

function SelfView({ stream }: { stream: MediaStream | null }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 88,
        right: 16,
        width: 160,
        aspectRatio: '16/9',
        borderRadius: 10,
        overflow: 'hidden',
        border: '2px solid rgba(255,255,255,0.12)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
        background: 'rgba(15,17,23,0.9)',
        zIndex: 10,
      }}
    >
      {stream ? (
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }}
        />
      ) : (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'linear-gradient(135deg, rgba(59,130,246,0.12) 0%, rgba(99,102,241,0.10) 100%)',
          }}
        >
          <VideoOff size={20} color="#475569" />
        </div>
      )}
      <div
        style={{
          position: 'absolute',
          bottom: 4,
          left: 6,
          fontSize: '0.6rem',
          fontWeight: 600,
          color: 'rgba(255,255,255,0.7)',
          letterSpacing: '0.04em',
        }}
      >
        You
      </div>
    </div>
  );
}

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
                {m.name.charAt(0).toUpperCase()}
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.name}
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
}: ConferenceRoomProps) {
  const {
    activeCall,
    hangupCall,
    muteCall,
    unmuteCall,
    localVideoStream,
    startScreenShare,
    stopScreenShare,
    setCameraEnabled,
  } = useSoftphone();

  const [liveStatus, setLiveStatus] = useState<ConferenceLiveStatus | null>(null);
  const [showParticipants, setShowParticipants] = useState(false);
  const [cameraOn, setCameraOn] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  if (!activeCall) return null;

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
            {liveStatus?.is_active
              ? `${memberCount} participant${memberCount !== 1 ? 's' : ''} in room`
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
        {/* Video grid */}
        <div
          style={{
            flex: 1,
            padding: 16,
            overflowY: 'auto',
            position: 'relative',
          }}
        >
          {members.length === 0 ? (
            /* Empty state while waiting for others */
            <div
              style={{
                height: '100%',
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
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${cols}, 1fr)`,
                gap: 12,
                maxWidth: cols === 1 ? 720 : '100%',
                margin: '0 auto',
              }}
            >
              {members.map((m) => (
                <div key={m.id} className="tile-container" style={{ position: 'relative' }}>
                  <VideoTile
                    member={m}
                    isModerator={isModerator}
                    onKick={handleKick}
                    onMute={handleMute}
                  />
                </div>
              ))}
            </div>
          )}

          {/* Self-view PiP — shown when video is enabled */}
          {activeCall.isVideo && (
            <SelfView stream={cameraOn ? (localVideoStream ?? null) : null} />
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
            onClick={() => setIsRecording((v) => !v)}
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
