import type { HomerSearchResult } from '../../api/homer';
import type { LadderLayout, LadderMessage, LadderNode, NodeRole } from './sipLadderTypes';
import {
  classifyNodeRole,
  formatMessageLabel,
  getMessageColor,
  isRetransmission,
  LADDER_COLORS,
} from './sipLadderUtils';
import { extractSIPInfo } from './sipUtils';

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * Computes the complete ladder layout from raw Homer messages and correlation data.
 *
 * This is the core layout engine. It:
 * 1. Orders messages — by the API's authoritative `seq` when present, else by
 *    timestamp with a defensive SIP-causality pass (responses never above
 *    their request)
 * 2. Discovers unique nodes from src_ip/dst_ip values
 * 3. Classifies each node's architectural role
 * 4. Orders nodes left-to-right by FIXED platform topology rank
 *    (carrier-in → VIP → SBC → FS → SBC(B) → carrier-out); chronology only
 *    breaks ties
 * 5. Classifies messages by call leg (A vs B)
 * 6. Detects retransmissions and hairpin (SBC self-hop) rows
 * 7. Computes inter-message time deltas
 * 8. Assigns colors and labels
 *
 * @param messages      Raw HomerSearchResult array
 * @param correlations  Map of Call-ID → related Call-IDs (from API)
 */
