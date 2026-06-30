/**
 * ChatPage — thin composition shell for the UCaaS team chat (liquid glass).
 *
 * This is a full-screen route OUTSIDE AppLayout: it renders its OWN Sidebar +
 * SoftphoneWidget, so it also mounts its own <GlassBackground> (AppLayout's
 * app-wide backdrop isn't present on this route). All data/selection logic lives
 * in ./chat/hooks, styles in ./chat/styles, the empty states in
 * ./chat/components — this file is composition + nothing else.
 *
 * React #310: the single controller hook is called unconditionally at the top.
 */

import { Sidebar } from '../components/layout/Sidebar';
import { SoftphoneWidget } from '../components/softphone/SoftphoneWidget';
import { ConversationList } from '../components/chat/ConversationList';
import { MessageThread } from '../components/chat/MessageThread';
import { NewConversationModal } from '../components/chat/NewConversationModal';
import { GlassBackground } from '../components/glass/GlassBackground';
import { GlassSheen } from '../components/glass/GlassCard';
import { useChatController } from './chat/hooks';
import { ChatPlaceholder } from './chat/components/ChatPlaceholder';
import { frame, listPane, root, shell, threadPane } from './chat/styles';

/* Keyframes the inner chat components rely on (`spin`) + the placeholder pulse.
   GlassBackground injects the `glass-*` keyframes; `spin`/`chatPulse` are local. */
const LOCAL_KEYFRAMES = `
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes chatPulse {
    0%, 100% { opacity: 0.75; transform: scale(1); }
    50%       { opacity: 1;    transform: scale(1.06); }
  }
`;

export function ChatPage() {
  // ── ALL hooks first (React #310) ───────────────────────────────────────────
  const {
    conversations,
    isLoading,
    selectedId,
    selectedConversation,
    showModal,
    setShowModal,
    handleSelect,
    handleCreated,
  } = useChatController();

  const noConversations = !isLoading && conversations.length === 0;

  return (
    <div style={root}>
      <style>{LOCAL_KEYFRAMES}</style>

      {/* Ambient liquid-glass backdrop (this route is outside AppLayout). */}
      <GlassBackground />

      {/* Fixed product sidebar — keeps its own accent system. */}
      <Sidebar />

      {/* Padded content column → frosted chat frame. */}
      <div style={shell}>
        <div style={frame()}>
          <GlassSheen />

          {/* Left pane — conversation list. */}
          <div style={listPane}>
            <ConversationList
              conversations={conversations}
              selectedId={selectedId}
              onSelect={handleSelect}
              onNewChat={() => setShowModal(true)}
              isLoading={isLoading}
            />
          </div>

          {/* Right pane — active thread or a glass placeholder. */}
          <div style={threadPane}>
            {selectedConversation ? (
              <MessageThread conversation={selectedConversation} />
            ) : (
              <ChatPlaceholder
                variant={noConversations ? 'none' : 'empty'}
                onNewChat={() => setShowModal(true)}
              />
            )}
          </div>
        </div>
      </div>

      {/* Floating softphone overlay. */}
      <SoftphoneWidget />

      {/* New conversation modal. */}
      {showModal && (
        <NewConversationModal
          onClose={() => setShowModal(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}
