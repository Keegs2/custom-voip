/**
 * API client for programmable-voice API credentials.
 *
 * Backs the "API Keys" panel on the Programmable Voice portal. Endpoints are
 * built in parallel on the FastAPI side and are tenant-scoped server-side
 * (a customer only ever sees / mutates their own keys).
 *
 * The plaintext secret is returned by `createApiCredential` ONCE — callers must
 * surface it immediately and never persist it.
 */

import { apiRequest } from './client';
import type {
  ApiCredential,
  ApiCredentialCreate,
  ApiCredentialCreated,
} from '../types/apiCredential';

/**
 * GET /api-credentials — list this customer's API keys (no secrets).
 *
 * Normalised to a plain array. Tolerates either a bare array or a
 * `{ items }` envelope so the panel never has to branch on response shape.
 */
export async function listApiCredentials(): Promise<ApiCredential[]> {
  const raw = await apiRequest<ApiCredential[] | { items?: ApiCredential[] }>(
    'GET',
    '/api-credentials',
  );
  if (Array.isArray(raw)) return raw;
  return raw.items ?? [];
}

/**
 * POST /api-credentials — mint a new key/secret pair.
 * The returned `api_secret` is the only copy that will ever exist client-side.
 */
export async function createApiCredential(
  data: ApiCredentialCreate = {},
): Promise<ApiCredentialCreated> {
  return apiRequest('POST', '/api-credentials', data);
}

/** DELETE /api-credentials/{id} — revoke a key. Resolves on 204. */
export async function deleteApiCredential(id: number): Promise<void> {
  return apiRequest('DELETE', `/api-credentials/${id}`);
}
