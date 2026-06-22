/**
 * Visual Voicemail API client.
 *
 * Two surfaces, both proxied through `/api` (nginx in prod, Vite in dev) and
 * dual-mounted by the backend at `/v1/voicemail` and `/voicemail`:
 *
 *  1. Legacy extension-bound endpoints (`listVoicemails`, `getUnreadCount`, …) —
 *     kept working for the sidebar unread badge + any pre-product callers.
 *  2. The mailbox-centric product surface — mailbox CRUD, messages, the
 *     decrypt-stream playback boundary, bindings, greetings, settings/PIN, and a
 *     `provisionMailbox` helper used by the setup wizard.
 *
 * THE ENCRYPTION BOUNDARY lives in exactly one place: `getVoicemailPlaybackUrl`
 * (and its greeting twin). Everything else only ever handles metadata.
 */
import { apiRequest } from './client';
import type {
  VoicemailMailbox,
  VoicemailMessage,
  MessageCount,
  Greeting,
  MailboxSettings,
  Binding,
  PlaybackSource,
  CreateMailboxPayload,
  MailboxStatus,
} from '../types/voicemail';

/* ─────────────────────────────────────────────────────────────────────────
 * Internal helpers
 * ──────────────────────────────────────────────────────────────────────── */

const AUTH_TOKEN_KEY = 'auth_token';

/**
 * Turn the backend's `stream_url` (e.g. `/v1/voicemail/messages/42/stream?t=…`)
 * into a browser-requestable URL. Every other call in the app goes through the
 * `/api` proxy prefix (see `api/client.ts`), and the proxy resolves `/api/v1/…`
 * to the API's `/v1/…` mount — so we prefix `/api` here too for consistency.
 * Absolute URLs (or already-prefixed paths) are passed through untouched.
 */
