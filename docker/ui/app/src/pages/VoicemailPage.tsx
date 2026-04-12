import { useEffect, useState, useCallback, useRef } from 'react';
import { listVoicemails, deleteVoicemail, markVoicemailRead } from '../api/voicemail';
import { useSoftphone } from '../contexts/SoftphoneContext';
import { Sidebar } from '../components/layout/Sidebar';
import { SoftphoneWidget } from '../components/softphone/SoftphoneWidget';
import type { VoicemailMessage } from '../types/softphone';

/* ─── Keyframe injection ─────────────────────────────────── */

const GLOBAL_STYLES = `
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes vmFadeIn {
    from { opacity: 0; transform: translateY(5px); }
    to   { opacity: 1; transform: translateY(0); }
  }
`;

/* ─── Filter type ────────────────────────────────────────── */

type FilterKey = 'all' | 'unread';

/* ─── Icons ──────────────────────────────────────────────── */

const IconVoicemail = ({ size = 22 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ width: size, height: size }}>
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

const IconRefresh = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ width: 14, height: 14 }}>
    <path d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" strokeLinecap="round" strokeLinejoin="round" />
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
      return diffM < 2 ? 'Just now' : `${diffM}m ago`;
    }
    return `${diffH}h ago`;
  }
  if (diffDays === 1) return 'Yesterday ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'long' }) + ', ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

/* ─── Audio player ───────────────────────────────────────── */

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
        padding: '14px 20px',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        background: message.is_read ? 'transparent' : 'rgba(99,102,241,0.04)',
        transition: 'background 0.15s, opacity 0.2s',
        opacity: isDeleting ? 0.4 : 1,
        animation: 'vmFadeIn 0.18s ease-out',
        cursor: 'default',
      }}
      onMouseEnter={(e) => {
        if (!isDeleting) (e.currentTarget as HTMLDivElement).style.background = message.is_read ? 'rgba(255,255,255,0.025)' : 'rgba(99,102,241,0.07)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = message.is_read ? 'transparent' : 'rgba(99,102,241,0.04)';
      }}
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {/* Unread dot */}
        {!message.is_read && (
          <div
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: '#818cf8',
              flexShrink: 0,
              boxShadow: '0 0 6px rgba(129,140,248,0.55)',
            }}
          />
        )}

        {/* Avatar */}
        <div
          style={{
            width: 38,
            height: 38,
            borderRadius: '50%',
            background: 'linear-gradient(135deg, rgba(99,102,241,0.20) 0%, rgba(59,130,246,0.15) 100%)',
            border: '1px solid rgba(99,102,241,0.20)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '0.875rem',
            fontWeight: 700,
            color: '#818cf8',
            flexShrink: 0,
            marginLeft: message.is_read ? 15 : 0,
          }}
        >
          {(displayName ?? message.caller_id).charAt(0).toUpperCase()}
        </div>

        {/* Caller info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {displayName && (
            <div style={{ fontSize: '0.875rem', fontWeight: 700, color: '#f1f5f9', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {displayName}
            </div>
          )}
          <div style={{ fontSize: displayName ? '0.78rem' : '0.875rem', color: displayName ? '#64748b' : '#e2e8f0', fontFamily: 'monospace', fontWeight: 600 }}>
            {message.caller_id}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
            <span style={{ fontSize: '0.7rem', color: '#475569' }}>
              {formatDate(message.created_at)}
            </span>
            <span style={{ color: '#1e293b', fontSize: '0.7rem' }}>·</span>
            <span style={{ fontSize: '0.7rem', color: '#475569' }}>
              {formatDuration(message.duration_ms)}
            </span>
          </div>
        </div>

        {/* Action buttons */}
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
            onMouseEnter={(e) => { if (!isDeleting) e.currentTarget.style.background = 'rgba(239,68,68,0.18)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(239,68,68,0.08)'; }}
          >
            <IconDelete />
          </button>
        </div>
      </div>

      {/* Audio player */}
      {hasAudio ? (
        <div style={{ paddingLeft: message.is_read ? 50 : 34, paddingRight: 2 }}>
          <AudioPlayer
            url={message.audio_url!}
            onPlay={() => { if (!message.is_read) void onMarkRead(); }}
          />
        </div>
      ) : (
        <div
          style={{
            marginLeft: message.is_read ? 50 : 34,
            padding: '7px 12px',
            borderRadius: 8,
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.05)',
            fontSize: '0.75rem',
            color: '#334155',
          }}
        >
          Audio not available — message may be stored on the server
        </div>
      )}

      {/* Mark as read — only when no audio to trigger it automatically */}
      {!message.is_read && !hasAudio && (
        <button
          type="button"
          onClick={onMarkRead}
          style={{
            alignSelf: 'flex-start',
            marginLeft: 34,
            padding: '4px 10px',
            borderRadius: 6,
            background: 'transparent',
            border: '1px solid rgba(99,102,241,0.25)',
            color: '#818cf8',
            fontSize: '0.7rem',
            cursor: 'pointer',
          }}
        >
          Mark as heard
        </button>
      )}
    </div>
  );
}

