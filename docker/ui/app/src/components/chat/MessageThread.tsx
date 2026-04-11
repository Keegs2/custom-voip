import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Phone,
  Video,
  MoreVertical,
  Users,
  ChevronDown,
  MessageSquareDashed,
} from 'lucide-react';
import { listMessages } from '../../api/chat';
import type { Conversation, Message } from '../../types/chat';
import { useChat } from '../../contexts/ChatContext';
import { useAuth } from '../../contexts/AuthContext';
import { MessageBubble } from './MessageBubble';
import { MessageInput } from './MessageInput';
import { TypingIndicator } from './TypingIndicator';

interface MessageThreadProps {
  conversation: Conversation;
}

/* ─── Helpers ────────────────────────────────────────────── */

function formatDateSeparator(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor(
    (now.setHours(0, 0, 0, 0) - d.setHours(0, 0, 0, 0)) / 86400000,
  );
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return new Date(iso).toLocaleDateString([], { weekday: 'long' });
  return new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
}

function isSameDay(a: string, b: string): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
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

/* ─── Loading spinner ────────────────────────────────────── */

function Spinner() {
  return (
    <div
      style={{
        width: 22,
        height: 22,
        border: '2px solid rgba(255,255,255,0.08)',
        borderTopColor: '#3b82f6',
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
      }}
    />
  );
}

/* ─── Header action icon button ──────────────────────────── */

function HeaderAction({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      style={{
        width: 34,
        height: 34,
        borderRadius: 9,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
        border: '1px solid transparent',
        color: '#64748b',
        cursor: 'pointer',
        transition: 'background 0.15s, color 0.15s, border-color 0.15s',
        flexShrink: 0,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
        e.currentTarget.style.color = '#94a3b8';
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = '#64748b';
        e.currentTarget.style.borderColor = 'transparent';
      }}
    >
      {children}
    </button>
  );
}

/* ─── Main component ─────────────────────────────────────── */

