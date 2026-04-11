import { useEffect, useState, useCallback, useRef } from 'react';
import { listVoicemails, deleteVoicemail, markVoicemailRead } from '../api/voicemail';
import { useSoftphone } from '../contexts/SoftphoneContext';
import type { VoicemailMessage } from '../types/softphone';

/* ─── Icons ──────────────────────────────────────────────── */

const IconVoicemail = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ width: 22, height: 22 }}>
    <path d="M5.25 8.25a3 3 0 1 0 6 0 3 3 0 0 0-6 0ZM12.75 8.25a3 3 0 1 0 6 0 3 3 0 0 0-6 0Z" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M2.25 14.25h7.5M14.25 14.25h7.5M5.25 14.25a3.75 3.75 0 0 0 0 0M18.75 14.25a3.75 3.75 0 0 0 0 0" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconPlay = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 16, height: 16 }}>
    <path fillRule="evenodd" d="M4.5 5.653c0-1.427 1.529-2.33 2.779-1.643l11.54 6.347c1.295.712 1.295 2.573 0 3.286L7.28 19.99c-1.25.687-2.779-.217-2.779-1.643V5.653Z" clipRule="evenodd" />
  </svg>
);

const IconPause = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 16, height: 16 }}>
    <path fillRule="evenodd" d="M6.75 5.25a.75.75 0 0 1 .75-.75H9a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H7.5a.75.75 0 0 1-.75-.75V5.25Zm7.5 0A.75.75 0 0 1 15 4.5h1.5a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H15a.75.75 0 0 1-.75-.75V5.25Z" clipRule="evenodd" />
  </svg>
);

const IconDelete = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ width: 16, height: 16 }}>
    <path d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconCallBack = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ width: 14, height: 14 }}>
    <path d="M2.25 6.338c0 12.03 9.716 21.75 21.75 21.75" strokeLinecap="round" strokeLinejoin="round" />
    <path d="m2.25 6.338 3.56-3.56a1.5 1.5 0 0 1 2.121 0l2.296 2.296a1.5 1.5 0 0 1 0 2.122l-1.054 1.053c-.226.226-.296.56-.144.849a13.478 13.478 0 0 0 5.636 5.635c.29.153.624.083.85-.143l1.053-1.054a1.5 1.5 0 0 1 2.122 0l2.296 2.296a1.5 1.5 0 0 1 0 2.121l-3.56 3.56" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/* ─── Helpers ────────────────────────────────────────────── */

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}:${String(sec).padStart(2, '0')}` : `0:${String(sec).padStart(2, '0')}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffDays === 0) {
    const diffH = Math.floor(diffMs / 3600000);
    if (diffH === 0) {
      const diffM = Math.floor(diffMs / 60000);
      return diffM < 2 ? 'Just now' : `${diffM} minutes ago`;
    }
    return diffH === 1 ? '1 hour ago' : `${diffH} hours ago`;
  }
  if (diffDays === 1) return 'Yesterday ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'long' }) + ', ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

/* ─── Audio player component ─────────────────────────────── */

interface AudioPlayerProps {
  url: string;
  onPlay?: () => void;
}

