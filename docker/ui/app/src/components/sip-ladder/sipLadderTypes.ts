import type { HomerSearchResult } from '../../api/homer';

// ─── Node classification ────────────────────────────────────────────────────

/**
 * Architectural role of a SIP endpoint in the call path.
 * Derived from the aliased name provided by heplify-server.
 */
export type NodeRole =
  | 'carrier-ingress'
  | 'sbc-vip'
  | 'sbc'
  | 'media-server'
  | 'carrier-egress'
  | 'unknown';

/**
 * A node (vertical column) in the ladder diagram.
 * Each unique src_ip / dst_ip value becomes one node.
 * Names are pre-aliased by heplify-server — no IP resolution needed.
 */
export interface LadderNode {
  /** The aliased name: "BW-NY", "SBC-1", "FreeSWITCH", etc.
   *  For virtual (split) nodes, this is a unique internal ID like "SBC-1__bleg". */
  id: string;
  /** Display label for the column header. Falls back to `id` when not set.
   *  Virtual nodes use this to show the original name (e.g. "SBC-1") in the header. */
  displayLabel?: string;
  /** Detected architectural role based on name patterns */
  role: NodeRole;
  /** Position in the diagram, left-to-right (0-based) */
  columnIndex: number;
  /**
   * Set on SBC columns that were split into A-leg / B-leg virtual columns.
   * Drives the distinct "SBC · A-LEG" / "SBC · B-LEG" header sublabels so the
   * two SBC columns are never visually ambiguous. Unset for unsplit nodes.
   */
  legTag?: 'a' | 'b';
}

// ─── Processed message ──────────────────────────────────────────────────────

/**
 * A SIP message that has been processed for rendering in the ladder.
 * Contains all computed layout properties needed by the visual component.
 */
export interface LadderMessage {
  /** Unique identifier for React key */
  id: string;
  /** The original unprocessed HomerSearchResult */
  original: HomerSearchResult;
  /** Source column index (maps to LadderNode.columnIndex) */
  sourceCol: number;
  /** Destination column index (maps to LadderNode.columnIndex) */
  destCol: number;
  /** Arrow direction based on column positions */
  direction: 'right' | 'left';
  /** CSS color for the arrow and label */
  color: string;
  /** Display label: "INVITE", "200 OK", "183 Session Progress", etc. */
  label: string;
  /** Whether this message is an RFC 3261 retransmission */
  isRetransmission: boolean;
  /**
   * SBC internal hop: a self-hop / re-traversal copy of an in-dialog request
   * through the SBC's own VIP (API `hairpin` flag, or src === dst fallback).
   * Rendered as a self-loop glyph on the SBC column, hidden by default.
   */
  isHairpin: boolean;
  /**
   * True when this row's display position was adjusted for SIP causality —
   * either flagged by the API (`ts_corrected`) or moved by the client-side
   * defensive causality pass on old-format (seq-less) data. The timestamp
   * gutter shows a tilde so engineers know the position is derived.
   */
  tsCorrected: boolean;
  /** Which call leg this message belongs to */
  leg: 'a' | 'b' | 'unknown';
  /** Milliseconds elapsed since the previous message (null for the first message) */
  timeDeltaMs: number | null;
  /**
   * True when the wire-level HEP src/dst collapsed to a single column (or were
   * otherwise ambiguous) and the arrow direction had to be inferred from SIP
   * semantics (request-URI / Via chain) rather than read directly off the wire.
   * The row renders these with a subtle "inferred" marker so operators know the
   * direction is derived, not captured. A message is NEVER rendered as a bare dot.
   */
  directionInferred: boolean;
}

// ─── Complete layout ────────────────────────────────────────────────────────

/**
 * Complete layout data for rendering the SIP ladder diagram.
 * Produced by computeLayout() — consumed by the React component.
 */
export interface LadderLayout {
  /** Ordered columns (left-to-right) representing SIP endpoints */
  nodes: LadderNode[];
  /** Processed messages in chronological order */
  messages: LadderMessage[];
  /** Set of Call-IDs belonging to the A-leg (inbound) */
  aLegCallIds: Set<string>;
  /** Set of Call-IDs belonging to the B-leg (outbound) */
  bLegCallIds: Set<string>;
  /** Overall call duration in milliseconds (first to last message), null if < 2 messages */
  callDurationMs: number | null;
}
