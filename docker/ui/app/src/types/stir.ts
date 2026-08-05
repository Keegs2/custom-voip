/**
 * STIR/SHAKEN attestation types — map 1:1 to the FastAPI response schemas.
 *
 * The per-call "story" is a chain:
 *   caller `inbound_attest` (verified per `inbound_verstat`, sourced from
 *   `verstat_source`)  →  we emitted `signed_attestation`.
 *
 * Example: "Caller A ✓ (carrier-verified) → Signed div".
 */

/** SHAKEN attestation levels. `div` = diversion (call was forwarded/redirected). */
export type AttestationLevel = 'A' | 'B' | 'C' | 'div';

/** Where the inbound verification verdict (`inbound_verstat`) came from. */
export type VerstatSource = 'carrier' | 'self';

/**
 * Per-call attestation — `GET /v1/cdrs/{call_id}/attestation`.
 * The endpoint is tenant-scoped server-side and returns 404 when a call has no
 * attestation record (older calls, unsigned calls, purely on-net calls).
 */
export interface CallAttestation {
  call_id: string;
  customer_id: number;
  /** The attestation level we (the platform) signed the outbound leg with. */
  signed_attestation: AttestationLevel | null;
  /** The attestation level we intended to sign with (before any downgrade). */
  attest_intent: AttestationLevel | null;
  /** Whether the inbound leg arrived with a valid SHAKEN Identity header. */
  inbound_signed: boolean;
  /** The caller's attestation level, as received on the inbound leg. */
  inbound_attest: AttestationLevel | null;
  /**
   * The verification result for the inbound leg, e.g.
   * "TN-Validation-Passed" / "TN-Validation-Failed" / "No-TN-Validation".
   */
  inbound_verstat: string | null;
  /** Origin of the `inbound_verstat` verdict: carrier-supplied or self-verified. */
  verstat_source: VerstatSource | null;
  created_at: string;
}

/**
 * Per-call attestation as attached to each message in the Homer SIP-trace
 * search response (`POST /v1/homer/search`). Every message sharing a Call-ID
 * carries the SAME object (it's per-call, not per-message); the field is `null`
 * on a message when the call has no stored attestation (legacy / pre-deploy /
 * signing-off).
 *
 * This is the leaner, denormalised sibling of {@link CallAttestation}: it omits
 * the record bookkeeping (`call_id`, `customer_id`, `created_at`) since the row
 * already knows its Call-ID, and — unlike the tenant-scoped detail endpoint —
 * `inbound_signed` may be `null` here (unknown on legacy captures).
 */
export interface MessageAttestation {
  /** The attestation level we (the platform) signed the outbound leg with — the primary badge. */
  signed_attestation: AttestationLevel;
  /** The attestation level we intended to sign with (before any downgrade). */
  attest_intent: 'A' | 'B' | 'div';
  /** Whether the inbound leg arrived with a valid SHAKEN Identity header. `null` = unknown. */
  inbound_signed: boolean | null;
  /** The caller's attestation level, as received on the inbound leg. */
  inbound_attest: 'A' | 'B' | 'C' | null;
  /** The inbound leg's verification result (SHAKEN verstat vocabulary). */
  inbound_verstat:
    | 'TN-Validation-Passed'
    | 'TN-Validation-Failed'
    | 'No-TN-Validation'
    | null;
  /** Origin of the `inbound_verstat` verdict: carrier-supplied or self-verified. */
  verstat_source: VerstatSource | null;
}

/** One row of a summary breakdown: a dimension value and how many calls had it. */
export interface AttestationBreakdownItem {
  /** `null` means the dimension was absent for those rows. */
  value: string | null;
  count: number;
}

/**
 * Aggregate attestation summary — `GET /v1/stir/attestation-summary` (admin).
 * Defaults to the last 7 days when no date range is supplied.
 */
export interface AttestationSummary {
  total: number;
  customer_id: number | null;
  start_date: string;
  end_date: string;
  by_signed_attestation: AttestationBreakdownItem[];
  by_inbound_attest: AttestationBreakdownItem[];
  by_inbound_verstat: AttestationBreakdownItem[];
  by_verstat_source: AttestationBreakdownItem[];
}

/** Query params for the admin summary endpoint. All optional. */
export interface AttestationSummaryParams {
  customer_id?: number;
  /** ISO date (YYYY-MM-DD) or full ISO timestamp — the API accepts either. */
  start_date?: string;
  end_date?: string;
}
