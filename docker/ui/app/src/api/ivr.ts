/**
 * Visual IVR API — docs/IVR_INTERFACES.md §8.2, typed 1:1.
 *
 * Mounted at /v1/ivr; apiRequest prefixes /api, so the browser calls
 * /api/v1/ivr/... (nginx strips /api; prompt uploads and audio go through
 * the /api/v1/ivr/prompts/ location — see docker/ui/nginx.conf).
 *
 * Scope rule (contract §8.2): a tenant never sends customer_id — the API
 * scopes them to their own account. Staff (an admin, incl. "View as
 * Customer") send `?customer_id=` on EVERY route, per-id ones included; an
 * admin without one gets 400 `customer_id required`, which the UI never
 * provokes (it shows the PreviewPrompt / a customer picker instead). Every
 * function therefore takes the scope's `customerId` (undefined = tenant).
 *
 * Publishing sends `{ revision }` ONLY — the server compiles the stored draft
 * at that revision. Compiled output never leaves the browser.
 */
import { apiPostForBlob, apiRequest, apiRequestForm } from './client';
import type {
  Destinations,
  Flow,
  FlowCreate,
  FlowSummary,
  FlowUpdate,
  FlowVersion,
  FlowVersionDetail,
  IvrGraph,
  IvrNumber,
  IvrSummary,
  NumberUpdate,
  PlaybackUrl,
  Prompt,
  PublishResult,
  SimulateRequest,
  SimulateResult,
  TtsPromptCreate,
  ValidateResult,
  Voice,
} from '../types/ivr';

const BASE = '/v1/ivr';