export function computeLayout(
  messages: ReadonlyArray<HomerSearchResult>,
  correlations: Record<string, string[]>,
): LadderLayout {
  // Handle empty input
  if (messages.length === 0) {
    return {
      nodes: [],
      messages: [],
      aLegCallIds: new Set(),
      bLegCallIds: new Set(),
      callDurationMs: null,
    };
  }

  // Step 1: Order messages. `seq` (when present on every row) is the
  // AUTHORITATIVE display order computed by the API pipeline. Old-format
  // data falls back to timestamp sort + a defensive causality pass.
  const { sorted, causallyMoved } = orderMessages(messages);

  // Step 2: Discover nodes (in display order — first appearance is the tiebreak)
  const nodeNames = discoverNodes(sorted);

  // Step 5 (early): Classify call legs (needed for carrier in/out detection)
  const { aLegCallIds, bLegCallIds } = classifyCallLegs(sorted, correlations);

  // Steps 3+4: Order nodes left-to-right by topology rank. Carrier roles
  // (ingress vs egress) are resolved from call-flow direction BEFORE ranking
  // so timestamp corruption can never push carrier-in right of the media server.
  const orderedNodes = orderNodes(sorted, nodeNames, aLegCallIds, bLegCallIds);

  // Step 4.5: Split nodes that appear in both call legs into virtual A/B-leg columns.
  // This creates a symmetric ladder: BW-ATL | SBC-VIP | SBC-1 (IN) | FS | SBC-1 (OUT) | BW-DAL
  const { finalNodes, bLegColumnIndex } = splitDualLegNodes(
    orderedNodes,
    sorted,
    aLegCallIds,
    bLegCallIds,
  );

  // Build column index lookup (uses the final node list after splitting)
  const columnIndex = new Map<string, number>();
  finalNodes.forEach((node, idx) => {
    columnIndex.set(node.id, idx);
  });

  // Build a host → column index so SIP-semantic fallback can map a parsed
  // request-URI / Via host (which is often a raw IP) back to a ladder column,
  // even though node IDs are heplify aliases. Every physical IP that aliases to
  // a node gets recorded here via the host-discovery pass below.
  const hostColumnIndex = buildHostColumnIndex(sorted, columnIndex, bLegColumnIndex);

  // Index of the FreeSWITCH / B2BUA center column (used to disambiguate which
  // side of the bridge a collapsed message belongs to). -1 if no media server.
  const mediaCol = finalNodes.findIndex((n) => n.role === 'media-server');

  // Steps 5-8: Process each message
  const processedMessages: LadderMessage[] = [];
  const prevMessagesForRetransmit: HomerSearchResult[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const msg = sorted[i]!;

    // Determine call leg
    const leg = determineLeg(msg.callid, aLegCallIds, bLegCallIds);

    // Detect retransmission
    const isRetransmit = isRetransmission(msg, prevMessagesForRetransmit);
    prevMessagesForRetransmit.push(msg);

    const ctx: ResolveContext = {
      columnIndex,
      bLegColumnIndex,
      hostColumnIndex,
      mediaCol,
      nodeCount: finalNodes.length,
    };

    // Hairpin detection: the API marks self-hop / VIP re-traversal copies of
    // in-dialog requests with `hairpin: true`; for old-format data, a row whose
    // wire src and dst collapsed to the SAME node is the fallback signal.
    // Hairpins render as a self-loop glyph on one column — never a spanning
    // arrow — so they bypass directional resolution entirely.
    const isHairpin =
      msg.hairpin === true || (!!msg.src_ip && msg.src_ip === msg.dst_ip);

    // Resolve a true directional arrow for this message. Primary signal is the
    // wire-level HEP src→dst; when that collapses to one column, SIP semantics
    // (request-URI / Via chain) decide the peer and direction. Guarantees that
    // sourceCol !== destCol for non-hairpin rows — no message ever renders as
    // a bare dot.
    const resolved = isHairpin
      ? resolveHairpinColumn(msg, leg, ctx)
      : resolveMessageDirection(msg, leg, ctx);

    // Compute time delta from previous message
    let timeDeltaMs: number | null = null;
    if (i > 0) {
      const prevMsg = sorted[i - 1]!;
      timeDeltaMs = (msg.timestamp_ns - prevMsg.timestamp_ns) / 1_000_000;
    }

    // Assign color (retransmissions get muted)
    const color = isRetransmit ? LADDER_COLORS.retransmission : getMessageColor(msg, leg);

    processedMessages.push({
      id: `${msg.callid}-${msg.timestamp_ns}-${i}`,
      original: msg,
      sourceCol: resolved.sourceCol,
      destCol: resolved.destCol,
      direction: resolved.sourceCol <= resolved.destCol ? 'right' : 'left',
      color,
      label: formatMessageLabel(msg),
      isRetransmission: isRetransmit,
      isHairpin,
      tsCorrected: msg.ts_corrected === true || causallyMoved.has(msg),
      leg,
      timeDeltaMs,
      directionInferred: resolved.inferred,
    });
  }

  // Calculate overall call duration. Display order may be causally corrected,
  // so use min/max timestamps rather than first/last rows.
  let callDurationMs: number | null = null;
  if (sorted.length >= 2) {
    let minTs = Number.POSITIVE_INFINITY;
    let maxTs = Number.NEGATIVE_INFINITY;
    for (const m of sorted) {
      if (m.timestamp_ns < minTs) minTs = m.timestamp_ns;
      if (m.timestamp_ns > maxTs) maxTs = m.timestamp_ns;
    }
    callDurationMs = (maxTs - minTs) / 1_000_000;
  }

  return {
    nodes: finalNodes,
    messages: processedMessages,
    aLegCallIds,
    bLegCallIds,
    callDurationMs,
  };
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/** Result of the message-ordering pass. */
interface OrderedMessages {
  /** Messages in final display order. */
  sorted: HomerSearchResult[];
  /** Rows the client-side causality pass moved (old-format data only). */
  causallyMoved: Set<HomerSearchResult>;
}

/**
 * Orders messages for display.
 *
 * NEW-format data: when EVERY row carries a numeric `seq`, that is the
 * authoritative display order computed by the API pipeline (it has already
 * corrected corrupted capture timestamps for SIP causality) — sort by it.
 *
 * OLD-format data (cached / pre-upgrade responses): sort by timestamp_ns,
 * then run a defensive causality pass so a response never renders above the
 * request it answers (stored timestamps can be 15-20ms late on large packets,
 * which historically put "100 Trying" above its INVITE).
 */
function orderMessages(messages: ReadonlyArray<HomerSearchResult>): OrderedMessages {
  const allHaveSeq = messages.every(
    (m) => typeof m.seq === 'number' && Number.isFinite(m.seq),
  );

  if (allHaveSeq) {
    return {
      sorted: [...messages].sort((a, b) => a.seq! - b.seq!),
      causallyMoved: new Set(),
    };
  }

  const byTimestamp = [...messages].sort((a, b) => a.timestamp_ns - b.timestamp_ns);
  return enforceCausality(byTimestamp);
}

/**
 * SIP transaction key for the causality pass: Call-ID + CSeq. The CSeq value
 * ("102 INVITE") is invariant across proxy hops (RFC 3261 §8.1.1.5), so every
 * hop of one request and all its responses share a key. Falls back to the
 * method label when the API didn't extract a CSeq — degradation is safe (a
 * response with an unmatched key is simply left in timestamp order).
 */
function transactionKey(msg: HomerSearchResult): string {
  const cseq = (msg.cseq ?? '').trim();
  return `${msg.callid}|${cseq || msg.method}`;
}

/**
 * Defensive causality pass for old-format (seq-less) data: within the same
 * Call-ID + CSeq transaction, a response row must never render above its
 * request. Violations are fixed MINIMALLY — the offending response rows are
 * deferred and re-inserted immediately after the transaction's first request,
 * preserving their relative order. Everything else keeps timestamp order.
 */
function enforceCausality(byTimestamp: HomerSearchResult[]): OrderedMessages {
  // Which transactions have a request row at all (responses without one are
  // never moved — there is nothing to anchor them to).
  const hasRequest = new Set<string>();
  for (const m of byTimestamp) {
    if (m.status === null) hasRequest.add(transactionKey(m));
  }

  const out: HomerSearchResult[] = [];
  const causallyMoved = new Set<HomerSearchResult>();
  const seenRequest = new Set<string>();
  const deferred = new Map<string, HomerSearchResult[]>();

  for (const m of byTimestamp) {
    const key = transactionKey(m);

    if (m.status === null) {
      // Request row — emit, then flush any responses that arrived "before" it.
      out.push(m);
      if (!seenRequest.has(key)) {
        seenRequest.add(key);
        const waiting = deferred.get(key);
        if (waiting) {
          for (const w of waiting) {
            out.push(w);
            causallyMoved.add(w);
          }
          deferred.delete(key);
        }
      }
    } else if (seenRequest.has(key) || !hasRequest.has(key)) {
      // Response whose request already rendered (or has no request) — in place.
      out.push(m);
    } else {
      // Response stored BEFORE its request (corrupted timestamp) — defer.
      const waiting = deferred.get(key);
      if (waiting) waiting.push(m);
      else deferred.set(key, [m]);
    }
  }

  // Safety net: flush anything still deferred (cannot happen when hasRequest
  // is consistent, but a silently dropped row is never acceptable).
  for (const waiting of deferred.values()) {
    for (const w of waiting) out.push(w);
  }

  return { sorted: out, causallyMoved };
}

/**
 * Resolves the single column a hairpin (SBC self-hop) row sits on. Hairpins
 * are captured as src == dst (the SBC sending through its own VIP), so there
 * is no arrow to draw — just a self-loop glyph on the most meaningful column:
 *
 *  - B-leg hairpins happen on the egress side of the bridge; anchor them on
 *    the B-leg SBC virtual column when one exists.
 *  - Otherwise anchor on whichever wire endpoint resolves to a column.
 *  - Last resort: the leg-appropriate side of the media server.
 */
function resolveHairpinColumn(
  msg: HomerSearchResult,
  leg: 'a' | 'b' | 'unknown',
  ctx: ResolveContext,
): ResolvedDirection {
  let col: number | undefined;

  if (leg === 'b' && ctx.bLegColumnIndex.size > 0) {
    col = Math.min(...ctx.bLegColumnIndex.values());
  }
  if (col === undefined) {
    col = resolveColumn(msg.src_ip, leg, ctx.columnIndex, ctx.bLegColumnIndex);
  }
  if (col === undefined) {
    col = resolveColumn(msg.dst_ip, leg, ctx.columnIndex, ctx.bLegColumnIndex);
  }
  if (col === undefined) {
    col = fallbackAnchorByLeg(leg, ctx);
  }

  return { sourceCol: col, destCol: col, inferred: false };
}

/**
 * Suffix appended to a physical node ID to create its B-leg virtual node ID.
 * Uses a double-underscore prefix to avoid collisions with real node names.
 */
const BLEG_SUFFIX = '__bleg';

/**
 * Detects nodes that participate in both A-leg and B-leg traffic and splits them
 * into two virtual columns: one for A-leg messages and one for B-leg messages.
 *
 * Only SBC nodes (role='sbc') are candidates for splitting. Carrier nodes are
 * already separate (BW-ATL vs BW-DAL) and FreeSWITCH is the B2BUA bridge that
 * naturally sits in the center.
 *
 * The B-leg virtual node is inserted immediately after FreeSWITCH in the column
 * order, producing the desired symmetric layout:
 *   BW-ATL | SBC-VIP | SBC-1 | FreeSWITCH | SBC-1 | BW-DAL
 *
 * Returns the modified node list and a map from physical node ID to the B-leg
 * virtual column index (used by resolveColumn to route B-leg messages).
 */
function splitDualLegNodes(
  orderedNodes: LadderNode[],
  sorted: ReadonlyArray<HomerSearchResult>,
  aLegCallIds: Set<string>,
  bLegCallIds: Set<string>,
): { finalNodes: LadderNode[]; bLegColumnIndex: Map<string, number> } {
  // Collect which physical node IDs appear in each leg
  const aLegNodeIds = new Set<string>();
  const bLegNodeIds = new Set<string>();

  for (const msg of sorted) {
    if (aLegCallIds.has(msg.callid)) {
      aLegNodeIds.add(msg.src_ip);
      aLegNodeIds.add(msg.dst_ip);
    } else if (bLegCallIds.has(msg.callid)) {
      bLegNodeIds.add(msg.src_ip);
      bLegNodeIds.add(msg.dst_ip);
    }
  }

  // Determine the media-server pivot up front — split eligibility for un-aliased
  // (unknown-role) nodes is positional, so we need to know where the B2BUA sits.
  const mediaPivotIdx = orderedNodes.findIndex((n) => n.role === 'media-server');

  // Find nodes that appear in both legs AND are eligible for splitting.
  //
  // Primary case: role === 'sbc'. A Kamailio instance bridges both legs and must
  // appear as a left (A-leg, ingress) column AND a right (B-leg, egress) column.
  //
  // Defensive case (graceful degradation): a node whose role is 'unknown' — e.g. a
  // raw-IP fallback for an SBC that heplify has not aliased yet — that ALSO appears
  // in both legs AND sits strictly to the LEFT of the media server. Such a node is
  // structurally an in-path proxy and must split the same way, otherwise its B-leg
  // messages collapse onto its A-leg column and render as wrong-column arrows. We
  // restrict to the left-of-media position so a stray dual-leg carrier/services node
  // (which sits at an edge, not between carrier and FS) is never mis-split.
  const nodesToSplit = new Set<string>();
  orderedNodes.forEach((node, idx) => {
    const inBothLegs = aLegNodeIds.has(node.id) && bLegNodeIds.has(node.id);
    if (!inBothLegs) return;

    if (node.role === 'sbc') {
      nodesToSplit.add(node.id);
      return;
    }

    // Defensive: un-aliased in-path proxy left of the B2BUA center.
    if (node.role === 'unknown' && mediaPivotIdx >= 0 && idx < mediaPivotIdx) {
      nodesToSplit.add(node.id);
    }
  });

  // If nothing to split, return the original list unchanged
  if (nodesToSplit.size === 0) {
    return { finalNodes: orderedNodes, bLegColumnIndex: new Map() };
  }

  // Tag the physical (left/ingress) half of every split node as the A-leg
  // column so the header renders "SBC · A-LEG" vs the clone's "SBC · B-LEG".
  for (const node of orderedNodes) {
    if (nodesToSplit.has(node.id)) {
      node.legTag = 'a';
    }
  }

  // Index of the FreeSWITCH / media-server node (the B2BUA center point).
  // B-leg virtual nodes go after this node. Reuses the pivot found above.
  const mediaIdx = mediaPivotIdx;

  // Build the new node list: A-leg nodes stay in their original positions (left of
  // or at FreeSWITCH), B-leg virtual clones are inserted to the right of FreeSWITCH.
  const finalNodes: LadderNode[] = [];
  const bLegVirtualNodes: LadderNode[] = [];

  for (const node of orderedNodes) {
    finalNodes.push(node);

    // After the media-server node, insert all B-leg virtual nodes.
    // We collect them first from the nodes-to-split set, preserving their original
    // order (which is the order they appear in the A-leg chain).
    if (node.role === 'media-server') {
      // Create B-leg virtual clones for each split node
      for (const origNode of orderedNodes) {
        if (nodesToSplit.has(origNode.id)) {
          bLegVirtualNodes.push({
            id: origNode.id + BLEG_SUFFIX,
            displayLabel: origNode.id,
            role: origNode.role,
            columnIndex: -1, // will be reassigned below
            legTag: 'b',
          });
        }
      }
      // Insert in reverse order of the A-leg chain so they mirror correctly.
      // In the A-leg chain: ... SBC-VIP | SBC-1 | FS
      // In the B-leg chain: FS | SBC-1 | ... (mirrors right)
      for (const vNode of bLegVirtualNodes) {
        finalNodes.push(vNode);
      }
    }
  }

  // If there was no media-server node (unusual), append virtual nodes at the end
  if (mediaIdx === -1) {
    for (const origNode of orderedNodes) {
      if (nodesToSplit.has(origNode.id)) {
        finalNodes.push({
          id: origNode.id + BLEG_SUFFIX,
          displayLabel: origNode.id,
          role: origNode.role,
          columnIndex: -1,
          legTag: 'b',
        });
      }
    }
  }

  // Reassign column indices
  const bLegColumnIdx = new Map<string, number>();
  for (let i = 0; i < finalNodes.length; i++) {
    finalNodes[i]!.columnIndex = i;
    // Track mapping from physical ID to B-leg virtual column index
    const node = finalNodes[i]!;
    if (node.id.endsWith(BLEG_SUFFIX)) {
      const physicalId = node.id.slice(0, -BLEG_SUFFIX.length);
      bLegColumnIdx.set(physicalId, i);
    }
  }

  return { finalNodes, bLegColumnIndex: bLegColumnIdx };
}

/**
 * Resolves the column index for a physical node ID (heplify alias), taking into
 * account whether the message is A-leg or B-leg. For B-leg messages involving a
 * split node, returns the B-leg virtual column index instead of the A-leg column.
 *
 * Returns `undefined` when the node ID is not in the column index. Callers MUST
 * NOT silently fall back to column 0 — an unknown node is a discovery bug to be
 * surfaced (every src/dst is added by discoverNodes + placed by orderNodes, so a
 * miss here should never happen in practice).
 */
function resolveColumn(
  physicalId: string,
  leg: 'a' | 'b' | 'unknown',
  columnIndex: Map<string, number>,
  bLegColumnIndex: Map<string, number>,
): number | undefined {
  // For B-leg messages, check if this node has been split
  if (leg === 'b') {
    const bLegCol = bLegColumnIndex.get(physicalId);
    if (bLegCol !== undefined) {
      return bLegCol;
    }
  }
  // Fall back to the standard (A-leg / unsplit) column
  return columnIndex.get(physicalId);
}

/** Dev-only warning helper — surfaces resolution gaps without spamming prod. */
function devWarn(message: string): void {
  if (import.meta.env?.DEV) {
    console.warn(`[SipLadder] ${message}`);
  }
}

/**
 * Context passed to the direction resolver — all column lookups it needs.
 */
interface ResolveContext {
  /** Node ID (alias) → column index (post-split). */
  columnIndex: Map<string, number>;
  /** Physical node ID → B-leg virtual column index. */
  bLegColumnIndex: Map<string, number>;
  /** SIP host (IP or alias, lowercased) → column index, per leg-resolved pass. */
  hostColumnIndex: HostColumnIndex;
  /** Column index of the FreeSWITCH / B2BUA center node, or -1. */
  mediaCol: number;
  /** Total number of columns. */
  nodeCount: number;
}

/** Result of resolving a single message to a directional arrow. */
interface ResolvedDirection {
  sourceCol: number;
  destCol: number;
  /** True when direction came from SIP semantics rather than distinct HEP cols. */
  inferred: boolean;
}

/**
 * Maps a SIP host (request-URI host, Via host, Contact host) to a ladder column.
 * Because node IDs are heplify aliases (not IPs), we record every physical IP
 * seen on the wire against the column its alias occupies. The same physical IP
 * can map to different columns on A-leg vs B-leg (a split SBC), so we keep a
 * per-leg view plus a leg-agnostic fallback.
 */
interface HostColumnIndex {
  aLeg: Map<string, number>;
  bLeg: Map<string, number>;
  any: Map<string, number>;
}

/**
 * Builds the host → column index. This pass cannot know the *physical IP* behind
 * each alias (heplify already collapsed them), so it records the alias strings
 * themselves (lowercased) as host keys. The SIP-semantic fallback additionally
 * matches parsed hosts against these alias keys and against any literal IP that
 * happens to equal a node ID. It is intentionally best-effort: its only job is to
 * give the fallback a sensible peer column when one exists.
 */
function buildHostColumnIndex(
  sorted: ReadonlyArray<HomerSearchResult>,
  columnIndex: Map<string, number>,
  bLegColumnIndex: Map<string, number>,
): HostColumnIndex {
  const aLeg = new Map<string, number>();
  const bLeg = new Map<string, number>();
  const any = new Map<string, number>();

  const record = (hostKey: string, col: number, leg: 'a' | 'b') => {
    const key = hostKey.toLowerCase();
    if (leg === 'b') bLeg.set(key, col);
    else aLeg.set(key, col);
    if (!any.has(key)) any.set(key, col);
  };

  for (const node of columnIndex.keys()) {
    // node here is an alias; record it as a host key against its A-leg column
    const col = columnIndex.get(node)!;
    record(node, col, 'a');
  }
  for (const [physicalId, col] of bLegColumnIndex.entries()) {
    record(physicalId, col, 'b');
  }

  // Also record any raw src/dst values (covers cases where the "alias" is the
  // literal IP, e.g. West nodes that heplify hasn't aliased yet → "UNKNOWN").
  for (const msg of sorted) {
    const sCol = columnIndex.get(msg.src_ip);
    if (sCol !== undefined) record(msg.src_ip, sCol, 'a');
    const dCol = columnIndex.get(msg.dst_ip);
    if (dCol !== undefined) record(msg.dst_ip, dCol, 'a');
  }

  return { aLeg, bLeg, any };
}

/**
 * Looks up a SIP host string against the host→column index for a given leg,
 * falling back to the leg-agnostic map.
 */
function lookupHostColumn(
  host: string,
  leg: 'a' | 'b' | 'unknown',
  hostColumnIndex: HostColumnIndex,
): number | undefined {
  if (!host) return undefined;
  const key = host.toLowerCase();
  if (leg === 'b') {
    const b = hostColumnIndex.bLeg.get(key);
    if (b !== undefined) return b;
  } else {
    const a = hostColumnIndex.aLeg.get(key);
    if (a !== undefined) return a;
  }
  return hostColumnIndex.any.get(key);
}

/**
 * Resolves a message to a guaranteed-directional arrow.
 *
 * Algorithm (carrier-grade, HEP-primary + SIP-semantic fallback):
 *
 *  1. PRIMARY — wire-level HEP src→dst. Resolve both endpoints to columns. If
 *     they are two DISTINCT columns, that IS the arrow. Done. (~all packets.)
 *
 *  2. COLLAPSE — src and dst aliased to the SAME column (heplify intentionally
 *     collapsed a node's two physical faces, e.g. SBC-1 public↔internal for an
 *     in-dialog BYE). Fall back to SIP semantics from raw_msg:
 *       • REQUEST  → peer = request-URI host (or topmost Route host). The arrow
 *                    points FROM the collapsed node TOWARD the peer's column.
 *       • RESPONSE → travels up the Via chain; peer = host in the Via *below*
 *                    the responder's own topmost Via. Arrow points toward it.
 *     CSeq method + From/To tags + leg corroborate which side of FreeSWITCH the
 *     message sits on.
 *
 *  3. LAST RESORT — still ambiguous (no raw_msg, no resolvable peer). Draw to the
 *     nearest sensible adjacent column based on leg/role so the arrow is never a
 *     bare dot, and flag it `inferred` + dev-warn. Vanishingly rare.
 */
function resolveMessageDirection(
  msg: HomerSearchResult,
  leg: 'a' | 'b' | 'unknown',
  ctx: ResolveContext,
): ResolvedDirection {
  const srcCol = resolveColumn(msg.src_ip, leg, ctx.columnIndex, ctx.bLegColumnIndex);
  const dstCol = resolveColumn(msg.dst_ip, leg, ctx.columnIndex, ctx.bLegColumnIndex);

  // ── Step 1: PRIMARY — distinct wire columns ──
  if (srcCol !== undefined && dstCol !== undefined && srcCol !== dstCol) {
    return { sourceCol: srcCol, destCol: dstCol, inferred: false };
  }

  // Determine the "anchor" column — the collapsed node we are sure of. Prefer a
  // resolved wire column; if both are missing surface a discovery bug.
  let anchorCol = srcCol !== undefined ? srcCol : dstCol;
  if (anchorCol === undefined) {
    devWarn(
      `message ${msg.method || msg.status} callid=${msg.callid} has unresolved ` +
        `src="${msg.src_ip}" dst="${msg.dst_ip}" — neither maps to a column. ` +
        `Discovery bug. Falling back to leg-based placement.`,
    );
    anchorCol = fallbackAnchorByLeg(leg, ctx);
  }

  // ── Step 2: SIP-semantic fallback ──
  const peer = resolvePeerColumnFromSip(msg, leg, anchorCol, ctx);
  if (peer !== undefined && peer !== anchorCol) {
    // Orient: for a request the anchor is the SENDER (source); for a response the
    // anchor is the RESPONDER (source). In both cases the resolved peer is the
    // DESTINATION. So source = anchor, dest = peer.
    return { sourceCol: anchorCol, destCol: peer, inferred: true };
  }

  // ── Step 3: LAST RESORT — adjacent column, never a dot ──
  const adjacent = nearestAdjacentColumn(anchorCol, leg, ctx);
  devWarn(
    `message ${msg.method || msg.status} callid=${msg.callid} src="${msg.src_ip}" ` +
      `dst="${msg.dst_ip}" collapsed to column ${anchorCol} and SIP semantics could ` +
      `not resolve a distinct peer — drawing inferred arrow to column ${adjacent}.`,
  );
  return { sourceCol: anchorCol, destCol: adjacent, inferred: true };
}

/**
 * Picks a fallback anchor column when the wire src/dst don't resolve at all.
 * A-leg messages anchor toward the left (ingress) half; B-leg toward the right.
 */
function fallbackAnchorByLeg(leg: 'a' | 'b' | 'unknown', ctx: ResolveContext): number {
  if (ctx.mediaCol >= 0) {
    if (leg === 'b') return Math.min(ctx.mediaCol + 1, ctx.nodeCount - 1);
    return Math.max(ctx.mediaCol - 1, 0);
  }
  return leg === 'b' ? ctx.nodeCount - 1 : 0;
}

/**
 * Uses parsed SIP semantics to find the column of the message's true peer (the
 * node on the other end of this hop), given the anchor (collapsed) column.
 *
 * For requests: the peer is the next hop — the request-URI host, or the topmost
 * Route header host if loose-routing. For responses: the peer is the node the
 * response is travelling back toward — the host carried in the Via stack beneath
 * the responder's own topmost Via.
 *
 * Returns the resolved column, or undefined if it can't be determined or maps
 * back onto the anchor.
 */
function resolvePeerColumnFromSip(
  msg: HomerSearchResult,
  leg: 'a' | 'b' | 'unknown',
  anchorCol: number,
  ctx: ResolveContext,
): number | undefined {
  const raw = msg.raw_msg;
  if (!raw) return undefined;

  let info;
  try {
    info = extractSIPInfo(raw);
  } catch {
    return undefined;
  }

  const candidateHosts: string[] = [];

  if (info.isRequest || msg.status === null) {
    // REQUEST: next hop is the topmost Route (loose routing) then request-URI.
    if (info.routes.length > 0 && info.routes[0]!.host) {
      candidateHosts.push(info.routes[0]!.host);
    }
    if (info.requestUri) {
      const { host } = splitUriHost(info.requestUri);
      if (host) candidateHosts.push(host);
    }
    // Contact can name the far end for dialog-forming/in-dialog requests.
    if (info.contact?.host) candidateHosts.push(info.contact.host);
  } else {
    // RESPONSE: travels up the Via chain. The topmost Via is the responder's
    // immediate upstream sender — that is exactly who the response goes back to.
    // vias[0] is topmost. Its host is the peer we send the response to.
    for (const via of info.vias) {
      const host = via.received || via.host;
      if (host) candidateHosts.push(host);
    }
  }

  for (const host of candidateHosts) {
    const col = lookupHostColumn(host, leg, ctx.hostColumnIndex);
    if (col !== undefined && col !== anchorCol) {
      return col;
    }
  }

  // Could not map any SIP host to a distinct column. As a semantic tiebreaker,
  // use the B2BUA topology: a collapsed message on a request whose CSeq is BYE/
  // ACK/INVITE still has a real peer — bias toward the center (FreeSWITCH) for
  // A-leg nodes and away from center for B-leg, which is the physically correct
  // next hop in the RCF ladder.
  return undefined;
}

/**
 * Splits a SIP URI into host (and ignores the rest). Thin wrapper that reuses the
 * URI shape produced by sipUtils — kept local to avoid exporting parser internals.
 */
function splitUriHost(uri: string): { host: string } {
  let cleaned = uri.replace(/^sips?:/i, '').replace(/^tel:/i, '');
  const atIdx = cleaned.indexOf('@');
  if (atIdx >= 0) cleaned = cleaned.slice(atIdx + 1);
  const semiIdx = cleaned.indexOf(';');
  if (semiIdx >= 0) cleaned = cleaned.slice(0, semiIdx);
  // Strip :port
  if (cleaned.startsWith('[')) {
    const end = cleaned.indexOf(']');
    if (end >= 0) return { host: cleaned.slice(1, end) };
  }
  const colonIdx = cleaned.lastIndexOf(':');
  if (colonIdx >= 0 && /^\d+$/.test(cleaned.slice(colonIdx + 1))) {
    cleaned = cleaned.slice(0, colonIdx);
  }
  return { host: cleaned.trim() };
}

/**
 * Picks the nearest sensible adjacent column to the anchor so a collapsed message
 * still renders a real arrow. Uses the B2BUA center as the orientation pivot:
 *  - A-leg / unknown nodes lean toward FreeSWITCH (the call's forward direction).
 *  - B-leg nodes lean away from FreeSWITCH (toward carrier-egress).
 * Always returns a column != anchor when more than one column exists.
 */
function nearestAdjacentColumn(
  anchorCol: number,
  leg: 'a' | 'b' | 'unknown',
  ctx: ResolveContext,
): number {
  const last = ctx.nodeCount - 1;
  if (last <= 0) return anchorCol; // single column — degenerate, nothing to do

  const pivot = ctx.mediaCol >= 0 ? ctx.mediaCol : Math.floor(ctx.nodeCount / 2);

  // Decide a direction of travel.
  //  - B-leg lives to the right of the B2BUA; its forward travel is rightward
  //    (FS → SBC(B) → carrier-egress), so always lean right unless already last.
  //  - A-leg / unknown forward travel is rightward up to FS, then there's nowhere
  //    further on the A side, so lean toward the pivot.
  const towardRight = leg === 'b' ? true : anchorCol < pivot;

  // Clamp to a real neighbouring column.
  if (towardRight && anchorCol < last) return anchorCol + 1;
  if (!towardRight && anchorCol > 0) return anchorCol - 1;
  // At an edge — go the only way available.
  return anchorCol < last ? anchorCol + 1 : anchorCol - 1;
}

/**
 * Collects all unique node names (src_ip and dst_ip values) from the message list.
 * Preserves discovery order for stable iteration.
 */
function discoverNodes(sorted: ReadonlyArray<HomerSearchResult>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const msg of sorted) {
    if (!seen.has(msg.src_ip)) {
      seen.add(msg.src_ip);
      result.push(msg.src_ip);
    }
    if (!seen.has(msg.dst_ip)) {
      seen.add(msg.dst_ip);
      result.push(msg.dst_ip);
    }
  }

  return result;
}

