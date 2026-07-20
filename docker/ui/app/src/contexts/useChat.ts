/**
 * Chat context object + consumer hook, split out of the provider file
 * (`ChatContext.tsx`) so component files export ONLY components
 * (react-refresh/only-export-components — FRONTEND_GLASS_REFACTOR.md §5.3).
 * Import `useChat` from here; the provider stays in `./ChatContext`.
 */
import { createContext, useContext } from 'react';
import type { Conversation, Message } from '../types/chat';

export interface ChatContextValue {
  /** All conversations for this user, sorted newest-first */
  conversations: Conversation[];
  /** Total unread count across all conversations — for sidebar badge */
  totalUnread: number;
  /** Map of conversationId -> Set of userIds currently typing */
  typingUsers: Map<number, Set<number>>;
  /** Whether the initial conversation list is loading */
  isLoading: boolean;

  sendMessage: (conversationId: number, content: string) => Promise<Message>;
  markRead: (conversationId: number) => Promise<void>;
  sendTyping: (conversationId: number) => void;
  refreshConversations: () => void;
}

export const ChatContext = createContext<ChatContextValue | null>(null);

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return ctx;
}
