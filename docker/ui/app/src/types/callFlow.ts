/**
 * Wire types for the generalized `call_flows` backend (plan §0.1 decision 1).
 * These mirror the FastAPI Pydantic schemas being built in parallel. The
 * editable graph (`flow_graph`) is the `CallFlowDoc` from the flow model.
 */
import type { CallFlowDoc, EntryBinding, ProductKind } from '../flow/model/types';

export type CallFlowStatus = 'draft' | 'published';

/** A persisted call flow row (GET/POST/PUT/publish response). */
export interface CallFlow {
  id: number;
  product: ProductKind;
  name: string;
  customer_id: number | null;
  entry: EntryBinding;
  /** The editable graph — source of truth. */
  flow_graph: CallFlowDoc;
  /** Compiled, product-native artifact (written to the sink on publish). */
  compiled: unknown;
  status: CallFlowStatus;
  version: number;
  /** id of the product-sink row the compiled artifact was written to on publish
   *  (for IVR, the `ivr_flows.id`). Null until published. */
  sink_ref: number | null;
  created_at: string;
  updated_at: string;
}

export interface CallFlowListParams {
  product?: ProductKind;
  customer_id?: number;
}

export interface CallFlowCreate {
  product: ProductKind;
  name: string;
  customer_id?: number;
  entry: EntryBinding;
  flow_graph: CallFlowDoc;
  compiled?: unknown;
}

export interface CallFlowUpdate {
  name?: string;
  entry?: EntryBinding;
  flow_graph: CallFlowDoc;
  compiled?: unknown;
}

export interface CallFlowPublish {
  compiled: unknown;
  /**
   * When the live product config has diverged from what this flow last published,
   * the backend returns HTTP 409 unless this is `true` (an explicit operator
   * confirmation to overwrite the diverging live config). Omitted/false on the
   * first attempt; set to `true` only after the operator confirms.
   */
  overwrite_existing?: boolean;
}

/** One row in a flow's published-version history (newest first). */
export interface FlowVersion {
  version: number;
  published_at: string;
}

/** Full snapshot of a single published version (View/restore source). */
export interface FlowVersionDetail {
  version: number;
  /** The editable graph captured at publish time. */
  flow_graph: CallFlowDoc;
  /** Compiled, product-native artifact captured at publish time. */
  compiled: unknown;
  published_at: string;
}

/* ── Simulate ─────────────────────────────────────────────────────────────── */

/** Request body for `POST /call-flows/{id}/simulate`. */
export interface SimulateRequest {
  /** Test caller ID (E.164). Omitted → backend uses an anonymous caller. */
  caller_id?: string;
  /** ISO-8601 instant to evaluate time-of-day rules against. Omitted → now. */
  now?: string;
}

/** `result` for ivr / api / conference — a compiled TwiML document. */
export interface SimulateTwiml {
  kind: 'twiml';
  xml: string;
}

/**
 * `result` for rcf / trunk — a routing decision. The shape is intentionally
 * loose: rcf carries `matched_rule`/`ring`/`forward_to`/`fallback`, trunk
 * carries `endpoints`/`strategy`/`timeout`. All optional so one renderer covers
 * both without the backend pinning every field.
 */
export interface SimulateRoute {
  kind: 'route';
  matched_rule?: number | null;
  ring?: Record<string, unknown> | null;
  forward_to?: string | null;
  fallback?: Record<string, unknown> | null;
  endpoints?: unknown[] | null;
  strategy?: string | null;
  timeout?: number | null;
}

/** `result` for ucaas — a find-me/follow-me ring plan. */
export interface SimulateRing {
  kind: 'ring';
  strategy: string;
  legs: unknown[];
  fallback: Record<string, unknown>;
}

/**
 * The `result` field. Discriminated on `kind`, but a defensive fallback keeps
 * the UI from crashing if the backend ever returns an unknown shape.
 */
export type SimulateResultBody =
  | SimulateTwiml
  | SimulateRoute
  | SimulateRing
  | { kind?: string; [key: string]: unknown };

/** Response body for `POST /call-flows/{id}/simulate`. */
export interface SimulateResult {
  /** Product the compiled artifact was simulated as (e.g. `rcf`, `ivr`). */
  product: string;
  /** Product-specific decision — see `SimulateResultBody`. */
  result: SimulateResultBody;
  /** Ordered, human-readable explanation of how the decision was reached. */
  trace: string[];
}