/**
 * Fixed topology rank for each architectural role. The platform topology is
 * KNOWN and constant: carrier-in → SBC-VIP (NLB) → SBC (A-leg) → FreeSWITCH →
 * SBC (B-leg, inserted by the dual-leg split) → carrier-out. Columns are
 * ordered by this rank FIRST; chronology (first appearance) only breaks ties
 * between nodes of the same rank (e.g. two carrier-in edge proxies).
 *
 * This makes column order immune to capture-timestamp corruption: a late
 * stored timestamp on the carrier INVITE can no longer push the carrier-in
 * or VIP columns right of the media server.
 */
const TOPOLOGY_RANK: Record<NodeRole, number> = {
  'carrier-ingress': 0,
  'sbc-vip': 1,
  sbc: 2,
  'media-server': 3,
  // B-leg SBC virtual columns are inserted between media-server and
  // carrier-egress by splitDualLegNodes (rank-driven placement).
  'carrier-egress': 4,
  unknown: 99, // adjacency-placed, never rank-sorted
};

/**
 * Orders nodes left-to-right — topology-first.
 *
 * Algorithm:
 * 1. Classify every node's role from its heplify alias (zone-aware substring
 *    matching handles West/Central prefixes).
 * 2. Resolve carrier in/out from CALL FLOW, not timestamps: a carrier that
 *    sources an A-leg INVITE is ingress; one that receives a B-leg INVITE
 *    (or appears only in B-leg traffic) is egress.
 * 3. Sort known-role nodes by TOPOLOGY_RANK; chronological first appearance
 *    breaks ties within a rank.
 * 4. Insert unknown/un-aliased nodes (raw IPs) by first-appearance adjacency:
 *    next to the peer of their first directional message — before the peer
 *    when the unknown node was the sender (upstream), after it otherwise.
 */
