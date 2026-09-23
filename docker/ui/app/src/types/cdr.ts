import type { TrafficGrade } from './customer';
import type { StirBadgeFields } from './stir';

export type ProductType = 'rcf' | 'api' | 'trunk';
export type CallDirection = 'inbound' | 'outbound';
/** Deployment zone — one self-contained SIP stack per GCP region. */
export type CdrZone = 'east' | 'west' | 'central';

/**
 * CDR leg (migration 48 — docs/CDR_LEG_SPLIT_CONTRACT.md). 'A' = the call
 * row (one per call, unchanged set); 'B' = one row per CARRIER bridge
 * attempt. Pre-migration rows carry NULL.
 */
export type CdrLeg = 'A' | 'B';

/**
 * Staff-only `leg` read param on GET /cdrs + /cdrs/summary:
 *  - 'calls' (server default) — one row per call (`leg IS DISTINCT FROM 'B'`)
 *  - 'all'   — A-leg + every carrier B-leg row
 *  - 'b'     — carrier B-leg rows only
 * Tenants: the API always applies 'calls' (param ignored).
 */
export type CdrRowsMode = 'calls' | 'all' | 'b';

/**
 * CDR row. Extends the shared STIR badge payload (`stir_attestation`,
 * `stir_eff_actual`, `stir_outcome`, `stir_badge`, `stir_badge_source`) —
 * present on GET /cdrs and GET /cdrs/{uuid} since migration 47.
 *
 * TWO SHAPES (API services/tenant_redaction.py):
 *  - STAFF (admin/support): the full row — exact `duration_seconds` /
 *    `billable_seconds`, money, rating, routing and RTP volume fields.
 *  - TENANT (customer users): an allowlisted row — NO money/rating/fraud/
 *    routing internals and NO exact duration. `duration_minutes` (whole
 *    minutes, ≥1 for any answered call) replaces the seconds fields, and
 *    `answer_time`/`end_time` are floored to the minute.
 * Everything below marked "staff only" is ABSENT on tenant rows — read it
 * through the helpers in utils/callDuration.ts, never assume presence.
 */
export interface Cdr extends StirBadgeFields {
  uuid: string;
  start_time: string;
  answer_time?: string | null;
  end_time?: string | null;
  caller_id: string;
  destination: string;
  customer_id: number;
  product_type: ProductType;
  direction: CallDirection;
  /** Staff only — exact start→end seconds. */
  duration_seconds?: number;
  /** Staff only — billed seconds. */
  billable_seconds?: number;
  /** Tenant only — whole minutes (0 = unanswered; ≥1 for answered calls). */
  duration_minutes?: number;
  /** Staff only (this and every money / rating / routing field below). */
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

  // Carrier attribution (migration 40 + on-net migration 23).
  /** Origination carrier for inbound calls ('bandwidth' | 'sinch'; NULL on
      pre-attribution rows = implicit Bandwidth — the platform default). */
  inbound_carrier?: string | null;
  /** Origination PoP (e.g. 'denver', 'chicago'); NULL when unknown. */
  inbound_carrier_pop?: string | null;
  /** True when the call was delivered on-net (no carrier hairpin). */
  on_net?: boolean | null;

  // Quality / RTP metrics
  mos?: number | null;
  quality_pct?: number | null;
  r_factor?: number | null;
  flaw_total?: number | null;

  // Packet loss. packet_loss_count is FS's autoflush skip counter (discards,
  // NOT network loss); packet_loss_pct is the real network-loss indicator,
  // computed from flaw_total / inbound packets.
  packet_loss_count?: number | null;
  packet_total_count?: number | null;
  packet_loss_pct?: number | null;

  // Jitter — running jitter std-dev in real ms (sqrt of FS's inter-arrival
  // variance): min = calmest ("floor"), max = worst ("peak"),
  // avg = sqrt((min_var+max_var)/2) — RMS mid-band ESTIMATE, not a true mean.
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
  /** FreeSWITCH node that produced the CDR (`fs_node` var / zone-derived). */
  freeswitch_node?: string | null;
  sip_from_user?: string | null;
  sip_to_user?: string | null;
  sip_user_agent?: string | null;
  network_addr?: string | null;

  // A/B leg split (migration 48). Staff rows only — absent on tenant rows.
  /** 'A' call row, 'B' carrier bridge attempt, NULL = pre-split legacy row. */
  leg?: CdrLeg | null;
  /** Call identity: the A-leg uuid (== own uuid on A rows; NULL on legacy). */
  call_id?: string | null;
  /** 1-based carrier bridge attempt number (B rows only; NULL otherwise). */
  leg_attempt?: number | null;
}

/**
 * Query params for GET /cdrs (and, minus pagination, GET /cdrs/summary —
 * the API accepts the identical filter set on both).
 *
 * PINNED 1:1 to the router's declared params (routers/cdrs.py query_cdrs):
 * customer_id, trunk_id, product_type, direction, destination (prefix),
 * sbc_id, zone, start_date, end_date, rated_only, leg + call_id (staff),
 * limit, offset — and NOTHING else. FastAPI silently drops undeclared query params (the old
 * `start_from`/`start_to` and `caller_id`/`sort_by`/`sort_dir` were exactly
 * such dead filters), so any param added here MUST exist on the router.
 */
export interface CdrSearchParams {
  customer_id?: number;
  /** Server-side trunk filter (cdrs.trunk_id is stored as text of this id). */
  trunk_id?: number;
  product_type?: ProductType;
  direction?: CallDirection;
  /** Literal destination PREFIX match (LIKE 'value%'). */
  destination?: string;
  /** Range start — ISO 8601 UTC instant (e.g. 2026-08-04T13:30:00.000Z). */
  start_date?: string;
  /** Range end — ISO 8601 UTC instant. */
  end_date?: string;
  /** Zone filter — east | west | central (omit for all zones). */
  zone?: CdrZone;
  sbc_id?: string;
  /** Only CDRs that have been rated (rated_at IS NOT NULL). */
  rated_only?: boolean;
  /** Staff-only row model (see CdrRowsMode). Omit = server default 'calls'. */
  leg?: CdrRowsMode;
  /** Staff-only: every row of ONE call — the A-leg uuid plus its carrier
      B rows (pair with leg='all'). Omit = no call filter. */
  call_id?: string;
  limit?: number;
  offset?: number;
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

/**
 * Grouped CDR summary row (day / hour / destination), returned by /cdrs/summary.
 * Staff rows carry `total_duration_sec` + `total_cost`; tenant rows carry
 * `total_minutes` (answered-call total, rounded once) and, for
 * group_by=destination, `avg_duration_minutes` — never seconds or money.
 */
export interface CdrSummaryRow {
  date?: string | null;
  hour?: string | null;
  destination?: string | null;
  product_type?: string | null;
  direction?: string | null;
  total_calls: number;
  answered_calls: number;
  /** Staff only. */
  total_duration_sec?: number;
  /** Staff only. */
  total_cost?: number;
  /** Tenant only. */
  total_minutes?: number;
  /** Tenant only (group_by=destination). */
  avg_duration_minutes?: number | null;
}

export interface CdrSummaryResponse {
  summary: CdrSummaryRow[];
}
