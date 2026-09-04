import { apiRequest, apiRequestBlob } from './client';
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
  /**
   * PINNED CURSOR-PAGING CONTRACT — strict upper bound: the server returns
   * only messages with `timestamp_ns < before_ns`. Page N+1 re-issues the
   * SAME committed search with `before_ns = oldest_ts_ns` of page N.
   * Preferred over shrinking `end_time` (which parses at microsecond
   * precision server-side while timestamps are nanosecond — before_ns is
   * exact, so adjacent pages share zero rows by construction). Omit on the
   * first page.
   */
  before_ns?: number;
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
  /**
   * `timestamp_ns` of the OLDEST message actually returned in `data` — the
   * cursor for the next (older) page: re-issue the same search with
   * `before_ns: oldest_ts_ns`. `null` when `data` is empty. Absent on
   * old/cached responses (treat as no cursor → paging unavailable).
   */
  oldest_ts_ns?: number | null;
  /**
   * True when the base fetch was truncated by the server's internal cap —
   * older messages exist in the window beyond what was returned (the store
   * returns newest-first). Absent on old/cached responses (treat as false).
   */
  has_more?: boolean;
}

export async function searchSipTraces(
  params: HomerSearchParams,
): Promise<HomerSearchResponse> {
  return apiRequest('POST', '/homer/search', params);
}

/** A ready-to-save PCAP export: the bytes plus the filename to save them as. */
export interface PcapDownload {
  blob: Blob;
  filename: string;
}

/**
 * Downloads the captured SIP signaling for a call as a PCAP file.
 *
 * PINNED CONTRACT — `GET /v1/homer/pcap?call_id=<sip call-id>&internal=<bool>&correlated=true`:
 * these three params and NOTHING else (FastAPI silently drops undeclared
 * params, so any extra would be dead weight; any missing one changes meaning).
 *
 * - `internal=false` (default UX): edge-only capture (SBC ↔ carrier/customer)
 *   — internal topology absent, safe to hand outside Granite.
 * - `internal=true`: full path through our network, engineers only.
 * - `correlated=true`: the server folds in all correlated legs (A + B).
 *
 * The response filename is server-owned via Content-Disposition
 * (`sip_<callid>[_internal].pcap`); we fall back to mirroring that scheme
 * only if the header is missing.
 *
 * Error details are human-readable and surfaced verbatim by callers —
 * notably the 404 "no edge packets — may be on-net; retry with internal=true".
 */
export async function downloadPcap(
  callId: string,
  internal: boolean,
): Promise<PcapDownload> {
  const params = new URLSearchParams({
    call_id: callId,
    internal: internal ? 'true' : 'false',
    correlated: 'true',
  });
  const { blob, filename } = await apiRequestBlob(`/homer/pcap?${params.toString()}`);
  const fallback = `sip_${callId.replace(/[^A-Za-z0-9._@-]/g, '_')}${internal ? '_internal' : ''}.pcap`;
  return { blob, filename: filename ?? fallback };
}
