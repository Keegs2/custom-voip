/**
 * API credential (programmable-voice API key) types.
 *
 * Map 1:1 to the backend `api_credentials` router (built in parallel):
 *   GET    /api-credentials         -> ApiCredential[]      (never returns the secret)
 *   POST   /api-credentials         -> ApiCredentialCreated (api_secret shown ONCE)
 *   DELETE /api-credentials/{id}    -> 204
 *
 * The plaintext secret is only ever present on the create response
 * (`ApiCredentialCreated.api_secret`) — it is never persisted client-side and
 * cannot be retrieved again after the modal is dismissed.
 */

/** A stored API credential as returned by the list endpoint. Never carries the secret. */
export interface ApiCredential {
  id: number;
  /** Public key id — safe to display. Pairs with the secret for HTTP Basic auth. */
  api_key: string;
  /** Human label the customer gave the key, if any. */
  label: string | null;
  /** Lifecycle status, e.g. "active" | "revoked". */
  status: string;
  created_at: string;
  /** ISO timestamp of the last authenticated request, or null if never used. */
  last_used_at: string | null;
  /** Optional per-key status callback URL. */
  status_callback_url: string | null;
}

/** Request body for creating a new API credential. */
export interface ApiCredentialCreate {
  label?: string;
  status_callback_url?: string;
}

/**
 * Response for a freshly created credential. This is the ONLY time the plaintext
 * `api_secret` is returned — surface it once, then discard it.
 */
export interface ApiCredentialCreated {
  id: number;
  api_key: string;
  /** Plaintext secret — shown exactly once, never stored, never returned again. */
  api_secret: string;
  label: string | null;
  created_at: string;
}
