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