/* ─── Left panel filter item ─────────────────────────────── */

interface FilterItemProps {
  label: string;
  count: number;
  isSelected: boolean;
  badgeColor?: 'red' | 'blue' | 'neutral';
  onClick: () => void;
}

function FilterItem({ label, count, isSelected, badgeColor = 'neutral', onClick }: FilterItemProps) {
  const badgeStyles: Record<string, React.CSSProperties> = {
    red:     { background: 'rgba(239,68,68,0.15)',   color: '#f87171', border: '1px solid rgba(239,68,68,0.25)' },
    blue:    { background: 'rgba(59,130,246,0.15)',  color: '#60a5fa', border: '1px solid rgba(59,130,246,0.25)' },
    neutral: { background: 'rgba(255,255,255,0.06)', color: '#475569', border: 'none' },
  };

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 14px',
        borderRadius: 8,
        cursor: 'pointer',
        userSelect: 'none',
        background: isSelected
          ? 'linear-gradient(135deg, rgba(59,130,246,0.16) 0%, rgba(59,130,246,0.08) 100%)'
          : 'transparent',
        color: isSelected ? '#93c5fd' : '#64748b',
        transition: 'background 0.12s, color 0.12s',
        marginBottom: 2,
      }}
      onMouseEnter={(e) => {
        if (!isSelected) {
          (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.04)';
          (e.currentTarget as HTMLDivElement).style.color = '#94a3b8';
        }
      }}
      onMouseLeave={(e) => {
        if (!isSelected) {
          (e.currentTarget as HTMLDivElement).style.background = 'transparent';
          (e.currentTarget as HTMLDivElement).style.color = '#64748b';
        }
      }}
    >
      {/* Voicemail icon */}
      <span style={{ flexShrink: 0, display: 'flex', color: isSelected ? '#60a5fa' : 'inherit' }}>
        <IconVoicemail size={15} />
      </span>

      <span style={{
        flex: 1,
        fontSize: '0.825rem',
        fontWeight: isSelected ? 700 : 500,
        color: isSelected ? '#e2e8f0' : 'inherit',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {label}
      </span>

      {count > 0 && (
        <span style={{ fontSize: '0.65rem', fontWeight: 700, borderRadius: 4, padding: '1px 5px', flexShrink: 0, ...badgeStyles[badgeColor] }}>
          {count}
        </span>
      )}
      {count === 0 && (
        <span style={{ fontSize: '0.65rem', color: '#475569', background: 'rgba(255,255,255,0.06)', borderRadius: 4, padding: '1px 5px', flexShrink: 0 }}>
          0
        </span>
      )}
    </div>
  );
}

/* ─── Empty / loading states for right panel ─────────────── */

function RightPanelEmpty() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: 14,
        padding: 48,
        color: '#334155',
      }}
    >
      <div
        style={{
          width: 72,
          height: 72,
          borderRadius: 20,
          background: 'linear-gradient(135deg, rgba(99,102,241,0.12) 0%, rgba(59,130,246,0.08) 100%)',
          border: '1px solid rgba(99,102,241,0.18)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#6366f1',
        }}
      >
        <IconVoicemail size={32} />
      </div>
      <div style={{ textAlign: 'center', maxWidth: 260 }}>
        <div style={{ fontSize: '1rem', fontWeight: 700, color: '#94a3b8', marginBottom: 6, letterSpacing: '-0.02em' }}>
          No voicemail messages
        </div>
        <div style={{ fontSize: '0.85rem', color: '#475569', lineHeight: 1.6 }}>
          New messages will appear here as they arrive.
        </div>
      </div>
    </div>
  );
}

