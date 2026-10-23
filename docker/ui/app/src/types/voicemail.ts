/**
 * Visual Voicemail — wire types, 1:1 with the API contract in
 * docs/ENCRYPTED_VOICEMAIL_INTERFACES.md §4 (router `routers/voicemail.py`,
 * mounted at /v1/voicemail; the browser calls /api/v1/voicemail/...).
 *
 * Timestamps are ISO-8601 strings as the API serialises them. Every field
 * here is in the contract — nothing is invented UI-side; anything the UI
 * derives (folder labels, expiry hints) lives in pages/voicemail/format.ts.
 *
 * Transcription (v1.1) fields are additive, per
 * docs/VOICEMAIL_TRANSCRIPTION_PLAN.md §10.1 / §11.1.
 */

/** voicemail_boxes.status. 'deleted' boxes never come back from the API. */
export type MailboxStatus = 'active' | 'suspended' | 'deleted';

/** voicemail_boxes.greeting_mode. */
export type GreetingMode = 'standard' | 'custom';

/** The three message folders (GET /mailboxes/{id}/messages?folder=). */
export type VoicemailFolder = 'inbox' | 'saved' | 'trash';

/* ─── Transcription (v1.1) — docs/VOICEMAIL_TRANSCRIPTION_PLAN.md §10–§11 ─── */

/**
 * The API's view of one message's transcript. With no transcript row yet it
 * is derived: `pending` if the mailbox has transcription on, else `disabled`.
 */
export type TranscriptStatus = 'pending' | 'processing' | 'done' | 'empty' | 'failed' | 'disabled';

/** The languages the API accepts (422 "Choose a supported language." otherwise). */
export type TranscriptionLanguage = 'en-US' | 'es-US' | 'fr-CA';

export const TRANSCRIPTION_LANGUAGES: readonly { id: TranscriptionLanguage; label: string }[] = [
  { id: 'en-US', label: 'English (US)' },
  { id: 'es-US', label: 'Spanish (US)' },
  { id: 'fr-CA', label: 'French (Canada)' },
];

/** `Message.transcript` — on every route that returns a Message. Never carries text. */
export interface MessageTranscriptSummary {
  status: TranscriptStatus;
  /** Only when status is 'done'. */
  confidence: number | null;
}

export interface TranscriptSegment {
  start_ms: number;
  end_ms: number;
  text: string;
  confidence: number | null;
}

/**
 * GET /messages/{id}/transcript. For any status other than 'done': `text`
 * null, `segments` [] and `confidence` null; `model` and `language` are set
 * once known.
 */
export interface Transcript {
  message_id: number;
  status: TranscriptStatus;
  language: string | null;
  model: string | null;
  confidence: number | null;
  text: string | null;
  segments: TranscriptSegment[];
  completed_at: string | null;
  /**
   * Writer + transcription available + mailbox on + not trashed + status in
   * failed|disabled|empty (admins also for 'done', via force).
   */
  can_retry: boolean;
}

/** One row of GET /mailboxes/{id}/transcript-snippets. `snippet` null = not decrypted. */
export interface TranscriptSnippet {
  message_id: number;
  status: TranscriptStatus;
  snippet: string | null;
}

/** GET /mailboxes/{id}/transcript-snippets. `unavailable` = some done snippets came back null. */
export interface TranscriptSnippetPage {
  items: TranscriptSnippet[];
  unavailable: boolean;
}

/** POST /messages/{id}/transcript/retry → 202. */
export interface TranscriptRetryResult {
  message_id: number;
  status: TranscriptStatus;
}

/** POST /mailboxes/{id}/transcripts/backfill → 202. */
export interface TranscriptBackfillResult {
  queued: number;
}

/** GET /summary — drives the sidebar and the page's first paint. */
export interface VoicemailSummary {
  /** customers.voicemail_enabled for the scoped customer. */
  enabled: boolean;
  mailbox_count: number;
  unread_count: number;
  /** True for staff (admin) — may create / suspend / delete mailboxes. */
  can_manage: boolean;
  /** Transcription is live: the platform flag is on and its config is valid. */
  transcription_available: boolean;
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
  /** Off by default (owner decision O1). Only platform admins may change it (O2). */
  transcription_enabled: boolean;
  transcription_language: TranscriptionLanguage;
}

/** POST /mailboxes (admin). */
export interface MailboxCreate {
  customer_id: number;
  did: string;
  label?: string;
  timezone?: string;
  /** 4–10 digits. */
  pin?: string;
  /** Default false; true while transcription is unavailable → 409. */
  transcription_enabled?: boolean;
  transcription_language?: TranscriptionLanguage;
}

/**
 * PATCH /mailboxes/{id}. `status` is honoured for admins only, and so are the
 * two transcription fields (403 "Only an administrator can change
 * transcription settings." for anyone else — owner decision O2).
 */
export interface MailboxUpdate {
  label?: string;
  timezone?: string;
  greeting_mode?: GreetingMode;
  active_greeting_id?: number;
  status?: Exclude<MailboxStatus, 'deleted'>;
  /** true while transcription is unavailable → 409. false flips this mailbox's pending jobs to disabled. */
  transcription_enabled?: boolean;
  transcription_language?: TranscriptionLanguage;
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
  /** Transcript status only — list routes never decrypt (plan T11). */
  transcript: MessageTranscriptSummary;
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