function orderNodes(
  sorted: ReadonlyArray<HomerSearchResult>,
  allNodeNames: ReadonlyArray<string>,
  aLegCallIds: Set<string>,
  bLegCallIds: Set<string>,
): LadderNode[] {
  // Step 1: base role classification
  const roleById = new Map<string, NodeRole>();
  for (const name of allNodeNames) {
    roleById.set(name, classifyNodeRole(name));
  }

  // Step 2: carrier in/out from call-flow direction
  const aLegInviteSrcs = new Set<string>();
  const bLegInviteDsts = new Set<string>();
  const aLegNodes = new Set<string>();
  const bLegNodes = new Set<string>();
  for (const msg of sorted) {
    const isInviteReq = msg.method === 'INVITE' && msg.status === null;
    if (aLegCallIds.has(msg.callid)) {
      aLegNodes.add(msg.src_ip);
      aLegNodes.add(msg.dst_ip);
      if (isInviteReq) aLegInviteSrcs.add(msg.src_ip);
    } else if (bLegCallIds.has(msg.callid)) {
      bLegNodes.add(msg.src_ip);
      bLegNodes.add(msg.dst_ip);
      if (isInviteReq) bLegInviteDsts.add(msg.dst_ip);
    }
  }

  for (const name of allNodeNames) {
    if (!isCarrierRole(roleById.get(name)!)) continue;
    // Precedence: sourcing an A-leg INVITE is the strongest ingress signal
    // (the same Bandwidth edge can appear on both legs — ingress wins, as
    // the previous role-refinement pass also did).
    if (aLegInviteSrcs.has(name) || aLegNodes.has(name)) {
      roleById.set(name, 'carrier-ingress');
    } else if (bLegInviteDsts.has(name) || bLegNodes.has(name)) {
      roleById.set(name, 'carrier-egress');
    }
    // Neither leg (unclassified traffic only): keep the default ingress.
  }

  // Step 3: rank-sort known-role nodes; first appearance breaks ties
  const firstAppearance = new Map<string, number>();
  allNodeNames.forEach((name, idx) => firstAppearance.set(name, idx));

  const ordered: string[] = allNodeNames
    .filter((name) => roleById.get(name) !== 'unknown')
    .sort((a, b) => {
      const rankDiff = TOPOLOGY_RANK[roleById.get(a)!] - TOPOLOGY_RANK[roleById.get(b)!];
      if (rankDiff !== 0) return rankDiff;
      return firstAppearance.get(a)! - firstAppearance.get(b)!;
    });

  // Step 4: adjacency-place unknown nodes (raw IPs heplify hasn't aliased)
  const pending = allNodeNames.filter((name) => roleById.get(name) === 'unknown');
  let progress = true;
  while (progress && pending.length > 0) {
    progress = false;
    for (let i = 0; i < pending.length; i++) {
      const id = pending[i]!;
      // First directional message involving this node tells us its neighbour.
      const firstMsg =
        sorted.find(
          (m) => (m.src_ip === id || m.dst_ip === id) && m.src_ip !== m.dst_ip,
        ) ?? sorted.find((m) => m.src_ip === id || m.dst_ip === id);
      if (!firstMsg) continue;

      const peer = firstMsg.src_ip === id ? firstMsg.dst_ip : firstMsg.src_ip;
      const peerIdx = ordered.indexOf(peer);
      if (peerIdx === -1) continue; // peer not placed yet — retry next round

      // Sender sits upstream (left) of its receiver.
      const insertAt = firstMsg.src_ip === id ? peerIdx : peerIdx + 1;
      ordered.splice(insertAt, 0, id);
      pending.splice(i, 1);
      progress = true;
      break;
    }
  }
  // Anything still unplaced (isolated self-traffic, peerless) goes at the end.
  for (const id of pending) ordered.push(id);

  // Build LadderNode objects with column indices
  return ordered.map((id, columnIndex) => ({
    id,
    role: roleById.get(id)!,
    columnIndex,
  }));
}