function AudioPlayer({ url, onPlay }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
    } else {
      onPlay?.();
      void audio.play();
    }
  }, [isPlaying, onPlay]);

  const handleTimeUpdate = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    setProgress(audio.duration ? audio.currentTime / audio.duration : 0);
  }, []);

  const handleScrub = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    audio.currentTime = pct * audio.duration;
  }, []);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
      <audio
        ref={audioRef}
        src={url}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => { setIsPlaying(false); setProgress(0); }}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={() => { setDuration(audioRef.current?.duration ?? 0); }}
        preload="metadata"
      />

      <button
        type="button"
        onClick={toggle}
        aria-label={isPlaying ? 'Pause' : 'Play'}
        style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #3b82f6 0%, #60a5fa 100%)',
          border: 'none',
          color: '#fff',
          cursor: 'pointer',
          flexShrink: 0,
          boxShadow: '0 2px 10px rgba(59,130,246,0.35)',
          transition: 'transform 0.1s',
        }}
        onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.92)'; }}
        onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
      >
        {isPlaying ? <IconPause /> : <IconPlay />}
      </button>

      {/* Progress bar */}
      <div
        onClick={handleScrub}
        role="progressbar"
        aria-valuenow={Math.round(progress * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Playback progress"
        style={{
          flex: 1,
          height: 4,
          background: 'rgba(255,255,255,0.08)',
          borderRadius: 2,
          cursor: 'pointer',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${progress * 100}%`,
            background: 'linear-gradient(90deg, #3b82f6, #60a5fa)',
            borderRadius: 2,
            transition: 'width 0.1s linear',
          }}
        />
      </div>

      {/* Time display */}
      <span style={{ fontSize: '0.7rem', color: '#64748b', flexShrink: 0, fontVariantNumeric: 'tabular-nums', minWidth: 36, textAlign: 'right' }}>
        {duration > 0 ? formatDuration(Math.floor(progress * duration * 1000)) : '—'}
      </span>
    </div>
  );
}

/* ─── Main page ──────────────────────────────────────────── */

export function VoicemailPage() {
  const { refreshVoicemailCount, makeCall, connectionState } = useSoftphone();
  const [messages, setMessages] = useState<VoicemailMessage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingIds, setDeletingIds] = useState<Set<number>>(new Set());
  const [totalUnread, setTotalUnread] = useState(0);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await listVoicemails({ limit: 100 });
      // API returns a bare array, not { items, unread_count }
      const items = Array.isArray(result) ? result : (result.items ?? []);
      setMessages(items);
      const unread = Array.isArray(result) ? items.filter((m) => !m.is_read).length : (result.unread_count ?? 0);
      setTotalUnread(unread);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load voicemails');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDelete = useCallback(async (id: number) => {
    setDeletingIds((prev) => new Set([...prev, id]));
    try {
      await deleteVoicemail(id);
      setMessages((prev) => prev.filter((m) => m.id !== id));
      refreshVoicemailCount();
    } catch {
      // Revert optimistic UI
    } finally {
      setDeletingIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  }, [refreshVoicemailCount]);

  const handleMarkRead = useCallback(async (id: number) => {
    try {
      await markVoicemailRead(id);
      setMessages((prev) => prev.map((m) => m.id === id ? { ...m, is_read: true } : m));
      setTotalUnread((prev) => Math.max(0, prev - 1));
      refreshVoicemailCount();
    } catch {
      // Not critical — ignore
    }
  }, [refreshVoicemailCount]);

  const unreadMessages = messages.filter((m) => !m.is_read);
  const readMessages = messages.filter((m) => m.is_read);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 12,
                background: 'linear-gradient(135deg, rgba(99,102,241,0.25) 0%, rgba(59,130,246,0.20) 100%)',
                border: '1px solid rgba(99,102,241,0.30)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#818cf8',
              }}
            >
              <IconVoicemail />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.03em' }}>
                  Voicemail
                </h1>
                {totalUnread > 0 && (
                  <span
                    style={{
                      background: '#ef4444',
                      color: '#fff',
                      fontSize: '0.7rem',
                      fontWeight: 700,
                      borderRadius: 10,
                      padding: '2px 8px',
                      letterSpacing: '0.02em',
                    }}
                  >
                    {totalUnread} new
                  </span>
                )}
              </div>
              <p style={{ margin: 0, fontSize: '0.875rem', color: '#475569', marginTop: 2 }}>
                Visual voicemail — listen, call back, or delete
              </p>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => void load()}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 14px',
            borderRadius: 8,
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.08)',
            color: '#64748b',
            fontSize: '0.8rem',
            cursor: 'pointer',
            fontWeight: 500,
          }}
        >
          Refresh
        </button>
      </div>

      {/* Error state */}
      {error && (
        <div
          style={{
            padding: '12px 16px',
            borderRadius: 10,
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.20)',
            color: '#f87171',
            fontSize: '0.875rem',
          }}
        >
          {error}
        </div>
      )}

      {/* Loading state */}
      {isLoading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
          <div style={{ width: 28, height: 28, border: '2px solid rgba(255,255,255,0.08)', borderTopColor: '#3b82f6', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        </div>
      ) : messages.length === 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            padding: '64px 24px',
            color: '#334155',
          }}
        >
          <IconVoicemail />
          <div style={{ fontSize: '1rem', fontWeight: 600 }}>No voicemail messages</div>
          <div style={{ fontSize: '0.875rem', color: '#1e293b' }}>New messages will appear here</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {/* Unread section */}
          {unreadMessages.length > 0 && (
            <MessageSection
              title="New Messages"
              count={unreadMessages.length}
              messages={unreadMessages}
              onDelete={handleDelete}
              onMarkRead={handleMarkRead}
              onCallBack={(num) => void makeCall(num)}
              canCallBack={connectionState === 'registered'}
              deletingIds={deletingIds}
              accentColor="#ef4444"
            />
          )}

          {/* Read section */}
          {readMessages.length > 0 && (
            <MessageSection
              title="Heard"
              count={readMessages.length}
              messages={readMessages}
              onDelete={handleDelete}
              onMarkRead={handleMarkRead}
              onCallBack={(num) => void makeCall(num)}
              canCallBack={connectionState === 'registered'}
              deletingIds={deletingIds}
              accentColor="#3b82f6"
            />
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Message section ────────────────────────────────────── */

interface MessageSectionProps {
  title: string;
  count: number;
  messages: VoicemailMessage[];
  onDelete: (id: number) => Promise<void>;
  onMarkRead: (id: number) => Promise<void>;
  onCallBack: (number: string) => void;
  canCallBack: boolean;
  deletingIds: Set<number>;
  accentColor: string;
}

function MessageSection({
  title,
  count,
  messages,
  onDelete,
  onMarkRead,
  onCallBack,
  canCallBack,
  deletingIds,
  accentColor,
}: MessageSectionProps) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
          {title}
        </span>
        <span
          style={{
            fontSize: '0.65rem',
            fontWeight: 700,
            background: `${accentColor}18`,
            color: accentColor,
            border: `1px solid ${accentColor}30`,
            borderRadius: 8,
            padding: '1px 6px',
          }}
        >
          {count}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {messages.map((msg) => (
          <VoicemailCard
            key={msg.id}
            message={msg}
            onDelete={() => void onDelete(msg.id)}
            onMarkRead={() => void onMarkRead(msg.id)}
            onCallBack={() => onCallBack(msg.caller_id)}
            canCallBack={canCallBack}
            isDeleting={deletingIds.has(msg.id)}
          />
        ))}
      </div>
    </div>
  );
}

/* ─── Voicemail card ─────────────────────────────────────── */

interface VoicemailCardProps {
  message: VoicemailMessage;
  onDelete: () => void;
  onMarkRead: () => void;
  onCallBack: () => void;
  canCallBack: boolean;
  isDeleting: boolean;
}

function VoicemailCard({ message, onDelete, onMarkRead, onCallBack, canCallBack, isDeleting }: VoicemailCardProps) {
  const hasAudio = Boolean(message.audio_url);
  const displayName = message.caller_name && message.caller_name !== message.caller_id
    ? message.caller_name
    : null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '14px 16px',
        borderRadius: 12,
        background: message.is_read ? 'rgba(255,255,255,0.025)' : 'rgba(99,102,241,0.06)',
        border: `1px solid ${message.is_read ? 'rgba(255,255,255,0.05)' : 'rgba(99,102,241,0.15)'}`,
        transition: 'opacity 0.2s',
        opacity: isDeleting ? 0.4 : 1,
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {/* Unread indicator */}
        {!message.is_read && (
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: '#818cf8',
              flexShrink: 0,
              boxShadow: '0 0 6px #818cf880',
            }}
          />
        )}

        {/* Avatar */}
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, rgba(99,102,241,0.20) 0%, rgba(59,130,246,0.15) 100%)',
            border: '1px solid rgba(99,102,241,0.20)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '0.9rem',
            fontWeight: 700,
            color: '#818cf8',
            flexShrink: 0,
          }}
        >
          {(displayName ?? message.caller_id).charAt(0).toUpperCase()}
        </div>

        {/* Caller info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {displayName && (
            <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#f1f5f9', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {displayName}
            </div>
          )}
          <div style={{ fontSize: displayName ? '0.78rem' : '0.9rem', color: displayName ? '#64748b' : '#f1f5f9', fontFamily: 'monospace', fontWeight: 600 }}>
            {message.caller_id}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
            <span style={{ fontSize: '0.68rem', color: '#334155' }}>
              {formatDate(message.created_at)}
            </span>
            <span style={{ color: '#1e293b' }}>·</span>
            <span style={{ fontSize: '0.68rem', color: '#334155' }}>
              {formatDuration(message.duration_ms)}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {canCallBack && (
            <button
              type="button"
              onClick={onCallBack}
              aria-label={`Call back ${message.caller_id}`}
              title="Call back"
              style={{
                width: 30,
                height: 30,
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(34,197,94,0.10)',
                border: '1px solid rgba(34,197,94,0.25)',
                color: '#22c55e',
                cursor: 'pointer',
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(34,197,94,0.20)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(34,197,94,0.10)'; }}
            >
              <IconCallBack />
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            disabled={isDeleting}
            aria-label="Delete voicemail"
            title="Delete"
            style={{
              width: 30,
              height: 30,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.20)',
              color: '#f87171',
              cursor: isDeleting ? 'not-allowed' : 'pointer',
              transition: 'background 0.15s',
              opacity: isDeleting ? 0.5 : 1,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(239,68,68,0.18)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(239,68,68,0.08)'; }}
          >
            <IconDelete />
          </button>
        </div>
      </div>

      {/* Audio player */}
      {hasAudio ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingLeft: message.is_read ? 0 : 20 }}>
          <AudioPlayer
            url={message.audio_url!}
            onPlay={() => { if (!message.is_read) void onMarkRead(); }}
          />
        </div>
      ) : (
        <div
          style={{
            padding: '8px 12px',
            borderRadius: 8,
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.05)',
            fontSize: '0.78rem',
            color: '#334155',
            paddingLeft: message.is_read ? 12 : 32,
          }}
        >
          Audio not available — message may be stored on the server
        </div>
      )}

      {/* Mark as read button for unread messages without audio interaction */}
      {!message.is_read && !hasAudio && (
        <button
          type="button"
          onClick={onMarkRead}
          style={{
            alignSelf: 'flex-start',
            padding: '4px 10px',
            borderRadius: 6,
            background: 'transparent',
            border: '1px solid rgba(99,102,241,0.25)',
            color: '#818cf8',
            fontSize: '0.7rem',
            cursor: 'pointer',
            marginLeft: 20,
          }}
        >
          Mark as heard
        </button>
      )}
    </div>
  );
}
