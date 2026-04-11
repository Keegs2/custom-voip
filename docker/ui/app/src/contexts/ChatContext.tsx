import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  listConversations,
  sendMessage as apiSendMessage,
  markConversationRead as apiMarkRead,
  sendTypingIndicator,
  getUnreadCount,
} from '../api/chat';
import type { ChatEvent, Conversation, Message } from '../types/chat';
import { useAuth } from './AuthContext';

/* ─── Context shape ──────────────────────────────────────── */

interface ChatContextValue {
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

const ChatContext = createContext<ChatContextValue | null>(null);

/* ─── Helpers ────────────────────────────────────────────── */

function byUpdatedAt(a: Conversation, b: Conversation): number {
  return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
}

/* ─── Provider ───────────────────────────────────────────── */

export function ChatProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, user } = useAuth();

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [totalUnread, setTotalUnread] = useState(0);
  const [typingUsers, setTypingUsers] = useState<Map<number, Set<number>>>(new Map());
  const [isLoading, setIsLoading] = useState(false);

  // WebSocket ref — not state so mutations don't cause re-renders
  const wsRef = useRef<WebSocket | null>(null);
  // Reconnect timer
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether the component is mounted to prevent state updates after unmount
  const mountedRef = useRef(false);
  // Typing indicator throttle: track last-sent time per conversation
  const lastTypingSentRef = useRef<Map<number, number>>(new Map());
  // Typing clear timers: clear a user's typing state after inactivity
  const typingClearTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Stable ref to the event handler — avoids stale closures in the WS onmessage callback
  const handleWsEventRef = useRef<((event: ChatEvent) => void) | null>(null);
  // Ref to current user id — avoids re-creating handleWsEvent on every user object change
  const userIdRef = useRef<number | undefined>(undefined);

  // Keep userIdRef in sync
  useEffect(() => {
    userIdRef.current = user?.id;
  });

  /* ─── Load conversations ─────────────────────────────────── */

  const loadConversations = useCallback(async () => {
    if (!mountedRef.current) return;
    setIsLoading(true);
    try {
      const [convos, unread] = await Promise.all([
        listConversations(),
        getUnreadCount(),
      ]);
      if (!mountedRef.current) return;
      setConversations(convos.slice().sort(byUpdatedAt));
      setTotalUnread(unread);
    } catch {
      // Non-fatal — chat is optional. Leave conversations empty.
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, []);

  const refreshConversations = useCallback(() => {
    void loadConversations();
  }, [loadConversations]);

  /* ─── WebSocket event handler (kept up-to-date via ref) ──── */

  // We define this inline so it always has access to current state setters.
  // The WS onmessage callback calls handleWsEventRef.current so it always
  // invokes the latest version without needing to recreate the WS connection.
  useEffect(() => {
    handleWsEventRef.current = (event: ChatEvent) => {
      switch (event.type) {
        case 'new_message': {
          const msg = event.message as Message | undefined;
          if (!msg) break;

          // Broadcast to any mounted MessageThread listening on this window event.
          window.dispatchEvent(
            new CustomEvent('chat:new_message', {
              detail: { conversation_id: event.conversation_id, message: msg },
            }),
          );

          setConversations((prev) => {
            const next = prev.map((c) => {
              if (c.id !== event.conversation_id) return c;
              const isOwn = userIdRef.current !== undefined && msg.sender_id === userIdRef.current;
              return {
                ...c,
                updated_at: msg.created_at,
                last_message: {
                  content: msg.content,
                  sender_name: msg.sender_name,
                  created_at: msg.created_at,
                },
                unread_count: isOwn ? c.unread_count : c.unread_count + 1,
              };
            });
            return next.slice().sort(byUpdatedAt);
          });

          if (userIdRef.current !== undefined && msg.sender_id !== userIdRef.current) {
            setTotalUnread((n) => n + 1);
          }
          break;
        }

        case 'typing': {
          const typingUserId = event.user_id as number | undefined;
          if (!typingUserId || typingUserId === userIdRef.current) break;

          const convId = event.conversation_id;
          const clearKey = `${convId}:${typingUserId}`;

          setTypingUsers((prev) => {
            const next = new Map(prev);
            const set = new Set(next.get(convId) ?? []);
            set.add(typingUserId);
            next.set(convId, set);
            return next;
          });

          // Clear after 4 seconds of silence from this user
          const existing = typingClearTimersRef.current.get(clearKey);
          if (existing !== undefined) clearTimeout(existing);
          typingClearTimersRef.current.set(
            clearKey,
            setTimeout(() => {
              setTypingUsers((prev) => {
                const next = new Map(prev);
                const set = new Set(next.get(convId) ?? []);
                set.delete(typingUserId);
                if (set.size === 0) next.delete(convId);
                else next.set(convId, set);
                return next;
              });
            }, 4000),
          );
          break;
        }

        case 'read_receipt': {
          // Only care when we ourselves marked something read (echoed back)
          const readUserId = event.user_id as number | undefined;
          if (readUserId !== userIdRef.current) break;

          // Get the current unread count for this conversation from state
          setConversations((prev) => {
            const conv = prev.find((c) => c.id === event.conversation_id);
            const delta = conv?.unread_count ?? 0;
            if (delta > 0) {
              setTotalUnread((t) => Math.max(0, t - delta));
            }
            return prev.map((c) =>
              c.id === event.conversation_id ? { ...c, unread_count: 0 } : c,
            );
          });
          break;
        }

        case 'message_edited':
        case 'message_deleted':
          // MessageThread manages its own message list and handles these
          // by also listening on the window event bus if needed in the future.
          break;
      }
    };
  });

  /* ─── WebSocket connection ───────────────────────────────── */

  const connectWs = useCallback(() => {
    if (!mountedRef.current) return;

    const token = localStorage.getItem('auth_token');
    if (!token) return;

    // Build the WebSocket URL — nginx upgrades /api/ws/ connections
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/ws/chat?token=${encodeURIComponent(token)}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      // Clear any pending reconnect timer
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      if (!mountedRef.current) return;
      let parsed: ChatEvent;
      try {
        parsed = JSON.parse(event.data) as ChatEvent;
      } catch {
        return;
      }
      // Always call the latest handler via ref — never a stale closure
      handleWsEventRef.current?.(parsed);
    };

    ws.onclose = () => {
      wsRef.current = null;
      if (!mountedRef.current) return;
      // Auto-reconnect after 3 seconds (same pattern as SoftphoneContext)
      reconnectTimerRef.current = setTimeout(() => {
        if (mountedRef.current) connectWs();
      }, 3000);
    };

    ws.onerror = () => {
      // onclose fires immediately after — let it handle the reconnect
      ws.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ─── Main effect — init on auth ────────────────────────── */

  useEffect(() => {
    if (!isAuthenticated) return;

    mountedRef.current = true;
    void loadConversations();
    connectWs();

    return () => {
      mountedRef.current = false;

      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      // Clear all typing timers
      typingClearTimersRef.current.forEach((t) => clearTimeout(t));
      typingClearTimersRef.current.clear();

      wsRef.current?.close();
      wsRef.current = null;
    };
  // Depend only on stable identifiers — re-run when auth state or user changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, user?.id]);

  /* ─── Actions ────────────────────────────────────────────── */

  const sendMessage = useCallback(async (conversationId: number, content: string): Promise<Message> => {
    const msg = await apiSendMessage(conversationId, content);
    // Optimistically update the conversation list preview
    setConversations((prev) => {
      const next = prev.map((c) => {
        if (c.id !== conversationId) return c;
        return {
          ...c,
          updated_at: msg.created_at,
          last_message: {
            content: msg.content,
            sender_name: msg.sender_name,
            created_at: msg.created_at,
          },
        };
      });
      return next.slice().sort(byUpdatedAt);
    });
    return msg;
  }, []);

  // Keep a ref to conversations so markRead can read the current unread count
  // without depending on `conversations` in its deps array (which would cause
  // it to be recreated every time the list changes).
  const conversationsRef = useRef<Conversation[]>([]);
  useEffect(() => {
    conversationsRef.current = conversations;
  });

  const markRead = useCallback(async (conversationId: number): Promise<void> => {
    const conv = conversationsRef.current.find((c) => c.id === conversationId);
    const prevUnread = conv?.unread_count ?? 0;
    if (prevUnread === 0) {
      // Nothing to mark — still call the API to ensure server state is consistent
      try { await apiMarkRead(conversationId); } catch { /* non-critical */ }
      return;
    }

    // Optimistic update
    setConversations((prev) =>
      prev.map((c) => (c.id === conversationId ? { ...c, unread_count: 0 } : c)),
    );
    setTotalUnread((t) => Math.max(0, t - prevUnread));

    try {
      await apiMarkRead(conversationId);
    } catch {
      // Revert
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId ? { ...c, unread_count: prevUnread } : c,
        ),
      );
      setTotalUnread((t) => t + prevUnread);
    }
  }, []);

  const sendTyping = useCallback((conversationId: number): void => {
    const now = Date.now();
    const last = lastTypingSentRef.current.get(conversationId) ?? 0;
    // Throttle to once per 3 seconds
    if (now - last < 3000) return;
    lastTypingSentRef.current.set(conversationId, now);
    void sendTypingIndicator(conversationId).catch(() => undefined);
  }, []);

  /* ─── Context value ──────────────────────────────────────── */

  const value: ChatContextValue = {
    conversations,
    totalUnread,
    typingUsers,
    isLoading,
    sendMessage,
    markRead,
    sendTyping,
    refreshConversations,
  };

  return (
    <ChatContext.Provider value={value}>
      {children}
    </ChatContext.Provider>
  );
}

/* ─── Hook ───────────────────────────────────────────────── */

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return ctx;
}
