import { useCallback, useEffect, useRef, useState } from 'react';
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

/* ─── Date separator label ───────────────────────────────── */

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

/* ─── Main component ─────────────────────────────────────── */

export function MessageThread({ conversation }: MessageThreadProps) {
  const { user } = useAuth();
  const { sendMessage, markRead, sendTyping, typingUsers } = useChat();

  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Track whether the user has scrolled up (suppress auto-scroll-to-bottom)
  const isAtBottomRef = useRef(true);
  // Previous scroll height before loading older messages (to maintain position)
  const prevScrollHeightRef = useRef(0);

  const typingSet = typingUsers.get(conversation.id) ?? new Set<number>();
  const isGroup = conversation.type === 'group';

  /* ─── Initial load ───────────────────────────────────────── */

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setMessages([]);
    setHasMore(true);

    void listMessages(conversation.id).then((msgs) => {
      if (cancelled) return;
      setMessages(msgs);
      setHasMore(msgs.length >= 50);
      setIsLoading(false);
      // Mark read after loading
      void markRead(conversation.id);
    }).catch((err: Error) => {
      if (!cancelled) {
        setError(err.message);
        setIsLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, [conversation.id, markRead]);

  /* ─── Scroll to bottom on new messages (if near bottom) ─── */

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  /* ─── Restore scroll position after loading older messages ── */

  useEffect(() => {
    if (!isLoadingOlder) {
      const el = scrollContainerRef.current;
      if (!el || prevScrollHeightRef.current === 0) return;
      // Maintain visual position by adding the height difference
      el.scrollTop = el.scrollHeight - prevScrollHeightRef.current;
      prevScrollHeightRef.current = 0;
    }
  }, [isLoadingOlder]);

  /* ─── Handle new messages from WebSocket (via context) ────── */

  // The context updates conversations but not individual message threads.
  // We listen for the raw WebSocket event by subscribing to the window event
  // bus that ChatContext emits. Here we use a simpler approach: the context
  // already handles updating the conversation list; we poll for new messages
  // when we know a new_message event arrived by watching totalUnread.
  // Actually, best approach: expose an event callback from context.
  // To keep this self-contained, we use a custom window event.
  useEffect(() => {
    const handler = (e: Event) => {
      const ev = (e as CustomEvent<{ conversation_id: number; message: Message }>).detail;
      if (ev.conversation_id !== conversation.id) return;
      setMessages((prev) => {
        // Avoid duplicates
        if (prev.some((m) => m.id === ev.message.id)) return prev;
        return [...prev, ev.message];
      });
      // Mark read since this conversation is active
      void markRead(conversation.id);
    };
    window.addEventListener('chat:new_message', handler);
    return () => window.removeEventListener('chat:new_message', handler);
  }, [conversation.id, markRead]);

  /* ─── Scroll tracking ────────────────────────────────────── */

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isAtBottomRef.current = distFromBottom < 60;

    // Load older messages when scrolled to the very top
    if (el.scrollTop < 40 && hasMore && !isLoadingOlder && !isLoading) {
      const firstId = messages[0]?.id;
      if (!firstId) return;

      prevScrollHeightRef.current = el.scrollHeight;
      setIsLoadingOlder(true);

      void listMessages(conversation.id, firstId).then((older) => {
        setMessages((prev) => [...older, ...prev]);
        setHasMore(older.length >= 50);
        setIsLoadingOlder(false);
      }).catch(() => {
        setIsLoadingOlder(false);
      });
    }
  }, [conversation.id, hasMore, isLoading, isLoadingOlder, messages]);

  /* ─── Send ───────────────────────────────────────────────── */

  const handleSend = useCallback(async (content: string) => {
    const msg = await sendMessage(conversation.id, content);
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
    // Scroll to bottom on own send
    isAtBottomRef.current = true;
  }, [conversation.id, sendMessage]);

  const handleTyping = useCallback(() => {
    sendTyping(conversation.id);
  }, [conversation.id, sendTyping]);

  /* ─── Render ─────────────────────────────────────────────── */

  const conversationTitle = conversation.type === 'group'
    ? (conversation.name ?? 'Group')
    : conversation.participants.find((p) => p.user_id !== user?.id)?.name ?? 'Conversation';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
      }}
    >
      {/* Thread header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 20px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          flexShrink: 0,
          background: 'rgba(255,255,255,0.01)',
        }}
      >
        {/* Avatar */}
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: isGroup ? 10 : '50%',
            background: 'linear-gradient(135deg, rgba(59,130,246,0.25) 0%, rgba(129,140,248,0.15) 100%)',
            border: '1px solid rgba(59,130,246,0.25)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '0.85rem',
            fontWeight: 700,
            color: '#818cf8',
            flexShrink: 0,
          }}
        >
          {conversationTitle.charAt(0).toUpperCase()}
        </div>
        <div>
          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#f1f5f9', letterSpacing: '-0.02em' }}>
            {conversationTitle}
          </div>
          {isGroup && (
            <div style={{ fontSize: '0.7rem', color: '#64748b', marginTop: 1 }}>
              {conversation.participants.length} members
            </div>
          )}
        </div>
      </div>

      {/* Message list */}
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px 16px',
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

        {/* No more older messages */}
        {!hasMore && messages.length > 0 && (
          <div
            style={{
              textAlign: 'center',
              fontSize: '0.7rem',
              color: '#334155',
              padding: '8px 0 16px',
            }}
          >
            Beginning of conversation
          </div>
        )}

        {/* Initial loading */}
        {isLoading && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1 }}>
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

        {/* Empty state */}
        {!isLoading && !error && messages.length === 0 && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              flex: 1,
              gap: 8,
              color: '#334155',
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ width: 32, height: 32, opacity: 0.4 }}>
              <path d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span style={{ fontSize: '0.85rem' }}>No messages yet. Say hello.</span>
          </div>
        )}

        {/* Messages with date separators */}
        {!isLoading && messages.map((msg, idx) => {
          const prev = messages[idx - 1];
          const showDateSeparator = !prev || !isSameDay(prev.created_at, msg.created_at);
          const isOwn = user?.id !== undefined && msg.sender_id === user.id;
          // Group if same sender as previous message, same day, no separator
          const isGrouped =
            !showDateSeparator &&
            !!prev &&
            prev.sender_id === msg.sender_id &&
            !prev.deleted_at &&
            !msg.deleted_at;

          return (
            <div key={msg.id}>
              {showDateSeparator && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    margin: '20px 0 8px',
                  }}
                >
                  <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.06)' }} />
                  <span
                    style={{
                      fontSize: '0.65rem',
                      fontWeight: 600,
                      color: '#475569',
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {formatDateSeparator(msg.created_at)}
                  </span>
                  <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.06)' }} />
                </div>
              )}
              <MessageBubble
                message={msg}
                isOwn={isOwn}
                isGrouped={isGrouped}
                isGroup={isGroup}
              />
            </div>
          );
        })}

        {/* Bottom anchor — auto-scroll target */}
        <div style={{ height: 4, flexShrink: 0 }} />
      </div>

      {/* Typing indicator sits between scroll area and input */}
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