/** `path` + `?customer_id=` for staff. */
function scoped(path: string, customerId: number | undefined): string {
  if (customerId === undefined) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}customer_id=${encodeURIComponent(String(customerId))}`;
}

/* ─── Summary ─────────────────────────────────────────────── */

export function getIvrSummary(customerId?: number): Promise<IvrSummary> {
  return apiRequest('GET', scoped(`${BASE}/summary`, customerId));
}

/* ─── Flows ───────────────────────────────────────────────── */

export function listFlows(customerId?: number): Promise<FlowSummary[]> {
  return apiRequest('GET', scoped(`${BASE}/flows`, customerId));
}

/** 201. The server seeds an `entry` block when `draft_graph` is omitted. */
export function createFlow(body: FlowCreate, customerId?: number): Promise<Flow> {
  return apiRequest('POST', scoped(`${BASE}/flows`, customerId), body);
}

export function getFlow(flowId: number, customerId?: number): Promise<Flow> {
  return apiRequest('GET', scoped(`${BASE}/flows/${flowId}`, customerId));
}

/** A stale `revision` → 409 `stale_revision` with `current_revision` (see ivrErrors.ts). */
export function updateFlow(flowId: number, body: FlowUpdate, customerId?: number): Promise<Flow> {
  return apiRequest('PUT', scoped(`${BASE}/flows/${flowId}`, customerId), body);
}

/** 204; 409 `flow_in_use` while a number is bound to it. */
export function deleteFlow(flowId: number, customerId?: number): Promise<void> {
  return apiRequest('DELETE', scoped(`${BASE}/flows/${flowId}`, customerId));
}

/** Server compile + policy, no side effects. Omit `draft_graph` to check the stored draft. */
export function validateFlow(flowId: number, draftGraph: IvrGraph | undefined, customerId?: number): Promise<ValidateResult> {
  const body = draftGraph === undefined ? {} : { draft_graph: draftGraph };
  return apiRequest('POST', scoped(`${BASE}/flows/${flowId}/validate`, customerId), body);
}

/** Compiles the STORED draft at `revision`. 422 `invalid_flow` carries `errors`. */
export function publishFlow(flowId: number, revision: number, customerId?: number): Promise<PublishResult> {
  return apiRequest('POST', scoped(`${BASE}/flows/${flowId}/publish`, customerId), { revision });
}

export function listFlowVersions(flowId: number, customerId?: number): Promise<FlowVersion[]> {
  return apiRequest('GET', scoped(`${BASE}/flows/${flowId}/versions`, customerId));
}

export function getFlowVersion(flowId: number, version: number, customerId?: number): Promise<FlowVersionDetail> {
  return apiRequest('GET', scoped(`${BASE}/flows/${flowId}/versions/${version}`, customerId));
}

/** Copies the version's graph into the draft (no publish). Returns the flow. */
export function restoreFlowVersion(
  flowId: number,
  version: number,
  revision: number,
  customerId?: number,
): Promise<Flow> {
  return apiRequest('POST', scoped(`${BASE}/flows/${flowId}/versions/${version}/restore`, customerId), {
    revision,
  });
}

/** Walks the CURRENT draft (pass it) with a chosen caller, time and key presses. */
export function simulateFlow(flowId: number, body: SimulateRequest, customerId?: number): Promise<SimulateResult> {
  return apiRequest('POST', scoped(`${BASE}/flows/${flowId}/simulate`, customerId), body);
}

/* ─── Numbers ─────────────────────────────────────────────── */

export function listIvrNumbers(customerId?: number): Promise<IvrNumber[]> {
  return apiRequest('GET', scoped(`${BASE}/numbers`, customerId));
}

/** Rename and/or bind a flow (`flow_id: null` unbinds). The flow must be the same customer's. */
export function updateIvrNumber(numberId: number, body: NumberUpdate, customerId?: number): Promise<IvrNumber> {
  return apiRequest('PUT', scoped(`${BASE}/numbers/${numberId}`, customerId), body);
}

/* ─── Destinations (the transfer picker, D3) ──────────────── */

export function getDestinations(customerId?: number): Promise<Destinations> {
  return apiRequest('GET', scoped(`${BASE}/destinations`, customerId));
}

/* ─── Prompts ─────────────────────────────────────────────── */

export function listPrompts(customerId?: number): Promise<Prompt[]> {
  return apiRequest('GET', scoped(`${BASE}/prompts`, customerId));
}

export function createTtsPrompt(body: TtsPromptCreate, customerId?: number): Promise<Prompt> {
  return apiRequest('POST', scoped(`${BASE}/prompts/tts`, customerId), body);
}

/**
 * Multipart `name` + `file` (PCM16 WAV from the shared voicemail transcoder,
 * pages/voicemail/audio). The API re-validates and rewrites the header; any
 * other format is 422.
 */
export function uploadPrompt(
  name: string,
  wav: Blob,
  customerId?: number,
  /** Additive hint for `ivr_prompts.kind` (§1); a server that ignores it stores 'upload'. */
  kind: 'upload' | 'recording' = 'upload',
): Promise<Prompt> {
  const form = new FormData();
  form.append('name', name);
  form.append('kind', kind);
  form.append('file', wav, 'prompt.wav');
  return apiRequestForm('POST', scoped(`${BASE}/prompts/upload`, customerId), form);
}

export function renamePrompt(promptId: number, name: string, customerId?: number): Promise<Prompt> {
  return apiRequest('PATCH', scoped(`${BASE}/prompts/${promptId}`, customerId), { name });
}

/** 204; 409 `prompt_in_use` with the flows whose DRAFT uses it. */
export function deletePrompt(promptId: number, customerId?: number): Promise<void> {
  return apiRequest('DELETE', scoped(`${BASE}/prompts/${promptId}`, customerId));
}

/** Rendered, not stored. Rate-limited (30/min per user) → 429. */
export function previewTts(text: string, voice: string, customerId?: number): Promise<Blob> {
  return apiPostForBlob(scoped(`${BASE}/prompts/tts-preview`, customerId), { text, voice });
}

/** Short-TTL signed URL; GET it as `<audio src>`. */
export function getPromptPlaybackUrl(promptId: number, customerId?: number): Promise<PlaybackUrl> {
  return apiRequest('POST', scoped(`${BASE}/prompts/${promptId}/playback-token`, customerId), {});
}

/* ─── Voices ──────────────────────────────────────────────── */

export function listVoices(customerId?: number): Promise<Voice[]> {
  return apiRequest('GET', scoped(`${BASE}/voices`, customerId));
}
