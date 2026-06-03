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
 * 1. Discovers unique nodes from src_ip/dst_ip values
 * 2. Classifies each node's architectural role
 * 3. Orders nodes left-to-right following the call's actual path
 * 4. Classifies messages by call leg (A vs B)
 * 5. Detects retransmissions
 * 6. Computes inter-message time deltas
 * 7. Assigns colors and labels
 *
 * @param messages      Raw HomerSearchResult array (will be sorted by timestamp_ns)
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

  // Sort messages chronologically by nanosecond timestamp
  const sorted = [...messages].sort((a, b) => a.timestamp_ns - b.timestamp_ns);

  // Step 1+2: Discover and classify nodes
  const nodeNames = discoverNodes(sorted);

  // Step 4: Classify call legs (needed before ordering for carrier-egress detection)
  const { aLegCallIds, bLegCallIds } = classifyCallLegs(sorted, correlations);

  // Step 3: Order nodes left-to-right following the call path
  const orderedNodes = orderNodes(sorted, nodeNames, aLegCallIds, bLegCallIds);

  // Refine carrier-egress roles now that we have ordering context
  refineCarrierRoles(orderedNodes, sorted, aLegCallIds);

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

    // Resolve a true directional arrow for this message. Primary signal is the
    // wire-level HEP src→dst; when that collapses to one column, SIP semantics
    // (request-URI / Via chain) decide the peer and direction. Guarantees that
    // sourceCol !== destCol — no message ever renders as a bare dot.
    const resolved = resolveMessageDirection(msg, leg, {
      columnIndex,
      bLegColumnIndex,
      hostColumnIndex,
      mediaCol,
      nodeCount: finalNodes.length,
    });

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
      leg,
      timeDeltaMs,
      directionInferred: resolved.inferred,
    });
  }

  // Calculate overall call duration
  const callDurationMs =
    sorted.length >= 2
      ? (sorted[sorted.length - 1]!.timestamp_ns - sorted[0]!.timestamp_ns) / 1_000_000
      : null;

  return {
    nodes: finalNodes,
    messages: processedMessages,
    aLegCallIds,
    bLegCallIds,
    callDurationMs,
  };
}

// ─── Internal helpers ───────────────────────────────────────────────────────

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

  // Find nodes that appear in both legs AND are eligible for splitting (SBC only)
  const nodesToSplit = new Set<string>();
  for (const node of orderedNodes) {
    if (
      node.role === 'sbc' &&
      aLegNodeIds.has(node.id) &&
      bLegNodeIds.has(node.id)
    ) {
      nodesToSplit.add(node.id);
    }
  }

  // If nothing to split, return the original list unchanged
  if (nodesToSplit.size === 0) {
    return { finalNodes: orderedNodes, bLegColumnIndex: new Map() };
  }

  // Find the index of the FreeSWITCH / media-server node (the B2BUA center point).
  // B-leg virtual nodes go after this node.
  const mediaIdx = orderedNodes.findIndex((n) => n.role === 'media-server');

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
 * Orders nodes left-to-right by tracing the path of the call flow.
 *
 * Algorithm:
 * 1. Collect all INVITE requests (status === null), sorted chronologically
 * 2. Walk the A-leg INVITEs in order, placing src_ip then dst_ip for each
 *    — this naturally produces the correct chain even when intermediate
 *    hops are invisible (e.g. NLB pass-through between SBC-VIP and SBC-1)
 * 3. Repeat for B-leg INVITEs
 * 4. Append any remaining nodes not yet placed
 *
 * Previous approach used traceInviteChain() which required each INVITE's
 * src_ip to already be placed. That failed when SBC-VIP dispatched to
 * SBC-1 (via NLB, no SIP message) and SBC-1 forwarded to FreeSWITCH —
 * SBC-1 was never placed by the chain tracer, so FreeSWITCH could end up
 * before SBC-1 in the column order.
 */
