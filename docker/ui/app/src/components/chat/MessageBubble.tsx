import type { Message } from '../../types/chat';

interface MessageBubbleProps {
  message: Message;
  isOwn: boolean;
  /** When true, hide avatar + sender name (consecutive messages from same sender) */
  isGrouped: boolean;
  /** Whether this is a group conversation — only show sender name in groups */
  isGroup: boolean;
}

/* ─── Helpers ────────────────────────────────────────────── */

function formatTimestamp(iso: string, full = false): string {
  const d = new Date(iso);
  if (full) {
    return d.toLocaleString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getInitial(name: string): string {
  return name.charAt(0).toUpperCase();
}

/** Derive a stable hue from a string so each participant gets a consistent color */
function nameColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 60%, 62%)`;
}

/* ─── Component ──────────────────────────────────────────── */

export function MessageBubble({ message, isOwn, isGrouped, isGroup }: MessageBubbleProps) {
  const isDeleted = Boolean(message.deleted_at);
  const isEdited = Boolean(message.edited_at) && !isDeleted;
  const avatarColor = nameColor(message.sender_name);

  const bubbleStyles: React.CSSProperties = {
    maxWidth: '70%',
    padding: '9px 13px',
    borderRadius: isOwn
      ? isGrouped ? '14px 4px 4px 14px' : '14px 4px 14px 14px'
      : isGrouped ? '4px 14px 14px 4px' : '4px 14px 14px 14px',
    wordBreak: 'break-word',
    whiteSpace: 'pre-wrap',
    lineHeight: 1.55,
    fontSize: '0.875rem',
    position: 'relative',
    ...(isOwn
      ? {
          background: 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)',
          color: '#fff',
          boxShadow: '0 2px 12px rgba(59,130,246,0.25)',
        }
      : {
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.08)',
          color: '#f1f5f9',
        }),
    ...(isDeleted
      ? {
          background: 'transparent',
          border: '1px dashed rgba(255,255,255,0.10)',
          color: '#334155',
          fontStyle: 'italic',
          boxShadow: 'none',
        }
      : {}),
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: isOwn ? 'row-reverse' : 'row',
        alignItems: 'flex-end',
        gap: 8,
        marginTop: isGrouped ? 2 : 12,
        paddingLeft: isOwn ? 0 : 4,
        paddingRight: isOwn ? 4 : 0,
      }}
    >
      {/* Avatar — only shown on first message in a group */}
      <div style={{ width: 32, flexShrink: 0, alignSelf: 'flex-end' }}>
        {!isGrouped && !isOwn && (
          <div
            aria-label={message.sender_name}
            title={message.sender_name}
            style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: `${avatarColor}22`,
              border: `1px solid ${avatarColor}40`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '0.75rem',
              fontWeight: 700,
              color: avatarColor,
              flexShrink: 0,
              userSelect: 'none',
            }}
          >
            {getInitial(message.sender_name)}
          </div>
        )}
      </div>

      {/* Message content column */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: isOwn ? 'flex-end' : 'flex-start',
          flex: 1,
          minWidth: 0,
        }}
      >
        {/* Sender name — only in group conversations, not own messages, not grouped */}
        {isGroup && !isOwn && !isGrouped && (
          <span
            style={{
              fontSize: '0.7rem',
              fontWeight: 600,
              color: avatarColor,
              marginBottom: 3,
              paddingLeft: 2,
              letterSpacing: '-0.01em',
            }}
          >
            {message.sender_name}
          </span>
        )}

        {/* Bubble */}
        <div
          title={formatTimestamp(message.created_at, true)}
          style={bubbleStyles}
        >
          {isDeleted ? (
            'This message was deleted'
          ) : (
            message.content ?? <span style={{ opacity: 0.5 }}>[no content]</span>
          )}
        </div>

        {/* Metadata row: time + edited */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            marginTop: 2,
            paddingLeft: 2,
            paddingRight: 2,
          }}
        >
          <span
            style={{
              fontSize: '0.65rem',
              color: '#334155',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {formatTimestamp(message.created_at)}
          </span>
          {isEdited && (
            <span style={{ fontSize: '0.6rem', color: '#334155', fontStyle: 'italic' }}>
              edited
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
