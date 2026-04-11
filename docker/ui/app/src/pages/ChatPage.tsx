import { useCallback, useEffect, useState } from 'react';
import { MessageSquareText, MessageSquarePlus, Plus } from 'lucide-react';
import { useChat } from '../contexts/ChatContext';
import { ConversationList } from '../components/chat/ConversationList';
import { MessageThread } from '../components/chat/MessageThread';
import { NewConversationModal } from '../components/chat/NewConversationModal';
import { Sidebar } from '../components/layout/Sidebar';
import { SoftphoneWidget } from '../components/softphone/SoftphoneWidget';
import type { Conversation } from '../types/chat';

/* ─── Keyframe injection (once per mount) ─────────────────── */

const GLOBAL_STYLES = `
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes chatPulse {
    0%, 100% { opacity: 0.7; transform: scale(1); }
    50%       { opacity: 1;   transform: scale(1.06); }
  }
`;

/* ─── Empty state — no conversation selected ──────────────── */

function EmptyState({ onNewChat }: { onNewChat: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: 20,
        padding: 48,
        background: '#0f1117',
      }}
    >
      {/* Pulsing icon */}
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
          animation: 'chatPulse 3s ease-in-out infinite',
          boxShadow: '0 0 40px rgba(59,130,246,0.12)',
        }}
      >
        <MessageSquareText size={36} strokeWidth={1.5} />
      </div>

      <div style={{ textAlign: 'center', maxWidth: 300 }}>
        <div
          style={{
            fontSize: '1.1rem',
            fontWeight: 700,
            color: '#94a3b8',
            marginBottom: 8,
            letterSpacing: '-0.02em',
          }}
        >
          No conversation selected
        </div>
        <div style={{ fontSize: '0.85rem', color: '#475569', lineHeight: 1.65 }}>
          Pick a conversation from the list on the left, or start a fresh one.
        </div>
      </div>

      <button
        type="button"
        onClick={onNewChat}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 22px',
          borderRadius: 10,
          background: 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)',
          border: 'none',
          color: '#fff',
          fontSize: '0.875rem',
          fontWeight: 600,
          cursor: 'pointer',
          boxShadow: '0 2px 14px rgba(59,130,246,0.35)',
          transition: 'opacity 0.15s, transform 0.12s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.opacity = '0.88';
          e.currentTarget.style.transform = 'translateY(-1px)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.opacity = '1';
          e.currentTarget.style.transform = 'translateY(0)';
        }}
      >
        <Plus size={15} strokeWidth={2.5} />
        New Conversation
      </button>
    </div>
  );
}

/* ─── Empty state — no conversations at all ───────────────── */

function NoConversationsState({ onNewChat }: { onNewChat: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: 20,
        padding: 48,
        background: '#0f1117',
      }}
    >
      <div
        style={{
          width: 80,
          height: 80,
          borderRadius: 22,
          background: 'linear-gradient(135deg, rgba(59,130,246,0.14) 0%, rgba(129,140,248,0.08) 100%)',
          border: '1px solid rgba(59,130,246,0.18)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#3b82f6',
          boxShadow: '0 0 40px rgba(59,130,246,0.10)',
        }}
      >
        <MessageSquarePlus size={36} strokeWidth={1.5} />
      </div>

      <div style={{ textAlign: 'center', maxWidth: 280 }}>
        <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#94a3b8', marginBottom: 8, letterSpacing: '-0.02em' }}>
          No conversations yet
        </div>
        <div style={{ fontSize: '0.85rem', color: '#475569', lineHeight: 1.65 }}>
          Start a direct message with a colleague or create a group chat.
        </div>
      </div>

      <button
        type="button"
        onClick={onNewChat}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 22px',
          borderRadius: 10,
          background: 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)',
          border: 'none',
          color: '#fff',
          fontSize: '0.875rem',
          fontWeight: 600,
          cursor: 'pointer',
          boxShadow: '0 2px 14px rgba(59,130,246,0.35)',
          transition: 'opacity 0.15s, transform 0.12s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.opacity = '0.88';
          e.currentTarget.style.transform = 'translateY(-1px)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.opacity = '1';
          e.currentTarget.style.transform = 'translateY(0)';
        }}
      >
        <Plus size={15} strokeWidth={2.5} />
        Start a Conversation
      </button>
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────── */

export function ChatPage() {
  const { conversations, isLoading, refreshConversations } = useChat();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showModal, setShowModal] = useState(false);

  const selectedConversation: Conversation | null =
    selectedId !== null
      ? (conversations.find((c) => c.id === selectedId) ?? null)
      : null;

  // Auto-select first conversation on initial load
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
    <div
      style={{
        display: 'flex',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
        background: '#0f1117',
      }}
    >
      {/* Global keyframes */}
      <style>{GLOBAL_STYLES}</style>

      {/* Fixed sidebar — same as AppLayout */}
      <Sidebar />

      {/* Chat shell — fills the space to the right of the sidebar */}
      <div
        style={{
          marginLeft: 240,
          flex: 1,
          display: 'flex',
          overflow: 'hidden',
          height: '100vh',
        }}
      >
        {/* Left pane — conversation list (320px) */}
        <div
          style={{
            width: 320,
            flexShrink: 0,
            borderRight: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            background: '#131520',
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
          {selectedConversation ? (
            <MessageThread conversation={selectedConversation} />
          ) : !isLoading && conversations.length === 0 ? (
            <NoConversationsState onNewChat={() => setShowModal(true)} />
          ) : (
            <EmptyState onNewChat={() => setShowModal(true)} />
          )}
        </div>
      </div>

      {/* Softphone overlay */}
      <SoftphoneWidget />

      {/* New conversation modal */}
      {showModal && (
        <NewConversationModal
          onClose={() => setShowModal(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}