function toProxiedStreamUrl(streamUrl: string): string {
  if (/^https?:\/\//i.test(streamUrl)) return streamUrl;
  if (streamUrl.startsWith('/api/')) return streamUrl;
  return `/api${streamUrl.startsWith('/') ? '' : '/'}${streamUrl}`;
}

/**
 * Multipart upload helper. `apiRequest` is JSON-only; greeting uploads need
 * `FormData`, so this mirrors its auth-header + error behaviour with a raw
 * `fetch`. (Mirrors the `documents.ts` upload pattern.)
 */
async function uploadMultipart<T>(path: string, form: FormData): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = localStorage.getItem(AUTH_TOKEN_KEY);
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, { method: 'POST', headers, body: form });
  if (!res.ok) {
    let detail = `Upload failed (${res.status})`;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === 'string') detail = body.detail;
    } catch {
      /* non-JSON error body — keep the status message */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

/* ─────────────────────────────────────────────────────────────────────────
 * Mailboxes
 * ──────────────────────────────────────────────────────────────────────── */

export interface MailboxListParams {
  customer_id?: number;
  status?: MailboxStatus;
  limit?: number;
  offset?: number;
}

export async function listMailboxes(params: MailboxListParams = {}): Promise<VoicemailMailbox[]> {
  const qs = new URLSearchParams();
  if (params.customer_id !== undefined) qs.set('customer_id', String(params.customer_id));
  if (params.status) qs.set('status', params.status);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const q = qs.toString();
  const raw = await apiRequest<VoicemailMailbox[] | { items?: VoicemailMailbox[] }>(
    'GET',
    `/voicemail/mailboxes${q ? `?${q}` : ''}`,
  );
  return Array.isArray(raw) ? raw : raw.items ?? [];
}

export async function getMailbox(mailboxId: number): Promise<VoicemailMailbox> {
  return apiRequest('GET', `/voicemail/mailboxes/${mailboxId}`);
}

export interface MailboxCreateBody {
  label?: string;
  customer_id?: number;
  user_id?: number;
  extension_id?: number;
  timezone?: string;
  retention_days?: number;
  plan_sku?: string;
}

export async function createMailbox(body: MailboxCreateBody): Promise<VoicemailMailbox> {
  return apiRequest('POST', '/voicemail/mailboxes', body);
}

export interface MailboxUpdateBody {
  label?: string;
  timezone?: string;
  retention_days?: number;
  status?: MailboxStatus;
}

export async function updateMailbox(
  mailboxId: number,
  body: MailboxUpdateBody,
): Promise<VoicemailMailbox> {
  return apiRequest('PUT', `/voicemail/mailboxes/${mailboxId}`, body);
}

export async function deleteMailbox(mailboxId: number): Promise<void> {
  return apiRequest('DELETE', `/voicemail/mailboxes/${mailboxId}`);
}

/* ─────────────────────────────────────────────────────────────────────────
 * Messages
 * ──────────────────────────────────────────────────────────────────────── */

export interface MailboxMessagesParams {
  is_read?: boolean;
  is_saved?: boolean;
  include_deleted?: boolean;
  limit?: number;
  offset?: number;
}

export async function listMailboxMessages(
  mailboxId: number,
  params: MailboxMessagesParams = {},
): Promise<VoicemailMessage[]> {
  const qs = new URLSearchParams();
  if (params.is_read !== undefined) qs.set('is_read', String(params.is_read));
  if (params.is_saved !== undefined) qs.set('is_saved', String(params.is_saved));
  if (params.include_deleted) qs.set('include_deleted', 'true');
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const q = qs.toString();
  const raw = await apiRequest<VoicemailMessage[] | { items?: VoicemailMessage[] }>(
    'GET',
    `/voicemail/mailboxes/${mailboxId}/messages${q ? `?${q}` : ''}`,
  );
  return Array.isArray(raw) ? raw : raw.items ?? [];
}

export async function getMailboxMessageCount(mailboxId: number): Promise<MessageCount> {
  const raw = await apiRequest<Partial<MessageCount>>(
    'GET',
    `/voicemail/mailboxes/${mailboxId}/messages/count`,
  );
  return { unread: raw.unread ?? 0, total: raw.total ?? 0, saved: raw.saved ?? 0 };
}

/** Message detail — includes the decrypted `transcript` object (§3.5). */
export async function getMessage(messageId: number): Promise<VoicemailMessage> {
  return apiRequest('GET', `/voicemail/messages/${messageId}`);
}

export async function markMessageRead(
  messageId: number,
  isRead = true,
): Promise<void> {
  await apiRequest('PUT', `/voicemail/messages/${messageId}/read?is_read=${isRead}`);
}

export async function markMessageSaved(
  messageId: number,
  isSaved = true,
): Promise<void> {
  await apiRequest('PUT', `/voicemail/messages/${messageId}/save?is_saved=${isSaved}`);
}

export async function deleteMessage(messageId: number): Promise<void> {
  return apiRequest('DELETE', `/voicemail/messages/${messageId}`);
}

/* ─────────────────────────────────────────────────────────────────────────
 * Playback — THE DECRYPT-STREAM BOUNDARY (§3.4)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Resolve a playable handle for an encrypted message. Two-step:
 *   1. POST …/playback-token  → mints a 120s scoped token + `stream_url`.
 *   2. The returned `url` is the Range-capable `GET …/stream?t=<token>`; an
 *      `<audio>`/player consumes it directly (server decrypts in memory and
 *      serves the plaintext WAV with HTTP 206).
 *
 * Components must call THIS — never construct an object/ciphertext URL.
 */
export async function getVoicemailPlaybackUrl(messageId: number): Promise<PlaybackSource> {
  const res = await apiRequest<{ stream_url: string; expires_in: number }>(
    'POST',
    `/voicemail/messages/${messageId}/playback-token`,
  );
  return {
    kind: 'url',
    url: toProxiedStreamUrl(res.stream_url),
    expires_at: Date.now() + (res.expires_in ?? 120) * 1000,
    mime: 'audio/wav',
  };
}

/** Greeting playback — same decrypt-stream mechanism as messages. */
export async function getGreetingPlaybackUrl(greetingId: number): Promise<PlaybackSource> {
  const res = await apiRequest<{ stream_url: string; expires_in: number }>(
    'POST',
    `/voicemail/greetings/${greetingId}/playback-token`,
  );
  return {
    kind: 'url',
    url: toProxiedStreamUrl(res.stream_url),
    expires_at: Date.now() + (res.expires_in ?? 120) * 1000,
    mime: 'audio/wav',
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * Bindings (mailbox resolution map)
 * ──────────────────────────────────────────────────────────────────────── */

export async function listBindings(mailboxId: number): Promise<Binding[]> {
  const raw = await apiRequest<Binding[] | { items?: Binding[] }>(
    'GET',
    `/voicemail/mailboxes/${mailboxId}/bindings`,
  );
  return Array.isArray(raw) ? raw : raw.items ?? [];
}

export interface BindingCreateBody {
  binding_type: 'dedicated_did' | 'attached';
  did?: string;
  attach_product?: 'rcf' | 'trunk' | 'ucaas' | 'api';
  attach_ref?: string;
}

export async function createBinding(
  mailboxId: number,
  body: BindingCreateBody,
): Promise<Binding> {
  return apiRequest('POST', `/voicemail/mailboxes/${mailboxId}/bindings`, body);
}

export async function deleteBinding(mailboxId: number, bindingId: number): Promise<void> {
  return apiRequest('DELETE', `/voicemail/mailboxes/${mailboxId}/bindings/${bindingId}`);
}

/* ─────────────────────────────────────────────────────────────────────────
 * Greetings (list/upload — recorder UI is Phase 2)
 * ──────────────────────────────────────────────────────────────────────── */

export async function listGreetings(mailboxId: number): Promise<Greeting[]> {
  const raw = await apiRequest<Greeting[] | { items?: Greeting[] }>(
    'GET',
    `/voicemail/mailboxes/${mailboxId}/greetings`,
  );
  return Array.isArray(raw) ? raw : raw.items ?? [];
}

export interface GreetingUploadOptions {
  greeting_type?: string;
  schedule_kind?: string;
  is_active?: boolean;
}

export async function uploadGreeting(
  mailboxId: number,
  file: File | Blob,
  opts: GreetingUploadOptions = {},
): Promise<Greeting> {
  const form = new FormData();
  form.append('file', file, file instanceof File ? file.name : 'greeting.wav');
  if (opts.greeting_type) form.append('greeting_type', opts.greeting_type);
  if (opts.schedule_kind) form.append('schedule_kind', opts.schedule_kind);
  if (opts.is_active !== undefined) form.append('is_active', String(opts.is_active));
  return uploadMultipart<Greeting>(`/voicemail/mailboxes/${mailboxId}/greetings`, form);
}

export async function deleteGreeting(mailboxId: number, greetingId: number): Promise<void> {
  return apiRequest('DELETE', `/voicemail/mailboxes/${mailboxId}/greetings/${greetingId}`);
}

/* ─────────────────────────────────────────────────────────────────────────
 * Settings + PIN
 * ──────────────────────────────────────────────────────────────────────── */

export async function getMailboxSettings(mailboxId: number): Promise<MailboxSettings> {
  return apiRequest('GET', `/voicemail/mailboxes/${mailboxId}/settings`);
}

export interface SettingsUpdateBody {
  notify_email?: boolean;
  notify_email_address?: string;
  attach_audio_to_email?: boolean;
  notify_sms?: boolean;
  notify_sms_number?: string;
  transcription_enabled?: boolean;
  transcription_language?: string;
  greeting_mode?: string;
}

export async function updateMailboxSettings(
  mailboxId: number,
  body: SettingsUpdateBody,
): Promise<MailboxSettings> {
  return apiRequest('PUT', `/voicemail/mailboxes/${mailboxId}/settings`, body);
}

export async function setMailboxPin(
  mailboxId: number,
  pin: string,
): Promise<{ status: string; mailbox_id: number; has_pin: boolean }> {
  return apiRequest('PUT', `/voicemail/mailboxes/${mailboxId}/pin`, { pin });
}

/* ─────────────────────────────────────────────────────────────────────────
 * Provisioning helper — drives the two-step (create mailbox → bind) flow used
 * by the setup wizard, plus optional PIN + email-notification setup.
 * ──────────────────────────────────────────────────────────────────────── */

export async function provisionMailbox(
  payload: CreateMailboxPayload,
): Promise<VoicemailMailbox> {
  const mailbox = await createMailbox({
    label: payload.label,
    timezone: payload.timezone,
    retention_days: payload.retention_days,
    plan_sku: payload.plan_sku,
    customer_id: payload.customer_id,
  });

  if (payload.delivery === 'dedicated_did') {
    await createBinding(mailbox.id, { binding_type: 'dedicated_did', did: payload.did });
  } else {
    await createBinding(mailbox.id, {
      binding_type: 'attached',
      attach_product: payload.attach_product,
      attach_ref: payload.attach_ref,
    });
  }

  if (payload.pin) {
    await setMailboxPin(mailbox.id, payload.pin);
  }
  if (payload.notify_email && payload.notify_email_address) {
    await updateMailboxSettings(mailbox.id, {
      notify_email: true,
      notify_email_address: payload.notify_email_address,
    });
  }

  return mailbox;
}

/* ─────────────────────────────────────────────────────────────────────────
 * LEGACY extension-bound endpoints (kept for the sidebar unread badge and any
 * pre-product callers). Do not use these on the new mailbox-centric surface.
 * ──────────────────────────────────────────────────────────────────────── */

export interface VoicemailListParams {
  extension_id?: number;
  unread_only?: boolean;
  limit?: number;
  offset?: number;
}

export interface VoicemailListResult {
  items: VoicemailMessage[];
  total: number;
  unread_count: number;
}

export async function listVoicemails(
  params: VoicemailListParams = {},
): Promise<VoicemailListResult | VoicemailMessage[]> {
  const query = new URLSearchParams();
  if (params.extension_id !== undefined) query.set('extension_id', String(params.extension_id));
  if (params.unread_only) query.set('unread_only', 'true');
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.offset !== undefined) query.set('offset', String(params.offset));
  const qs = query.toString();
  return apiRequest<VoicemailListResult>('GET', `/voicemail${qs ? `?${qs}` : ''}`);
}

export async function getVoicemail(id: number): Promise<VoicemailMessage> {
  return apiRequest<VoicemailMessage>('GET', `/voicemail/${id}`);
}

export async function deleteVoicemail(id: number): Promise<void> {
  return apiRequest<void>('DELETE', `/voicemail/${id}`);
}

export async function markVoicemailRead(id: number): Promise<void> {
  await apiRequest('PUT', `/voicemail/${id}/read`);
}

/**
 * Unread count for the sidebar badge. The legacy `/count` endpoint returns
 * `{ unread, total }`; older builds returned `{ unread_count }`. Accept both so
 * the badge contract (`useSoftphone().refreshVoicemailCount`) stays intact.
 */
export async function getUnreadCount(extensionId?: number): Promise<number> {
  const query = new URLSearchParams();
  query.set('unread_only', 'true');
  if (extensionId !== undefined) query.set('extension_id', String(extensionId));
  try {
    const result = await apiRequest<{ unread?: number; unread_count?: number }>(
      'GET',
      `/voicemail/count?${query.toString()}`,
    );
    return result.unread ?? result.unread_count ?? 0;
  } catch {
    return 0;
  }
}
