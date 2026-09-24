import type { TrafficGrade } from './customer';
import type { StirBadgeFields } from './stir';
import type { Grade, QualityStatus } from '../pages/calls/quality';

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
 * One audio direction of a call (contract C.3). Tenant blocks carry only the
 * base keys; staff blocks add the diagnostics marked "staff only".
 */
export interface LegQuality {
  quality_status: QualityStatus | null;
  quality_grade: Grade | null;
  mos: number | null;
  r_factor: number | null;
  packet_loss_pct: number | null;
  packet_loss_count: number | null;
  jitter_avg_ms: number | null;
  jitter_max_ms: number | null;
  burst_ratio: number | null;
  inbound_media_ratio: number | null;
  /** Staff only — the CDR row this direction came from. */
  uuid?: string;
  /** Staff only. */
  quality_source?: string | null;
  /** Staff only. */
  packets_expected?: number | null;
  /** Staff only. */
  packets_reordered?: number | null;
  /** Staff only. */
  ssrc_changes?: number | null;
  /** Staff only — FS's own MOS for this direction. */
  fs_mos?: number | null;
}

/**
 * `caller_audio` = the A row's inbound RTP (the caller's voice — what the
 * CALLEE heard). `callee_audio` = the answered carrier B row's inbound RTP
 * (what the CALLER heard), or null when there is no B row (on-net, trunk,
 * B not ingested yet).
 */
export interface QualityByDirection {
  caller_audio: LegQuality | null;
  callee_audio: LegQuality | null;
}

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

  // ── Voice quality (migration 50 — docs/CALL_QUALITY_ACCURACY_PLAN.md B.3) ──
  // "Rated-only" = non-NULL only when quality_status === 'rated'. The column
  // NAMES are unchanged from before migration 50; the VALUES are now honest.
  /** How this leg was graded (B.2). Always set by the new API; NULL only on
      rows the old API wrote that the backfill has not reached. */
  quality_status?: QualityStatus | null;
  /** Leg grade (§D): great/good/fair/poor, or NULL when not graded. no_rtp
      (one-way audio) is graded 'poor'; no_media (no audio either way) is NULL. */
  quality_grade?: Grade | null;
  /** ITU-T G.107 E-model MOS from TRUE sequence loss (G.711 ceiling 4.41).
      Rated-only. */
  mos?: number | null;
  /** G.107 transmission rating R (0–100) behind `mos`. Rated-only. */
  r_factor?: number | null;
  /** DEPRECATED — always NULL (the FS raw value moved to `fs_quality_pct`). */
  quality_pct?: number | null;
  /** FS raw flaw counter (includes CNG ticks / autoflush) — traceability only,
      NOT loss. */
  flaw_total?: number | null;

  // Packet loss — TRUE network loss (RFC 3550 A.1 sequence tracking on
  // patched FS; FS lossrate on legacy images). Rated-only.
  /** Lost packets (patched: exact; legacy: estimate). The FS autoflush/CNG
      skip counter this column used to carry is `rtp_audio_in_skip_packet_count`. */
  packet_loss_count?: number | null;
  /** Staff only — FS raw inbound packet total (duration proxy). */
  packet_total_count?: number | null;
  /** Lost ÷ expected × 100. Rated-only. */
  packet_loss_pct?: number | null;
  /** Mean observed burst length ÷ random-loss burst length, [1, 10]. Rated-only. */
  burst_ratio?: number | null;
  /** Forward sequence gaps (loss bursts); patched FS only, any status. */
  loss_bursts?: number | null;
  /** Inbound packets ÷ packets expected from talk time (1.0 ≈ full audio);
      set for rated / no_rtp / no_media / low_sample. */
  inbound_media_ratio?: number | null;

  // Jitter — RFC 3550 §6.4.1 interarrival jitter in ms (patched FS only;
  // legacy images and history are NULL, never fabricated). Rated-only.
  /** DEPRECATED — always NULL. */
  jitter_min_ms?: number | null;
  /** Post-warmup peak J. */
  jitter_max_ms?: number | null;
  /** Per-call mean J. */
  jitter_avg_ms?: number | null;

  // Call-level quality (A rows only; the WORSE of the two audio directions,
  // written server-side by cdr_refresh_call_quality()).
  /** no_rtp if either direction is one-way; rated if either is rated; else
      the A status (may be no_media = no audio either way, not graded). */
  call_quality_status?: QualityStatus | null;
  /** Grade of the worse direction; NULL when neither direction was graded. */
  call_quality_grade?: Grade | null;
  /** Minimum MOS over rated directions; NULL when one-way (no_rtp). */
  call_mos?: number | null;

  // Staff-only quality diagnostics (absent on tenant rows).
  /** 'fs_patch_v1' | 'fs_legacy' | 'backfill_v1' — where the numbers came from. */
  quality_source?: string | null;
  /** FS's own do_mos() MOS (traceability; scores silence as 4.50). */
  fs_mos?: number | null;
  /** FS raw quality percentage (what `quality_pct` used to hold). */
  fs_quality_pct?: number | null;
  /** sqrt(FS in_jitter_max_variance) — the OLD `jitter_max_ms` meaning. */
  fs_jitter_max_std_ms?: number | null;
  /** FS autoflush / CNG skip counter (NOT network loss). */
  rtp_audio_in_skip_packet_count?: number | null;
  /** Packets the sender emitted per RTP sequence numbers (patched FS). */
  packets_expected?: number | null;
  /** Late + duplicate packets (patched FS). */
  packets_reordered?: number | null;
  /** SSRC changes / sequence restarts (patched FS). */
  ssrc_changes?: number | null;
  /** Which direction set the call grade: 'A' caller audio, 'B' callee audio. */
  call_quality_leg?: CdrLeg | null;

  /** GET /cdrs/{uuid} only, A rows (NULL on B rows): quality per audio
      direction (contract C.3). */
  quality_by_direction?: QualityByDirection | null;

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
