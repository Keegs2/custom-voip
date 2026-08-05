import { apiRequest } from './client';
import type {
  CallAttestation,
  AttestationSummary,
  AttestationSummaryParams,
} from '../types/stir';

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

/**
 * Fetch the aggregate STIR/SHAKEN attestation summary (admin only).
 * Defaults to the last 7 days when no date range is supplied.
 */
export async function getAttestationSummary(
  params: AttestationSummaryParams = {},
): Promise<AttestationSummary> {
  const query = new URLSearchParams();
  if (params.customer_id !== undefined) query.set('customer_id', String(params.customer_id));
  if (params.start_date) query.set('start_date', params.start_date);
  if (params.end_date) query.set('end_date', params.end_date);

  const qs = query.toString();
  return apiRequest('GET', `/stir/attestation-summary${qs ? `?${qs}` : ''}`);
}
