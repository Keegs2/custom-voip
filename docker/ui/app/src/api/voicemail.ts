/**
 * Visual Voicemail API — docs/ENCRYPTED_VOICEMAIL_INTERFACES.md §4.1–4.4.
 *
 * The router is mounted at /v1/voicemail; apiRequest prefixes /api, so the
 * browser calls /api/v1/voicemail/... (nginx strips /api, and has its own
 * unbuffered location for this prefix — see docker/ui/nginx.conf).
 *
 * Scope rule (contract §4): an admin passes `customer_id` to choose the
 * customer (required on create, optional on list ⇒ all customers); a tenant
 * never needs it — the API scopes them to their own account. Per-id routes
 * take no customer_id.
 *
 * Audio never flows through here: playback/download use the short-lived
 * `url` from a playback token verbatim as an <audio src> / link href, and
 * greetings upload as a raw `audio/wav` body (apiRequestRaw).
 *
 * Transcription (v1.1, docs/VOICEMAIL_TRANSCRIPTION_PLAN.md §10.2 / §11.2):
 * transcript text only ever arrives from getTranscript / getTranscriptSnippets
 * (both `Cache-Control: no-store`). It is held in React Query memory only —
 * never persisted (plan D8).
 */
import { apiRequest, apiRequestRaw } from './client';
import type {
  AvailableNumber,
  CryptoEraseResult,
  Greeting,
  Mailbox,
  MailboxCreate,
  MailboxUpdate,
  MessagePage,
  MessageUpdate,
  PlaybackToken,
  Transcript,
  TranscriptBackfillResult,
  TranscriptRetryResult,
  TranscriptSnippetPage,
  VoicemailFolder,
  VoicemailMessage,
  VoicemailSummary,
} from '../types/voicemail';

const BASE = '/v1/voicemail';

function withQuery(path: string, params: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) qs.set(key, String(value));
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

/* ─── 4.1 Summary + mailboxes ─────────────────────────────── */

export function getVoicemailSummary(customerId?: number): Promise<VoicemailSummary> {
  return apiRequest('GET', withQuery(`${BASE}/summary`, { customer_id: customerId }));
}

export function listMailboxes(customerId?: number): Promise<Mailbox[]> {
  return apiRequest('GET', withQuery(`${BASE}/mailboxes`, { customer_id: customerId }));
}

export function getMailbox(mailboxId: number): Promise<Mailbox> {
  return apiRequest('GET', `${BASE}/mailboxes/${mailboxId}`);
}

/** Admin only. 409 when the DID is no longer available; 503 when KMS is down (nothing created). */
export function createMailbox(body: MailboxCreate): Promise<Mailbox> {
  return apiRequest('POST', `${BASE}/mailboxes`, body);
}

/** 422 when switching to a custom greeting with no stored active greeting. */
export function updateMailbox(mailboxId: number, body: MailboxUpdate): Promise<Mailbox> {
  return apiRequest('PATCH', `${BASE}/mailboxes/${mailboxId}`, body);
}

export function setMailboxPin(mailboxId: number, pin: string): Promise<void> {
  return apiRequest('PUT', `${BASE}/mailboxes/${mailboxId}/pin`, { pin });
}

/** Admin only. Purges every message and greeting; the DID returns to the pool. */
export function deleteMailbox(mailboxId: number): Promise<void> {
  return apiRequest('DELETE', `${BASE}/mailboxes/${mailboxId}`);
}

/** Admin only. `q` is digits (area code, prefix, any part of the number). */
export function listAvailableNumbers(q?: string, limit = 50): Promise<AvailableNumber[]> {
  return apiRequest('GET', withQuery(`${BASE}/available-numbers`, { q: q || undefined, limit }));
}

/* ─── 4.2 Messages ────────────────────────────────────────── */

export interface ListMessagesParams {
  folder: VoicemailFolder;
  limit?: number;
  offset?: number;
}

export function listMessages(mailboxId: number, { folder, limit = 50, offset = 0 }: ListMessagesParams): Promise<MessagePage> {
  return apiRequest('GET', withQuery(`${BASE}/mailboxes/${mailboxId}/messages`, { folder, limit, offset }));
}

export function updateMessage(messageId: number, body: MessageUpdate): Promise<VoicemailMessage> {
  return apiRequest('PATCH', `${BASE}/messages/${messageId}`, body);
}

/** Moves the message to Trash. */
export function trashMessage(messageId: number): Promise<VoicemailMessage> {
  return apiRequest('DELETE', `${BASE}/messages/${messageId}`);
}

export function restoreMessage(messageId: number): Promise<VoicemailMessage> {
  return apiRequest('POST', `${BASE}/messages/${messageId}/restore`);
}