/**
 * Scores an INVITE request as a candidate for the PRIMARY (A-leg) INVITE.
 * Lower is better. The A-leg always enters the platform from the carrier /
 * load-balancer side, while the B-leg is originated by the FreeSWITCH B2BUA —
 * so the source node's role is a far stronger signal than its (possibly
 * corrupted) capture timestamp.
 */
function primaryInviteScore(msg: HomerSearchResult): number {
  const role = classifyNodeRole(msg.src_ip);
  if (role === 'carrier-ingress' || role === 'carrier-egress') return 0; // carrier-sourced
  if (role === 'sbc-vip') return 1;
  if (role === 'media-server') return 3; // B2BUA-originated = B-leg
  return 2; // sbc / unknown
}

/**
 * Classifies Call-IDs into A-leg and B-leg sets using the correlation map.
 *
 * The primary (A-leg) Call-ID comes from the best A-leg INVITE candidate:
 * topology-scored first (carrier-sourced beats VIP beats SBC beats B2BUA),
 * display order breaking ties — NOT raw chronology alone, which inherits
 * corrupted capture timestamps. Any Call-IDs correlated to it (via the
 * correlations map) are B-leg. Call-IDs not in any correlation group remain
 * classified by position: if they share src/dst with the A-leg Call-ID's
 * messages, they're A-leg.
 */
