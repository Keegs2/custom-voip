import { apiRequest } from './client';
import type { CallAttestation } from '../types/stir';

/**
 * Fetch the per-call STIR/SHAKEN attestation record.
 *
 * Tenant-scoped server-side. Throws `ApiError` with `status === 404` when the
 * call has no attestation record (older/unsigned/on-net calls) — callers should
 * treat 404 as "not signed / n/a" rather than an error (see `AttestationChain`).
 */
export async function getCallAttestation(callId: string): Promise<CallAttestation> {
  return apiRequest('GET', `/cdrs/${encodeURIComponent(callId)}/attestation`);
}
