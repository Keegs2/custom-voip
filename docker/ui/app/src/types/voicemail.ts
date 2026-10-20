/**
 * Visual Voicemail — wire types, 1:1 with the API contract in
 * docs/ENCRYPTED_VOICEMAIL_INTERFACES.md §4 (router `routers/voicemail.py`,
 * mounted at /v1/voicemail; the browser calls /api/v1/voicemail/...).
 *
 * Timestamps are ISO-8601 strings as the API serialises them. Every field
 * here is in the contract — nothing is invented UI-side; anything the UI
 * derives (folder labels, expiry hints) lives in pages/voicemail/format.ts.
 */

/** voicemail_boxes.status. 'deleted' boxes never come back from the API. */
export type MailboxStatus = 'active' | 'suspended' | 'deleted';

/** voicemail_boxes.greeting_mode. */
export type GreetingMode = 'standard' | 'custom';

/** The three message folders (GET /mailboxes/{id}/messages?folder=). */
export type VoicemailFolder = 'inbox' | 'saved' | 'trash';

/** GET /summary — drives the sidebar and the page's first paint. */
export interface VoicemailSummary {
  /** customers.voicemail_enabled for the scoped customer. */
  enabled: boolean;
  mailbox_count: number;
  unread_count: number;
  /** True for staff (admin) — may create / suspend / delete mailboxes. */
  can_manage: boolean;
}

/** §4.1 `Mailbox`. Counts are over stored, not-deleted messages; bytes_used includes trash. */
export interface Mailbox {
  id: number;
  customer_id: number;
  customer_name: string;
  /** E.164, e.g. +16175550134. */
  did: string;
  label: string;
  status: MailboxStatus;
  /** IANA zone the mailbox shows its times in, e.g. America/New_York. */
  timezone: string;
  greeting_mode: GreetingMode;
  active_greeting_id: number | null;
  has_pin: boolean;
  retention_days: number;
  max_message_seconds: number;
  max_messages: number;
  max_bytes: number;
  message_count: number;
  unread_count: number;
  bytes_used: number;
  created_at: string;
}

/** POST /mailboxes (admin). */
export interface MailboxCreate {
  customer_id: number;
  did: string;
  label?: string;
  timezone?: string;
  /** 4–10 digits. */
  pin?: string;
}

/** PATCH /mailboxes/{id}. `status` is honoured for admins only. */
export interface MailboxUpdate {
  label?: string;
  timezone?: string;
  greeting_mode?: GreetingMode;
  active_greeting_id?: number;
  status?: Exclude<MailboxStatus, 'deleted'>;
}

/** GET /available-numbers (admin) — unassigned DIDs a mailbox can claim. */
export interface AvailableNumber {
  did: string;
  city: string | null;
  state: string | null;
}

/** §4.2 `Message`. */
export interface VoicemailMessage {
  id: number;
  mailbox_id: number;
  caller_id_number: string | null;
  caller_id_name: string | null;
  duration_ms: number;
  size_bytes: number;
  is_read: boolean;
  is_saved: boolean;
  /** Set while the message is in Trash. */
  deleted_at: string | null;
  created_at: string;
  /** created_at + mailbox.retention_days — the message is purged after this. */
  expires_at: string;
}

/** GET /mailboxes/{id}/messages response. */
export interface MessagePage {
  items: VoicemailMessage[];
  /** Messages in this folder (all pages). */
  total: number;
  /** Unread messages in this folder. */
  unread: number;
}

/** PATCH /messages/{id}. */
export interface MessageUpdate {
  is_read?: boolean;
  is_saved?: boolean;
}

/** §4.3 `Greeting`. */
export interface Greeting {
  id: number;
  mailbox_id: number;
  label: string;
  duration_ms: number;
  size_bytes: number;
  is_active: boolean;
  created_at: string;
}

/**
 * POST /messages/{id}/playback-token and /greetings/{id}/playback-token.
 * `url` is relative to the site (`/api/v1/voicemail/.../audio?t=<token>`)
 * and is used verbatim as the <audio> src / download href. The token lives
 * `expires_in` seconds (120).
 */
export interface PlaybackToken {
  url: string;
  expires_in: number;
}

/** POST /customers/{customer_id}/crypto-erase (admin) — §4.4. */
export interface CryptoEraseResult {
  mailboxes: number;
  messages: number;
  greetings: number;
}
