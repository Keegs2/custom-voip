import { apiRequest } from './client';
import type { MessageAttestation } from '../types/stir';

export interface HomerSearchParams {
  /**
   * Free-form number needle — send the user's input VERBATIM. The server owns
   * normalization: it strips to digits, drops the leading 1 from an 11-digit
   * NANP number, and 422s if fewer than 3 digits remain. Matches caller OR
   * callee OR anywhere in the SIP message (payload-wide containment).
   */
  number?: string;
  /** Caller needle — advanced use. Same free-form server-side normalization. */
  from_user?: string;
  /** Callee needle — advanced use. Same free-form server-side normalization. */
  to_user?: string;
  call_id?: string;
  start_time: string; // ISO 8601
  end_time: string;   // ISO 8601
}

export interface HomerSearchResult {
  timestamp: string;
  timestamp_ns: number;
  from_user: string;
  to_user: string;
  callid: string;
  method: string;
  src_ip: string;
  dst_ip: string;
  status: number | null;
  /** HEP capture node id(s), e.g. "100" (Kamailio) / "200" (FreeSWITCH) */
  node?: string;
  /** CSeq value, e.g. "102 INVITE" — extracted server-side from the raw message */
  cseq?: string;
  /** Topmost Via branch — per-hop transaction fingerprint (server-side dedup key) */
  via_branch?: string;
  /**
   * True for self-hop / re-traversal copies of in-dialog requests through the
   * SBC's own VIP (src == dst == SBC-VIP loopback captures). Rendered as a
   * self-loop glyph, hidden by default. Absent on old/cached responses.
   */
  hairpin?: boolean;
  /**
   * True when the API adjusted this row's display position for SIP causality
   * (the stored capture timestamp was corrupted, e.g. ingest-stamped 15-20ms
   * late). Absent on old/cached responses.
   */
  ts_corrected?: boolean;
  /**
   * AUTHORITATIVE display order (0..n-1) computed by the API pipeline.
   * When present on every row, the ladder sorts by it instead of timestamps.
   * Absent on old/cached responses — the UI then falls back to timestamp
   * sort plus a defensive causality pass.
   */
  seq?: number;
  /** Raw SIP message body (full headers + SDP) from the Loki log line */
  raw_msg?: string | null;
  /**
   * STIR/SHAKEN attestation for the CALL this message belongs to. The API
   * attaches the SAME object to every message sharing a Call-ID (it's per-call),
   * or `null` when the call has no stored attestation (legacy / pre-deploy /
   * signing-off). Absent on old/cached responses.
   */
  attestation?: MessageAttestation | null;
}

export interface HomerSearchResponse {
  data: HomerSearchResult[];
  correlations: Record<string, string[]>;
  /** Present (true) when the X-CID correlation window was truncated */
  correlation_truncated?: boolean;
  /** Pipeline diagnostics (e.g. timestamp-corruption notices) — show unobtrusively */
  pipeline_warnings?: string[];
}

export async function searchSipTraces(
  params: HomerSearchParams,
): Promise<HomerSearchResponse> {
  return apiRequest('POST', '/homer/search', params);
}
