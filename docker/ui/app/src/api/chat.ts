import { apiRequest } from './client';
import type { Attachment, Conversation, Message } from '../types/chat';

/**
 * List all conversations the current user is a participant of.
 */
export async function listConversations(): Promise<Conversation[]> {
  return apiRequest<Conversation[]>('GET', '/chat/conversations');
}

/**
 * Create a new direct or group conversation.
 */
export async function createConversation(
  type: 'direct' | 'group',
  participantIds: number[],
  name?: string,
): Promise<Conversation> {
  return apiRequest<Conversation>('POST', '/chat/conversations', {
    type,
    participant_ids: participantIds,
    name: name ?? null,
  });
}

/**
 * Get a single conversation by ID (includes participants).
 */
export async function getConversation(id: number): Promise<Conversation> {
  return apiRequest<Conversation>('GET', `/chat/conversations/${id}`);
}

/**
 * List messages for a conversation. Pass beforeId for cursor-based pagination
 * to fetch older messages (messages with id < beforeId).
 */
export async function listMessages(conversationId: number, beforeId?: number): Promise<Message[]> {
  const qs = beforeId !== undefined ? `?before_id=${beforeId}` : '';
  return apiRequest<Message[]>('GET', `/chat/conversations/${conversationId}/messages${qs}`);
}

/**
 * Send a new message to a conversation.
 */
export async function sendMessage(
  conversationId: number,
  content: string,
  messageType: Message['message_type'] = 'text',
  replyToId?: number,
): Promise<Message> {
  return apiRequest<Message>('POST', `/chat/conversations/${conversationId}/messages`, {
    content,
    message_type: messageType,
    reply_to_id: replyToId ?? null,
  });
}

/**
 * Edit an existing message.
 */
export async function editMessage(
  conversationId: number,
  messageId: number,
  content: string,
): Promise<Message> {
  return apiRequest<Message>(
    'PATCH',
    `/chat/conversations/${conversationId}/messages/${messageId}`,
    { content },
  );
}

/**
 * Soft-delete a message. The message remains but deleted_at is set.
 */
export async function deleteMessage(conversationId: number, messageId: number): Promise<void> {
  return apiRequest<void>('DELETE', `/chat/conversations/${conversationId}/messages/${messageId}`);
}

/**
 * Mark all messages in a conversation as read for the current user.
 */
export async function markConversationRead(conversationId: number): Promise<void> {
  return apiRequest<void>('POST', `/chat/conversations/${conversationId}/read`);
}

/**
 * Send a typing indicator for the current user in a conversation.
 */
export async function sendTypingIndicator(conversationId: number): Promise<void> {
  return apiRequest<void>('POST', `/chat/conversations/${conversationId}/typing`);
}

/**
 * Get the total unread message count across all conversations.
 * Returns 0 on failure so it never breaks the UI badge.
 */
export async function getUnreadCount(): Promise<number> {
  try {
    const result = await apiRequest<{ total_unread: number }>('GET', '/chat/unread');
    return result.total_unread ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Upload a file attachment. Returns the stored Attachment record with a URL.
 */
export async function uploadFile(file: File): Promise<Attachment> {
  const token = localStorage.getItem('auth_token');
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch('/api/chat/attachments', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'Upload failed');
    throw new Error(text);
  }

  return response.json() as Promise<Attachment>;
}