/** Permanent: the encrypted audio object is deleted. */
export function purgeMessage(messageId: number): Promise<void> {
  return apiRequest('DELETE', `${BASE}/messages/${messageId}/purge`);
}

/** Mints a 120 s playback URL; also marks the message read server-side. */
export function getMessagePlaybackToken(messageId: number, download = false): Promise<PlaybackToken> {
  return apiRequest('POST', `${BASE}/messages/${messageId}/playback-token`, { download });
}

/* ─── Transcripts (v1.1) ──────────────────────────────────── */

/**
 * The full transcript (admin, tenant incl. readonly). A `done` transcript is
 * decrypted and audited (`transcript_view`) on EVERY call, so callers cache it
 * (pages/voicemail/voicemailData.ts). 503 = temporarily unavailable
 * (Retry-After: 5); 500 = failed integrity check — show the detail verbatim.
 * Does not mark the message read.
 */
export function getTranscript(messageId: number): Promise<Transcript> {
  return apiRequest('GET', `${BASE}/messages/${messageId}/transcript`);
}

/**
 * Writer. Queues a re-run for a failed / disabled / empty transcript
 * (`force` is admin-only and also re-runs `done`). 409 sentences explain why
 * not (unavailable, mailbox off, in Trash, already running, already done).
 */
export function retryTranscript(messageId: number, force = false): Promise<TranscriptRetryResult> {
  return apiRequest('POST', `${BASE}/messages/${messageId}/transcript/retry`, { force });
}

/** The API's cap on ids per snippet request (422 "Ask for at most 50 messages at a time."). */
export const TRANSCRIPT_SNIPPET_BATCH_MAX = 50;

/**
 * One-line snippets for up to 50 messages of one mailbox (each `done` one is
 * decrypted server-side, one audit row per call). Ids outside the mailbox are
 * silently omitted. Never a 5xx for a decrypt problem: those rows come back
 * `snippet: null` with `unavailable: true`.
 */
export function getTranscriptSnippets(mailboxId: number, ids: readonly number[]): Promise<TranscriptSnippetPage> {
  if (ids.length === 0 || ids.length > TRANSCRIPT_SNIPPET_BATCH_MAX) {
    return Promise.reject(new RangeError(`getTranscriptSnippets takes 1–${TRANSCRIPT_SNIPPET_BATCH_MAX} ids, got ${ids.length}`));
  }
  // Integer ids only, so the comma list needs no escaping.
  return apiRequest('GET', `${BASE}/mailboxes/${mailboxId}/transcript-snippets?ids=${ids.map((id) => Math.trunc(id)).join(',')}`);
}

/**
 * Admin only (owner decision O2). Queues the mailbox's newest (≤ 200) stored
 * messages whose transcript is `disabled`. 409 when transcription is
 * unavailable or off for the mailbox.
 */
export function backfillTranscripts(mailboxId: number): Promise<TranscriptBackfillResult> {
  return apiRequest('POST', `${BASE}/mailboxes/${mailboxId}/transcripts/backfill`);
}

/* ─── 4.3 Greetings ───────────────────────────────────────── */

export function listGreetings(mailboxId: number): Promise<Greeting[]> {
  return apiRequest('GET', `${BASE}/mailboxes/${mailboxId}/greetings`);
}

/**
 * Uploads a canonical greeting WAV (PCM s16le, mono, 8000|16000 Hz, ≤ 120 s,
 * ≤ 5 MB) as the raw request body. The browser produces it — the API never
 * transcodes (pages/voicemail/audio/).
 */
export function uploadGreeting(
  mailboxId: number,
  wav: Blob,
  { label, activate }: { label: string; activate: boolean },
): Promise<Greeting> {
  return apiRequestRaw(
    'POST',
    withQuery(`${BASE}/mailboxes/${mailboxId}/greetings`, { label, activate }),
    wav,
    'audio/wav',
  );
}

/** If the greeting was active the mailbox falls back to the standard greeting. */
export function deleteGreeting(greetingId: number): Promise<void> {
  return apiRequest('DELETE', `${BASE}/greetings/${greetingId}`);
}

export function getGreetingPlaybackToken(greetingId: number): Promise<PlaybackToken> {
  return apiRequest('POST', `${BASE}/greetings/${greetingId}/playback-token`, {});
}

/* ─── 4.4 Admin ───────────────────────────────────────────── */

/**
 * Destroys the customer's voicemail key — every message and greeting becomes
 * unrecoverable immediately. `confirm` is what the operator typed and must
 * be exactly `ERASE <customer_id>` (the API checks it). No UI calls this in
 * v1 (it is a staff runbook action); typed here so the module covers the
 * whole contract surface.
 */
export function cryptoEraseCustomer(customerId: number, confirm: string): Promise<CryptoEraseResult> {
  return apiRequest('POST', `${BASE}/customers/${customerId}/crypto-erase`, { confirm });
}
