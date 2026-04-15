import { useState } from 'react';
import { Search, Plus, Users } from 'lucide-react';
import type { Conversation } from '../../types/chat';
import { useAuth } from '../../contexts/AuthContext';

interface ConversationListProps {
  conversations: Conversation[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onNewChat: () => void;
  isLoading: boolean;
}

/* ─── Helpers ────────────────────────────────────────────── */

function formatRelativeTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Derive a stable hue for avatar background — consistent across the app */
function nameColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 58%)`;
}

/* ─── Single conversation row ────────────────────────────── */

interface ConvRowProps {
  conversation: Conversation;
  isSelected: boolean;
  currentUserId: number | undefined;
  onSelect: () => void;
}

function ConvRow({ conversation, isSelected, currentUserId, onSelect }: ConvRowProps) {
  const isGroup = conversation.type === 'group';

  const displayName = isGroup
    ? (conversation.name ?? 'Group')
    : (conversation.participants.find((p) => p.user_id !== currentUserId)?.name ?? 'Direct Message');

  const avatarColor = nameColor(displayName);
  const initial = displayName.charAt(0).toUpperCase();

  const preview = conversation.last_message?.content ?? null;
  const previewSender = conversation.last_message?.sender_name ?? null;
  const timestamp = conversation.last_message?.created_at ?? conversation.updated_at;
  const unread = conversation.unread_count;

  const previewText = preview
    ? (isGroup && previewSender ? `${previewSender.split(' ')[0]}: ${preview}` : preview)
    : 'No messages yet';

  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 14px',
        borderRadius: 8,
        background: isSelected
          ? 'linear-gradient(135deg, rgba(59,130,246,0.16) 0%, rgba(59,130,246,0.08) 100%)'
          : 'transparent',
        border: 'none',
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
        transition: 'background 0.12s, color 0.12s',
      }}
      onMouseEnter={(e) => {
        if (!isSelected) {
          e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
        }
      }}
      onMouseLeave={(e) => {
        if (!isSelected) {
          e.currentTarget.style.background = 'transparent';
        }
      }}
    >
      {/* Avatar with optional group icon overlay */}
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: isGroup ? 11 : '50%',
            background: `${avatarColor}1e`,
            border: `1.5px solid ${avatarColor}38`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '0.9rem',
            fontWeight: 700,
            color: avatarColor,
            userSelect: 'none',
            flexShrink: 0,
          }}
        >
          {isGroup ? (
            <Users size={17} strokeWidth={2} style={{ color: avatarColor }} />
          ) : (
            initial
          )}
        </div>

        {/* Unread notification dot on avatar corner */}
        {unread > 0 && (
          <div
            style={{
              position: 'absolute',
              top: -2,
              right: -2,
              width: 11,
              height: 11,
              borderRadius: '50%',
              background: '#3b82f6',
              border: '2px solid #0c0e16',
              boxShadow: '0 0 6px rgba(59,130,246,0.60)',
            }}
          />
        )}

        {/* Presence dot — shown on DMs when no unread badge (avoid overlap) */}
        {!isGroup && unread === 0 && (() => {
          const other = conversation.participants.find((p) => p.user_id !== currentUserId);
          const isOnline = other?.presence_status === 'available';
          return (
            <div
              style={{
                position: 'absolute',
                bottom: 0,
                right: 0,
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: isOnline ? '#22c55e' : '#475569',
                border: '2px solid #0c0e16',
              }}
            />
          );
        })()}
      </div>

      {/* Text content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 4 }}>
          <span
            style={{
              fontSize: '0.825rem',
              fontWeight: (isSelected || unread > 0) ? 700 : 500,
              color: isSelected ? '#e2e8f0' : (unread > 0 ? '#94a3b8' : '#64748b'),
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
              letterSpacing: '-0.01em',
            }}
          >
            {displayName}
          </span>
          <span
            style={{
              fontSize: '0.68rem',
              color: unread > 0 ? '#60a5fa' : '#475569',
              flexShrink: 0,
              fontVariantNumeric: 'tabular-nums',
              fontWeight: unread > 0 ? 600 : 400,
            }}
          >
            {formatRelativeTime(timestamp)}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, marginTop: 2 }}>
          <span
            style={{
              fontSize: '0.775rem',
              color: unread > 0 ? '#64748b' : '#3d4f63',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
            }}
          >
            {previewText}
          </span>

          {/* Unread count badge */}
          {unread > 0 && (
            <span
              style={{
                minWidth: 19,
                height: 19,
                borderRadius: 10,
                background: 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)',
                color: '#fff',
                fontSize: '0.62rem',
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 5px',
                flexShrink: 0,
                letterSpacing: '0.02em',
                boxShadow: '0 1px 6px rgba(59,130,246,0.45)',
              }}
            >
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

/* ─── Main component ─────────────────────────────────────── */

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  onNewChat,
  isLoading,
}: ConversationListProps) {
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);

  const currentUserId = user?.id;

  const filtered = search.trim()
    ? conversations.filter((c) => {
        const q = search.toLowerCase();
        if (c.name?.toLowerCase().includes(q)) return true;
        return c.participants.some(
          (p) => p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q),
        );
      })
    : conversations;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
      }}
    >
      {/* Header bar */}
      <div
        style={{
          padding: '18px 16px 12px',
          flexShrink: 0,
          borderBottom: '1px solid rgba(255,255,255,0.05)',
        }}
      >
        {/* Title row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
          }}
        >
          <span
            style={{
              fontSize: '0.7rem',
              fontWeight: 700,
              color: '#334155',
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
            }}
          >
            Messages
          </span>

          {/* New conversation button */}
          <button
            type="button"
            onClick={onNewChat}
            title="New conversation"
            aria-label="New conversation"
            style={{
              background: 'rgba(59,130,246,0.12)',
              border: '1px solid rgba(59,130,246,0.25)',
              borderRadius: 7,
              cursor: 'pointer',
              color: '#60a5fa',
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '5px 9px',
              fontSize: '0.72rem',
              fontWeight: 600,
              transition: 'background 0.15s',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(59,130,246,0.20)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(59,130,246,0.12)'; }}
          >
            <Plus size={13} strokeWidth={2} />
            New
          </button>
        </div>

        {/* Search input */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: searchFocused ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.04)',
            border: searchFocused
              ? '1px solid rgba(59,130,246,0.30)'
              : '1px solid rgba(255,255,255,0.06)',
            borderRadius: 9,
            padding: '7px 11px',
            transition: 'border-color 0.15s, background 0.15s',
          }}
        >
          <Search
            size={13}
            strokeWidth={2}
            style={{ color: searchFocused ? '#60a5fa' : '#475569', flexShrink: 0, transition: 'color 0.15s' }}
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            placeholder="Search conversations"
            aria-label="Search conversations"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: '#f1f5f9',
              fontSize: '0.8rem',
              fontFamily: 'inherit',
            }}
          />
        </div>
      </div>

      {/* Conversation list */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px 8px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          scrollbarWidth: 'thin',
          scrollbarColor: 'rgba(255,255,255,0.06) transparent',
        }}
      >
        {isLoading && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
            <div
              style={{
                width: 22,
                height: 22,
                border: '2px solid rgba(255,255,255,0.07)',
                borderTopColor: '#3b82f6',
                borderRadius: '50%',
                animation: 'spin 0.8s linear infinite',
              }}
            />
          </div>
        )}

        {!isLoading && filtered.length === 0 && (
          <div
            style={{
              padding: '36px 16px',
              textAlign: 'center',
              fontSize: '0.8rem',
              color: '#334155',
              lineHeight: 1.7,
            }}
          >
            {search
              ? `No conversations match "${search}".`
              : 'No conversations yet. Hit the + button to start one.'}
          </div>
        )}

        {filtered.map((c) => (
          <ConvRow
            key={c.id}
            conversation={c}
            isSelected={c.id === selectedId}
            currentUserId={currentUserId}
            onSelect={() => onSelect(c.id)}
          />
        ))}
      </div>
    </div>
  );
}
