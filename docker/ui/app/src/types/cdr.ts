import type { TrafficGrade } from './customer';

export type ProductType = 'rcf' | 'api' | 'trunk';
export type CallDirection = 'inbound' | 'outbound';

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
}

export interface CdrSearchParams {
  customer_id?: number;
  product_type?: ProductType;
  direction?: CallDirection;
  caller_id?: string;
  destination?: string;
  start_from?: string;
  start_to?: string;
  hangup_cause?: string;
  limit?: number;
  offset?: number;
  sort_by?: string;
  sort_dir?: 'asc' | 'desc';
}

export interface CdrSearchResult {
  /** Normalised list of CDR records (from either `items` or `cdrs` field). */
  items: Cdr[];
  /** Total matching records (from either `total` or `count` field). */
  total: number;
  limit: number;
  offset: number;
}
