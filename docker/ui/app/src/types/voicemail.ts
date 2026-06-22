/**
 * Visual Voicemail — frontend types.
 *
 * These mirror the backend shapes in `docker/api/src/routers/voicemail.py`
 * (the mailbox-centric product surface, VISUAL_VOICEMAIL_PRODUCT_PLAN.md §3).
 *
 * The encryption boundary is deliberate: a message NEVER carries a raw audio
 * URL. Playback is a two-step decrypt-stream — `getVoicemailPlaybackUrl(id)`
 * mints a scoped token and returns a `PlaybackSource`. Components only ever see
 * the resolved `PlaybackSource`, never a ciphertext/object URL.
 */

/* ─── Mailbox ─────────────────────────────────────────────── */

export type MailboxStatus = 'active' | 'suspended' | 'deleted';

/** `voicemail_boxes.encryption_status`. Open union — backend may add states. */
export type EncryptionStatus = 'active' | 'crypto_erased' | 'pending' | (string & {});

/** KMS provider backing the mailbox KEK (`LocalKmsProvider` / `GcpKmsProvider`). */
export type KekProvider = 'local' | 'gcp' | (string & {});

export interface VoicemailMailbox {
  id: number;
  customer_id: number;
  user_id?: number | null;
  extension_id?: number | null;
  label: string | null;
  status: MailboxStatus;
  timezone: string;
  retention_days: number;
  kek_provider: KekProvider;
  encryption_status: EncryptionStatus;
  plan_sku: string | null;
  legal_hold: boolean;
  has_pin: boolean;
  created_at: string;
  updated_at: string | null;
}

/* ─── Transcript (discriminated by status) ────────────────── */

/**
 * Transcription job status. In Phase 1 this is usually `skipped` or `pending`
 * (the faster-whisper worker ships in Phase 2), so the UI must render the
 * non-`done` states gracefully.
 */
export type TranscriptStatus = 'pending' | 'processing' | 'done' | 'failed' | 'skipped';

/** Word-level timing (faster-whisper `word_timestamps=True`, Phase 3). */
export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
  confidence?: number | null;
}

export interface Transcript {
  status: TranscriptStatus;
  /** Decrypted transcript text. Present only when `status === 'done'`. */
  text: string | null;
  language: string | null;
  confidence: number | null;
  words: TranscriptWord[] | null;
}

/* ─── Message ─────────────────────────────────────────────── */

export interface VoicemailMessage {
  id: number;
  mailbox_id?: number | null;
  caller_id: string;
  caller_name: string | null;
  duration_ms: number;
  is_read: boolean;
  /** Present on the mailbox-centric surface; absent on the legacy list. */
  is_saved?: boolean;
  transcript_status?: TranscriptStatus | null;
  /** True when the row is envelope-encrypted (`wrapped_dek IS NOT NULL`). */
  encrypted?: boolean;
  created_at: string;
  /** Detail-only — populated by `GET /voicemail/messages/{id}`. */
  transcript?: Transcript;
  /** Optional precomputed waveform peaks (0..1). Frontend falls back when absent. */
  peaks?: number[];
}

export interface MessageCount {
  unread: number;
  total: number;
  saved: number;
}

/* ─── Greetings ───────────────────────────────────────────── */

export type GreetingType = 'unavailable' | 'busy' | 'name' | 'temporary' | (string & {});

export interface Greeting {
  id: number;
  mailbox_id: number;
  greeting_type: GreetingType;
  is_active: boolean;
  schedule_kind: string | null;
  schedule_json?: Record<string, unknown> | null;
  has_audio: boolean;
  created_at?: string;
}

/* ─── Settings ────────────────────────────────────────────── */

export interface MailboxSettings {
  mailbox_id: number;
  notify_email: boolean;
  notify_email_address: string | null;
  attach_audio_to_email: boolean;
  notify_sms: boolean;
  notify_sms_number: string | null;
  transcription_enabled: boolean;
  transcription_language: string;
  greeting_mode: string;
  updated_at: string | null;
}

/* ─── Bindings (mailbox resolution) ───────────────────────── */

/** `voicemail_box_bindings.binding_type`. `forward_access` is schema-reserved. */
export type BindingType = 'dedicated_did' | 'attached' | 'forward_access';

/** The originating revup product an `attached` mailbox falls back from. */
export type AttachProduct = 'rcf' | 'trunk' | 'ucaas' | 'api';

export interface Binding {
  id: number;
  mailbox_id: number;
  binding_type: BindingType;
  did: string | null;
  attach_product: AttachProduct | null;
  attach_ref: string | null;
  created_at?: string;
}

/* ─── Playback source (the decrypt-stream boundary) ───────── */

/**
 * Resolved, playable handle for an encrypted message/greeting.
 *
 * - `url`   — the Range-capable `GET …/stream?t=<token>` endpoint; an
 *             `<audio>`/player can consume `url` natively. This is the v1 mode.
 * - `bytes` — documented fallback if the contract ever returns raw bytes; the
 *             caller is responsible for revoking `blobUrl`.
 */
export type PlaybackSource =
  | { kind: 'url'; url: string; expires_at: number; mime: string }
  | { kind: 'bytes'; blobUrl: string; mime: string };

/* ─── Provisioning payloads (frontend wizard concern) ─────── */

/** Fields shared by both delivery models when creating a mailbox. */
export interface MailboxPersonalization {
  label: string;
  timezone?: string;
  retention_days?: number;
  plan_sku?: string;
  /** Admin-only: target customer. Ignored for tenant users (server-scoped). */
  customer_id?: number;
  /** Optional 4–10 digit PIN to set on the new mailbox. */
  pin?: string;
  /** Optional email-notification opt-in captured during setup. */
  notify_email?: boolean;
  notify_email_address?: string;
}

/**
 * Discriminated by the v1 delivery model (§0):
 * - `dedicated_did` — buy a per-mailbox access DID.
 * - `attached`      — add voicemail to an existing revup line.
 */
export type CreateMailboxPayload =
  | (MailboxPersonalization & { delivery: 'dedicated_did'; did: string })
  | (MailboxPersonalization & {
      delivery: 'attached';
      attach_product: AttachProduct;
      attach_ref: string;
    });
