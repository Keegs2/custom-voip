import { useState } from 'react';
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

/** Derive a stable hue for the avatar background */
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

  // For direct chats, display the other participant's name
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
        padding: '10px 12px',
        borderRadius: 10,
        background: isSelected
          ? 'linear-gradient(135deg, rgba(59,130,246,0.14) 0%, rgba(129,140,248,0.08) 100%)'
          : 'transparent',
        border: isSelected
          ? '1px solid rgba(59,130,246,0.22)'
          : '1px solid transparent',
        boxShadow: isSelected ? '0 0 0 1px rgba(59,130,246,0.15)' : 'none',
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
        transition: 'background 0.12s, border-color 0.12s',
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
      {/* Avatar */}
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <div
          style={{
            width: 38,
            height: 38,
            borderRadius: isGroup ? 10 : '50%',
            background: `${avatarColor}22`,
            border: `1px solid ${avatarColor}40`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '0.85rem',
            fontWeight: 700,
            color: avatarColor,
            userSelect: 'none',
          }}
        >
          {initial}
        </div>
        {/* Unread dot on avatar */}
        {unread > 0 && (
          <div
            style={{
              position: 'absolute',
              top: -2,
              right: -2,
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: '#3b82f6',
              border: '2px solid #0c0e16',
            }}
          />
        )}
      </div>

      {/* Text content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
          <span
            style={{
              fontSize: '0.85rem',
              fontWeight: unread > 0 ? 700 : 500,
              color: unread > 0 ? '#f1f5f9' : '#94a3b8',
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
              fontSize: '0.65rem',
              color: '#334155',
              flexShrink: 0,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {formatRelativeTime(timestamp)}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, marginTop: 2 }}>
          <span
            style={{
              fontSize: '0.75rem',
              color: unread > 0 ? '#64748b' : '#334155',
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
                minWidth: 18,
                height: 18,
                borderRadius: 9,
                background: '#3b82f6',
                color: '#fff',
                fontSize: '0.6rem',
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 4px',
                flexShrink: 0,
                letterSpacing: '0.02em',
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

const IconSearch = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} style={{ width: 14, height: 14 }}>
    <path d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconPlus = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
    <path d="M12 4.5v15m7.5-7.5h-15" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function ConversationList({
  conversations,
  selectedId,
  onSelect,
  onNewChat,
  isLoading,
}: ConversationListProps) {
  const { user } = useAuth();
  const [search, setSearch] = useState('');

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
      {/* Header */}
      <div style={{ padding: '16px 12px 10px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <span
            style={{
              fontSize: '0.7rem',
              fontWeight: 700,
              color: '#475569',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
            }}
          >
            Messages
          </span>
          <button
            type="button"
            onClick={onNewChat}
            title="New conversation"
            aria-label="New conversation"
            style={{
              width: 26,
              height: 26,
              borderRadius: 7,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(59,130,246,0.12)',
              border: '1px solid rgba(59,130,246,0.25)',
              color: '#60a5fa',
              cursor: 'pointer',
              transition: 'background 0.15s',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(59,130,246,0.22)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(59,130,246,0.12)'; }}
          >
            <IconPlus />
          </button>
        </div>

        {/* Search */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.07)',
            borderRadius: 8,
            padding: '6px 10px',
          }}
        >
          <span style={{ color: '#334155', flexShrink: 0 }}>
            <IconSearch />
          </span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
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

      {/* List */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '0 6px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          scrollbarWidth: 'thin',
          scrollbarColor: 'rgba(255,255,255,0.06) transparent',
        }}
      >
        {isLoading && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
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
              padding: '32px 12px',
              textAlign: 'center',
              fontSize: '0.8rem',
              color: '#334155',
              lineHeight: 1.6,
            }}
          >
            {search ? 'No conversations match your search.' : 'No conversations yet.\nStart one with the + button.'}
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