function classifyCallLegs(
  sorted: ReadonlyArray<HomerSearchResult>,
  correlations: Record<string, string[]>,
): { aLegCallIds: Set<string>; bLegCallIds: Set<string> } {
  const aLegCallIds = new Set<string>();
  const bLegCallIds = new Set<string>();

  // Find the best primary-INVITE candidate (topology score, then order)
  let firstInvite: HomerSearchResult | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const m of sorted) {
    if (m.method !== 'INVITE' || m.status !== null) continue;
    const score = primaryInviteScore(m);
    if (score < bestScore) {
      bestScore = score;
      firstInvite = m;
      if (score === 0) break; // carrier-sourced — cannot do better
    }
  }

  if (!firstInvite) {
    // No INVITE found — treat all messages as unknown (put first callid in A-leg)
    if (sorted.length > 0) {
      aLegCallIds.add(sorted[0]!.callid);
    }
    return { aLegCallIds, bLegCallIds };
  }

  const primaryCallId = firstInvite.callid;
  aLegCallIds.add(primaryCallId);

  // Check correlations: any Call-ID correlated to the primary is B-leg
  // The correlations map is bidirectional — check both directions
  const allCorrelatedIds = new Set<string>();

  for (const [key, values] of Object.entries(correlations)) {
    if (key === primaryCallId || values.includes(primaryCallId)) {
      // This correlation group contains our primary Call-ID
      allCorrelatedIds.add(key);
      for (const v of values) {
        allCorrelatedIds.add(v);
      }
    }
  }

  // Everything in the correlation group that isn't the primary is B-leg
  for (const id of allCorrelatedIds) {
    if (id !== primaryCallId) {
      bLegCallIds.add(id);
    }
  }

  // Handle Call-IDs not in any correlation group
  const allCallIds = new Set(sorted.map((m) => m.callid));
  for (const callId of allCallIds) {
    if (!aLegCallIds.has(callId) && !bLegCallIds.has(callId)) {
      // Heuristic: if this Call-ID's first INVITE has the same src_ip as
      // the primary INVITE, it's likely A-leg; otherwise B-leg
      const itsFirstInvite = sorted.find(
        (m) => m.callid === callId && m.method === 'INVITE' && m.status === null,
      );
      if (itsFirstInvite && itsFirstInvite.src_ip === firstInvite.src_ip) {
        aLegCallIds.add(callId);
      } else {
        bLegCallIds.add(callId);
      }
    }
  }

  return { aLegCallIds, bLegCallIds };
}

/**
 * Type guard for carrier roles.
 */
function isCarrierRole(role: NodeRole): boolean {
  return role === 'carrier-ingress' || role === 'carrier-egress';
}

/**
 * Determines which call leg a message belongs to based on its Call-ID.
 */
function determineLeg(
  callId: string,
  aLegCallIds: Set<string>,
  bLegCallIds: Set<string>,
): 'a' | 'b' | 'unknown' {
  if (aLegCallIds.has(callId)) return 'a';
  if (bLegCallIds.has(callId)) return 'b';
  return 'unknown';
}