export function MessageThread({ conversation }: MessageThreadProps) {
  const { user } = useAuth();
  const { sendMessage, markRead, sendTyping, typingUsers } = useChat();

  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Whether the user has scrolled far enough from the bottom to show the jump button
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const prevScrollHeightRef = useRef(0);

  const typingSet = typingUsers.get(conversation.id) ?? new Set<number>();
  const isGroup = conversation.type === 'group';

  const conversationTitle = isGroup
    ? (conversation.name ?? 'Group')
    : conversation.participants.find((p) => p.user_id !== user?.id)?.name ?? 'Conversation';

  const avatarColor = nameColor(conversationTitle);
  const avatarInitial = conversationTitle.charAt(0).toUpperCase();

  /* ─── Initial load ─────────────────────────────────────── */

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setMessages([]);
    setHasMore(true);
    setShowScrollBtn(false);

    void listMessages(conversation.id).then((msgs) => {
      if (cancelled) return;
      // API returns newest-first; reverse so oldest is at top, newest at bottom
      setMessages(msgs.reverse());
      setHasMore(msgs.length >= 50);
      setIsLoading(false);
      void markRead(conversation.id);
    }).catch((err: Error) => {
      if (!cancelled) {
        setError(err.message);
        setIsLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, [conversation.id, markRead]);

  /* ─── Auto-scroll to bottom on new messages ────────────── */

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  /* ─── Restore scroll position after loading older ──────── */

  useEffect(() => {
    if (!isLoadingOlder) {
      const el = scrollContainerRef.current;
      if (!el || prevScrollHeightRef.current === 0) return;
      el.scrollTop = el.scrollHeight - prevScrollHeightRef.current;
      prevScrollHeightRef.current = 0;
    }
  }, [isLoadingOlder]);

  /* ─── WebSocket new message handler ────────────────────── */

  useEffect(() => {
    const handler = (e: Event) => {
      const ev = (e as CustomEvent<{ conversation_id: number; message: Message }>).detail;
      if (ev.conversation_id !== conversation.id) return;
      setMessages((prev) => {
        if (prev.some((m) => m.id === ev.message.id)) return prev;
        return [...prev, ev.message];
      });
      void markRead(conversation.id);
    };
    window.addEventListener('chat:new_message', handler);
    return () => window.removeEventListener('chat:new_message', handler);
  }, [conversation.id, markRead]);

  /* ─── Scroll tracking ───────────────────────────────────── */

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isAtBottomRef.current = distFromBottom < 60;
    // Show the scroll-to-bottom button when more than 200px from bottom
    setShowScrollBtn(distFromBottom > 200);

    // Load older messages when scrolled to the very top
    if (el.scrollTop < 40 && hasMore && !isLoadingOlder && !isLoading) {
      const firstId = messages[0]?.id;
      if (!firstId) return;

      prevScrollHeightRef.current = el.scrollHeight;
      setIsLoadingOlder(true);

      void listMessages(conversation.id, firstId).then((older) => {
        setMessages((prev) => [...older.reverse(), ...prev]);
        setHasMore(older.length >= 50);
        setIsLoadingOlder(false);
      }).catch(() => {
        setIsLoadingOlder(false);
      });
    }
  }, [conversation.id, hasMore, isLoading, isLoadingOlder, messages]);

  const scrollToBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  /* ─── Send ─────────────────────────────────────────────── */

  const handleSend = useCallback(async (content: string) => {
    const msg = await sendMessage(conversation.id, content);
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
    isAtBottomRef.current = true;
  }, [conversation.id, sendMessage]);

  const handleTyping = useCallback(() => {
    sendTyping(conversation.id);
  }, [conversation.id, sendTyping]);

  /* ─── Render ─────────────────────────────────────────────── */

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: '#0f1117',
      }}
    >
      {/* Thread header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '0 20px',
          height: 64,
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          flexShrink: 0,
          background: 'rgba(255,255,255,0.015)',
          backdropFilter: 'blur(8px)',
        }}
      >
        {/* Avatar */}
        <div
          style={{
            position: 'relative',
            width: 38,
            height: 38,
            borderRadius: isGroup ? 11 : '50%',
            background: `${avatarColor}1e`,
            border: `1.5px solid ${avatarColor}38`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '0.9rem',
            fontWeight: 700,
            color: avatarColor,
            flexShrink: 0,
          }}
        >
          {isGroup ? (
            <Users size={17} strokeWidth={2} style={{ color: avatarColor }} />
          ) : (
            avatarInitial
          )}

          {/* Online presence dot — DMs only */}
          {!isGroup && (
            <div
              style={{
                position: 'absolute',
                bottom: -1,
                right: -1,
                width: 11,
                height: 11,
                borderRadius: '50%',
                background: '#22c55e',
                border: '2px solid #0f1117',
              }}
            />
          )}
        </div>

        {/* Title + subtitle */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: '0.95rem',
              fontWeight: 700,
              color: '#f1f5f9',
              letterSpacing: '-0.02em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {conversationTitle}
          </div>
          <div style={{ fontSize: '0.72rem', color: '#22c55e', marginTop: 1, fontWeight: 500 }}>
            {isGroup
              ? `${conversation.participants.length} members`
              : 'Active now'}
          </div>
        </div>

        {/* Action buttons — decorative (UCaaS context: phone, video, more) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <HeaderAction title="Voice call">
            <Phone size={16} strokeWidth={2} />
          </HeaderAction>
          <HeaderAction title="Video call">
            <Video size={16} strokeWidth={2} />
          </HeaderAction>
          <HeaderAction title="More options">
            <MoreVertical size={16} strokeWidth={2} />
          </HeaderAction>
        </div>
      </div>

      {/* Message list — scrollable */}
      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '8px 20px 4px',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            scrollbarWidth: 'thin',
            scrollbarColor: 'rgba(255,255,255,0.08) transparent',
          }}
        >
          {/* Load-older spinner */}
          {isLoadingOlder && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0 12px' }}>
              <Spinner />
            </div>
          )}

          {/* Beginning of conversation indicator */}
          {!hasMore && messages.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 8,
                padding: '24px 0 20px',
              }}
            >
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 12,
                  background: 'linear-gradient(135deg, rgba(59,130,246,0.14) 0%, rgba(129,140,248,0.08) 100%)',
                  border: '1px solid rgba(59,130,246,0.18)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#3b82f6',
                }}
              >
                <MessageSquareDashed size={20} strokeWidth={1.5} />
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 600, color: '#475569', letterSpacing: '-0.01em' }}>
                  Beginning of {isGroup ? 'this channel' : 'your conversation'}
                </div>
                <div style={{ fontSize: '0.72rem', color: '#334155', marginTop: 3 }}>
                  with {conversationTitle}
                </div>
              </div>
            </div>
          )}

          {/* Initial loading */}
          {isLoading && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1, paddingTop: 60 }}>
              <Spinner />
            </div>
          )}

          {/* Error */}
          {error && !isLoading && (
            <div
              style={{
                padding: '12px 16px',
                borderRadius: 10,
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.20)',
                color: '#f87171',
                fontSize: '0.875rem',
                margin: '16px 0',
              }}
            >
              {error}
            </div>
          )}

          {/* Empty state — no messages yet */}
          {!isLoading && !error && messages.length === 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                flex: 1,
                gap: 12,
                paddingTop: 60,
              }}
            >
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 16,
                  background: 'linear-gradient(135deg, rgba(59,130,246,0.14) 0%, rgba(129,140,248,0.08) 100%)',
                  border: '1px solid rgba(59,130,246,0.18)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#3b82f6',
                }}
              >
                <MessageSquareDashed size={26} strokeWidth={1.5} />
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '0.9rem', fontWeight: 600, color: '#475569', marginBottom: 4 }}>
                  No messages yet
                </div>
                <div style={{ fontSize: '0.8rem', color: '#334155' }}>
                  Be the first to say hello.
                </div>
              </div>
            </div>
          )}

          {/* Messages with date separators */}
          {!isLoading && messages.map((msg, idx) => {
            const prev = messages[idx - 1];
            const showDateSeparator = !prev || !isSameDay(prev.created_at, msg.created_at);
            const isOwn = user?.id !== undefined && msg.sender_id === user.id;
            const isGrouped =
              !showDateSeparator &&
              !!prev &&
              prev.sender_id === msg.sender_id &&
              !prev.deleted_at &&
              !msg.deleted_at;

            // Check if this is the last message from this sender before a different sender or date break
            const next = messages[idx + 1];
            const isLastInGroup =
              !next ||
              next.sender_id !== msg.sender_id ||
              !!next.deleted_at ||
              !!msg.deleted_at ||
              (next && !isSameDay(msg.created_at, next.created_at));

            return (
              <div key={msg.id}>
                {showDateSeparator && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      margin: '20px 0 10px',
                    }}
                  >
                    <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.05)' }} />
                    <span
                      style={{
                        fontSize: '0.65rem',
                        fontWeight: 600,
                        color: '#475569',
                        textTransform: 'uppercase',
                        letterSpacing: '0.08em',
                        whiteSpace: 'nowrap',
                        padding: '2px 10px',
                        borderRadius: 20,
                        background: 'rgba(255,255,255,0.03)',
                        border: '1px solid rgba(255,255,255,0.06)',
                      }}
                    >
                      {formatDateSeparator(msg.created_at)}
                    </span>
                    <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.05)' }} />
                  </div>
                )}
                <MessageBubble
                  message={msg}
                  isOwn={isOwn}
                  isGrouped={isGrouped}
                  isGroup={isGroup}
                  isLastInGroup={isLastInGroup}
                />
              </div>
            );
          })}

          {/* Bottom anchor */}
          <div style={{ height: 8, flexShrink: 0 }} />
        </div>

        {/* Scroll-to-bottom floating button */}
        {showScrollBtn && (
          <button
            type="button"
            onClick={scrollToBottom}
            aria-label="Scroll to latest messages"
            style={{
              position: 'absolute',
              bottom: 12,
              right: 24,
              width: 36,
              height: 36,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, #1e3a6e 0%, #1d4ed8 100%)',
              border: '1px solid rgba(59,130,246,0.40)',
              color: '#93c5fd',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              boxShadow: '0 4px 16px rgba(0,0,0,0.40)',
              transition: 'opacity 0.15s, transform 0.12s',
              zIndex: 10,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; }}
          >
            <ChevronDown size={18} strokeWidth={2.5} />
          </button>
        )}
      </div>

      {/* Typing indicator */}
      <div style={{ flexShrink: 0 }}>
        <TypingIndicator
          typingUserIds={typingSet}
          participants={conversation.participants}
        />
      </div>

      {/* Message input */}
      <div style={{ flexShrink: 0 }}>
        <MessageInput
          onSend={handleSend}
          onTyping={handleTyping}
          placeholder={`Message ${conversationTitle}`}
        />
      </div>
    </div>
  );
}