function RightPanelNoUnread() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: 14,
        padding: 48,
        color: '#334155',
      }}
    >
      <div
        style={{
          width: 72,
          height: 72,
          borderRadius: 20,
          background: 'linear-gradient(135deg, rgba(34,197,94,0.12) 0%, rgba(59,130,246,0.08) 100%)',
          border: '1px solid rgba(34,197,94,0.18)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#22c55e',
        }}
      >
        <IconVoicemail size={32} />
      </div>
      <div style={{ textAlign: 'center', maxWidth: 260 }}>
        <div style={{ fontSize: '1rem', fontWeight: 700, color: '#94a3b8', marginBottom: 6 }}>
          All caught up
        </div>
        <div style={{ fontSize: '0.85rem', color: '#475569', lineHeight: 1.6 }}>
          No unread voicemails. Switch to All Messages to see your history.
        </div>
      </div>
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
  const [filter, setFilter] = useState<FilterKey>('all');

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await listVoicemails({ limit: 100 });
      const items = Array.isArray(result) ? result : (result.items ?? []);
      setMessages(items);
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
      // Revert optimistic UI — just leave the item; a reload will fix state
    } finally {
      setDeletingIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  }, [refreshVoicemailCount]);

  const handleMarkRead = useCallback(async (id: number) => {
    try {
      await markVoicemailRead(id);
      setMessages((prev) => prev.map((m) => m.id === id ? { ...m, is_read: true } : m));
      refreshVoicemailCount();
    } catch {
      // Not critical — ignore
    }
  }, [refreshVoicemailCount]);

  /* ── Derived counts ──────────────────────────────────────── */
  const totalCount = messages.length;
  const unreadCount = messages.filter((m) => !m.is_read).length;

  const visibleMessages = filter === 'unread'
    ? messages.filter((m) => !m.is_read)
    : messages;

  const filterLabel = filter === 'unread' ? 'Unread' : 'All Messages';

  /* ── Render ──────────────────────────────────────────────── */
  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
        background: '#0f1117',
      }}
    >
      <style>{GLOBAL_STYLES}</style>

      {/* Fixed sidebar — same as AppLayout and other full-screen pages */}
      <Sidebar />

      {/* Main shell — fills space to the right of the sidebar */}
      <div
        style={{
          marginLeft: 240,
          flex: 1,
          display: 'flex',
          overflow: 'hidden',
          height: '100vh',
        }}
      >
        {/* ── Left panel: filter list (280px) ─────────────── */}
        <div
          style={{
            width: 280,
            flexShrink: 0,
            borderRight: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            background: '#0c0e16',
          }}
        >
          {/* Panel header */}
          <div
            style={{
              padding: '18px 16px 12px',
              borderBottom: '1px solid rgba(255,255,255,0.05)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
              Voicemail
            </span>
            <button
              type="button"
              onClick={() => void load()}
              title="Refresh"
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 7,
                cursor: 'pointer',
                color: '#475569',
                display: 'flex',
                alignItems: 'center',
                padding: '5px 7px',
                transition: 'background 0.15s, color 0.15s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.09)'; e.currentTarget.style.color = '#94a3b8'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = '#475569'; }}
            >
              <IconRefresh />
            </button>
          </div>

          {/* Filter list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px' }}>
            <FilterItem
              label="All Messages"
              count={totalCount}
              isSelected={filter === 'all'}
              badgeColor="neutral"
              onClick={() => setFilter('all')}
            />
            <FilterItem
              label="Unread"
              count={unreadCount}
              isSelected={filter === 'unread'}
              badgeColor="red"
              onClick={() => setFilter('unread')}
            />
          </div>
        </div>

        {/* ── Right panel: message list ────────────────────── */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            minWidth: 0,
            background: '#0f1117',
          }}
        >
          {/* Right panel header */}
          <div
            style={{
              padding: '14px 24px',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: '0.925rem', fontWeight: 700, color: '#e2e8f0', letterSpacing: '-0.02em' }}>
                {filterLabel}
              </span>
              {!isLoading && (
                <span
                  style={{
                    fontSize: '0.7rem',
                    fontWeight: 600,
                    color: '#475569',
                    background: 'rgba(255,255,255,0.06)',
                    borderRadius: 5,
                    padding: '2px 7px',
                  }}
                >
                  {visibleMessages.length} {visibleMessages.length === 1 ? 'message' : 'messages'}
                </span>
              )}
              {unreadCount > 0 && filter === 'all' && (
                <span
                  style={{
                    fontSize: '0.7rem',
                    fontWeight: 700,
                    color: '#f87171',
                    background: 'rgba(239,68,68,0.12)',
                    border: '1px solid rgba(239,68,68,0.22)',
                    borderRadius: 5,
                    padding: '2px 7px',
                  }}
                >
                  {unreadCount} new
                </span>
              )}
            </div>
          </div>

          {/* Error banner */}
          {error && (
            <div
              style={{
                margin: '12px 24px 0',
                padding: '10px 14px',
                borderRadius: 10,
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.20)',
                color: '#f87171',
                fontSize: '0.85rem',
                flexShrink: 0,
              }}
            >
              {error}
            </div>
          )}

          {/* Message list — scrollable */}
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {isLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
                <div style={{ width: 26, height: 26, border: '2px solid rgba(255,255,255,0.08)', borderTopColor: '#3b82f6', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
              </div>
            ) : visibleMessages.length === 0 && filter === 'all' ? (
              <RightPanelEmpty />
            ) : visibleMessages.length === 0 && filter === 'unread' ? (
              <RightPanelNoUnread />
            ) : (
              visibleMessages.map((msg) => (
                <VoicemailCard
                  key={msg.id}
                  message={msg}
                  onDelete={() => void handleDelete(msg.id)}
                  onMarkRead={() => void handleMarkRead(msg.id)}
                  onCallBack={() => void makeCall(msg.caller_id)}
                  canCallBack={connectionState === 'registered'}
                  isDeleting={deletingIds.has(msg.id)}
                />
              ))
            )}
          </div>
        </div>
      </div>

      {/* Softphone overlay */}
      <SoftphoneWidget />
    </div>
  );
}