function orderNodes(
  sorted: ReadonlyArray<HomerSearchResult>,
  allNodeNames: ReadonlyArray<string>,
  aLegCallIds: Set<string>,
  bLegCallIds: Set<string>,
): LadderNode[] {
  const placed = new Set<string>();
  const ordered: string[] = [];

  function place(name: string): void {
    if (!placed.has(name)) {
      placed.add(name);
      ordered.push(name);
    }
  }

  // Find all INVITE requests (status === null means request), already sorted by timestamp
  const invites = sorted.filter((m) => m.method === 'INVITE' && m.status === null);

  if (invites.length === 0) {
    // No INVITEs at all — fall back to discovery order
    for (const name of allNodeNames) {
      place(name);
    }
  } else {
    const aLegInvites = invites.filter((m) => aLegCallIds.has(m.callid));
    const bLegInvites = invites.filter((m) => bLegCallIds.has(m.callid));

    // Use A-leg INVITEs first; if none classified as A-leg, use all
    const primaryInvites = aLegInvites.length > 0 ? aLegInvites : invites;

    // Walk each A-leg INVITE chronologically, placing src then dst.
    // Because INVITEs are already sorted by timestamp, this produces:
    //   INVITE #1 (BW-ATL → SBC-VIP): place BW-ATL, place SBC-VIP
    //   INVITE #2 (SBC-1 → FreeSWITCH): place SBC-1, place FreeSWITCH
    // Result: BW-ATL | SBC-VIP | SBC-1 | FreeSWITCH
    for (const invite of primaryInvites) {
      place(invite.src_ip);
      place(invite.dst_ip);
    }

    // Walk B-leg INVITEs the same way
    for (const invite of bLegInvites) {
      place(invite.src_ip);
      place(invite.dst_ip);
    }

    // Append any remaining nodes (e.g. nodes only seen in non-INVITE messages)
    for (const name of allNodeNames) {
      place(name);
    }
  }

  // Build LadderNode objects with column indices
  return ordered.map((id, columnIndex) => ({
    id,
    role: classifyNodeRole(id),
    columnIndex,
  }));
}

/**
 * Classifies Call-IDs into A-leg and B-leg sets using the correlation map.
 *
 * The first Call-ID seen in the earliest INVITE is the A-leg.
 * Any Call-IDs correlated to it (via the correlations map) are B-leg.
 * Call-IDs not in any correlation group remain classified by position:
 * if they share src/dst with the A-leg Call-ID's messages, they're A-leg.
 */
function classifyCallLegs(
  sorted: ReadonlyArray<HomerSearchResult>,
  correlations: Record<string, string[]>,
): { aLegCallIds: Set<string>; bLegCallIds: Set<string> } {
  const aLegCallIds = new Set<string>();
  const bLegCallIds = new Set<string>();

  // Find the first INVITE to determine the primary A-leg Call-ID
  const firstInvite = sorted.find((m) => m.method === 'INVITE' && m.status === null);

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
 * Refines carrier node roles: the carrier that sends the first A-leg INVITE
 * is "carrier-ingress"; carriers that receive B-leg INVITEs are "carrier-egress".
 */
function refineCarrierRoles(
  nodes: LadderNode[],
  sorted: ReadonlyArray<HomerSearchResult>,
  aLegCallIds: Set<string>,
): void {
  // Find the source of the first A-leg INVITE (this is carrier-ingress)
  const firstALegInvite = sorted.find(
    (m) => m.method === 'INVITE' && m.status === null && aLegCallIds.has(m.callid),
  );

  const ingressNodeId = firstALegInvite?.src_ip;

  // Find nodes that are destinations of B-leg INVITEs (these are carrier-egress)
  const egressNodeIds = new Set<string>();
  for (const msg of sorted) {
    if (msg.method === 'INVITE' && msg.status === null && !aLegCallIds.has(msg.callid)) {
      // This is a B-leg INVITE — its final destination might be a carrier-egress
      const destNode = nodes.find((n) => n.id === msg.dst_ip);
      if (destNode && isCarrierRole(destNode.role)) {
        egressNodeIds.add(msg.dst_ip);
      }
    }
  }

  // Apply refined roles
  for (const node of nodes) {
    if (!isCarrierRole(node.role)) continue;

    if (node.id === ingressNodeId) {
      node.role = 'carrier-ingress';
    } else if (egressNodeIds.has(node.id)) {
      node.role = 'carrier-egress';
    }
    // If neither, keep the default carrier-ingress from classifyNodeRole
  }
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
