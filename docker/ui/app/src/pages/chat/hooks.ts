/**
 * Chat page controller hook — owns the page's top-level state, the derived
 * "effective" selection (first conversation auto-selected until the user picks
 * one), and the select/create callbacks. The thin page composes the result; all
 * server state stays in ChatContext (the single source of truth for
 * conversations + the WS feed).
 *
 * Auto-select is DERIVED, not an effect: `effectiveSelectedId` falls back to the
 * newest conversation while `selectedId` is null. This avoids a setState-in-
 * effect cascade and keeps the same UX as an explicit auto-select.
 *
 * React #310: every hook is called unconditionally at the top — no early
 * returns inside this hook.
 */

import { useCallback, useState } from 'react';
import { useChat } from '../../contexts/ChatContext';
import type { Conversation } from '../../types/chat';

export interface ChatController {
  conversations: Conversation[];
  isLoading: boolean;
  selectedId: number | null;
  selectedConversation: Conversation | null;
  showModal: boolean;
  setShowModal: (open: boolean) => void;
  handleSelect: (id: number) => void;
  handleCreated: (conv: Conversation) => void;
}

export function useChatController(): ChatController {
  const { conversations, isLoading, refreshConversations } = useChat();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showModal, setShowModal] = useState(false);

  // Derived selection: fall back to the newest conversation until the user
  // explicitly picks one (conversations are kept newest-first by ChatContext).
  const effectiveSelectedId: number | null =
    selectedId ?? conversations[0]?.id ?? null;

  const selectedConversation: Conversation | null =
    effectiveSelectedId !== null
      ? (conversations.find((c) => c.id === effectiveSelectedId) ?? null)
      : null;

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

  return {
    conversations,
    isLoading,
    selectedId: effectiveSelectedId,
    selectedConversation,
    showModal,
    setShowModal,
    handleSelect,
    handleCreated,
  };
}
