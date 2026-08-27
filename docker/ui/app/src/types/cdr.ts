import type { TrafficGrade } from './customer';

export type ProductType = 'rcf' | 'api' | 'trunk';
export type CallDirection = 'inbound' | 'outbound';
/** Deployment zone — one self-contained SIP stack per GCP region. */
export type CdrZone = 'east' | 'west' | 'central';

export interface Cdr {
  uuid: string;
  start_time: string;
  answer_time?: string | null;
  end_time?: string | null;
  caller_id: string;
  destination: string;
  customer_id: number;
  product_type: ProductType;
  direction: CallDirection;
  duration_seconds: number;
  billable_seconds: number;
  rate_per_min?: number | null;
  total_cost?: number | null;
  carrier_cost?: number | null;
  margin?: number | null;
  hangup_cause?: string | null;
  sip_code?: number | null;
  carrier_used?: string | null;
  traffic_grade?: TrafficGrade | null;
  fraud_score?: number | null;
  rated_at?: string | null;
  trunk_id?: string | null;

  // Quality / RTP metrics
  mos?: number | null;
  quality_pct?: number | null;
  r_factor?: number | null;
  flaw_total?: number | null;

  // Packet loss
  packet_loss_count?: number | null;
  packet_total_count?: number | null;
  packet_loss_pct?: number | null;

  // Jitter (milliseconds)
  jitter_min_ms?: number | null;
  jitter_max_ms?: number | null;
  jitter_avg_ms?: number | null;

  // RTP audio in (from carrier)
  rtp_audio_in_raw_bytes?: number | null;
  rtp_audio_in_media_bytes?: number | null;
  rtp_audio_in_packet_count?: number | null;
  rtp_audio_in_mean_interval?: number | null;
  rtp_audio_in_jitter_burst_rate?: number | null;
  rtp_audio_in_jitter_loss_rate?: number | null;

  // RTP audio out (to carrier)
  rtp_audio_out_raw_bytes?: number | null;
  rtp_audio_out_media_bytes?: number | null;
  rtp_audio_out_packet_count?: number | null;

  // Codecs
  read_codec?: string | null;
  write_codec?: string | null;

  // SIP / network metadata
  sbc_id?: string | null;
  sip_from_user?: string | null;
  sip_to_user?: string | null;
  sip_user_agent?: string | null;
  network_addr?: string | null;
}

/**
 * Query params for GET /cdrs (and, minus pagination, GET /cdrs/summary —
 * the API accepts the identical filter set on both).
 *
 * IMPORTANT — wire names: the API declares `start_date` / `end_date`
 * (ISO 8601 UTC). FastAPI silently drops undeclared query params, so any
 * other name (the old `start_from`/`start_to`) never reaches the endpoint
 * and the API falls back to its last-24-hours default.
 */
export interface CdrSearchParams {
  customer_id?: number;
  product_type?: ProductType;
  direction?: CallDirection;
  caller_id?: string;
  destination?: string;
  /** Range start — ISO 8601 UTC instant (e.g. 2026-08-04T13:30:00.000Z). */
  start_date?: string;
  /** Range end — ISO 8601 UTC instant. */
  end_date?: string;
  hangup_cause?: string;
  /** Zone filter — east | west | central (omit for all zones). */
  zone?: CdrZone;
  sbc_id?: string;
  /** Only CDRs that have been rated (rated_at IS NOT NULL). */
  rated_only?: boolean;
  limit?: number;
  offset?: number;
  sort_by?: string;
  sort_dir?: 'asc' | 'desc';
}

export interface CdrSearchResult {
  /** Normalised list of CDR records (from either `items` or `cdrs` field). */
  items: Cdr[];
  /**
   * Full match count for the current filters, independent of limit/offset —
   * the API's `total` field. Absent until the API version that emits it is
   * deployed. The legacy `count` field is the number of rows in THIS
   * response (== items.length), NOT a match total, so it must never be
   * surfaced as one — treating it as the total is exactly what made the CDR
   * page look like it "maxes out" at one page.
   */
  total?: number;
  limit: number;
  offset: number;
}

/** Grouped CDR summary row (day / hour / destination), returned by /cdrs/summary. */
export interface CdrSummaryRow {
  date?: string | null;
  hour?: string | null;
  destination?: string | null;
  product_type?: string | null;
  direction?: string | null;
  total_calls: number;
  answered_calls: number;
  total_duration_sec: number;
  total_cost: number;
}

export interface CdrSummaryResponse {
  summary: CdrSummaryRow[];
}
