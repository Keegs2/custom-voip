import { useCallback, useEffect, useState } from 'react';
import { useChat } from '../contexts/ChatContext';
import { ConversationList } from '../components/chat/ConversationList';
import { MessageThread } from '../components/chat/MessageThread';
import { NewConversationModal } from '../components/chat/NewConversationModal';
import type { Conversation } from '../types/chat';

/* ─── Empty state ────────────────────────────────────────── */

function EmptyState({ onNewChat }: { onNewChat: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: 16,
        color: '#334155',
        padding: 40,
      }}
    >
      {/* Chat bubble icon */}
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: 18,
          background: 'linear-gradient(135deg, rgba(59,130,246,0.14) 0%, rgba(129,140,248,0.10) 100%)',
          border: '1px solid rgba(59,130,246,0.18)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#3b82f6',
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ width: 30, height: 30 }}>
          <path d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '1rem', fontWeight: 700, color: '#475569', marginBottom: 6, letterSpacing: '-0.02em' }}>
          No conversation selected
        </div>
        <div style={{ fontSize: '0.85rem', color: '#334155', lineHeight: 1.6 }}>
          Choose a conversation from the list, or start a new one.
        </div>
      </div>

      <button
        type="button"
        onClick={onNewChat}
        style={{
          padding: '9px 20px',
          borderRadius: 10,
          background: 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)',
          border: 'none',
          color: '#fff',
          fontSize: '0.875rem',
          fontWeight: 600,
          cursor: 'pointer',
          boxShadow: '0 2px 12px rgba(59,130,246,0.30)',
          transition: 'opacity 0.15s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.88'; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
      >
        New Conversation
      </button>
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────── */

export function ChatPage() {
  const { conversations, isLoading, refreshConversations } = useChat();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showModal, setShowModal] = useState(false);

  // Derive selected conversation from the list (kept in sync with context)
  const selectedConversation: Conversation | null =
    selectedId !== null
      ? (conversations.find((c) => c.id === selectedId) ?? null)
      : null;

  // Auto-select first conversation on initial load if none is selected
  useEffect(() => {
    if (selectedId === null && conversations.length > 0) {
      setSelectedId(conversations[0].id);
    }
  }, [conversations, selectedId]);

  const handleSelect = useCallback((id: number) => {
    setSelectedId(id);
  }, []);

  const handleCreated = useCallback(
    (conv: Conversation) => {
      refreshConversations();
      setSelectedId(conv.id);
      setShowModal(false);
    },
    [refreshConversations],
  );

  return (
    <>
      {/* Keyframe for spinners — injected once */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Full-height two-pane layout
          AppLayout adds py-8 (32px top) + pb-20 (80px bottom) + 1px border rows.
          We subtract those to get a chat panel that fills the viewport without
          causing the outer page to scroll. */}
      <div
        style={{
          display: 'flex',
          height: 'calc(100vh - 144px)',
          minHeight: 400,
          background: '#0f1117',
          borderRadius: 12,
          border: '1px solid rgba(255,255,255,0.06)',
          overflow: 'hidden',
        }}
      >
        {/* Left pane — conversation list */}
        <div
          style={{
            width: 280,
            flexShrink: 0,
            borderRight: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            background: 'rgba(255,255,255,0.015)',
          }}
        >
          <ConversationList
            conversations={conversations}
            selectedId={selectedId}
            onSelect={handleSelect}
            onNewChat={() => setShowModal(true)}
            isLoading={isLoading}
          />
        </div>

        {/* Right pane — message thread or empty state */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0 }}>
          {selectedConversation ? (
            <MessageThread conversation={selectedConversation} />
          ) : (
            <EmptyState onNewChat={() => setShowModal(true)} />
          )}
        </div>
      </div>

      {/* New conversation modal */}
      {showModal && (
        <NewConversationModal
          onClose={() => setShowModal(false)}
          onCreated={handleCreated}
        />
      )}
    </>
  );
}
