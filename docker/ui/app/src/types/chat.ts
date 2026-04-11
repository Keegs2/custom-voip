export interface Conversation {
  id: number;
  type: 'direct' | 'group';
  name: string | null;
  customer_id: number;
  created_by: number;
  created_at: string;
  updated_at: string;
  last_message?: MessagePreview;
  unread_count: number;
  participants: ChatParticipant[];
}

export interface ChatParticipant {
  user_id: number;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  presence_status?: string;
}

export interface Message {
  id: number;
  conversation_id: number;
  sender_id: number;
  sender_name: string;
  sender_email: string;
  content: string | null;
  message_type: 'text' | 'file' | 'image' | 'system';
  reply_to_id: number | null;
  edited_at: string | null;
  deleted_at: string | null;
  created_at: string;
  attachments?: Attachment[];
}

export interface MessagePreview {
  content: string | null;
  sender_name: string;
  created_at: string;
}

export interface Attachment {
  id: number;
  filename: string;
  mime_type: string;
  file_size: number;
  url: string;
}

export interface ChatEvent {
  type: 'new_message' | 'typing' | 'read_receipt' | 'message_edited' | 'message_deleted';
  conversation_id: number;
  [key: string]: unknown;
}

/** Shape of a user entry returned by GET /api/extensions/directory */
export interface DirectoryUser {
  user_id: number;
  name: string;
  email: string;
  extension_number?: string;
  department?: string;
}
