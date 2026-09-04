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
import { orderLadderColumns } from './ladderOrder';
import type { OrderParticipant, OrderWireMessage } from './ladderOrder';

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
 * 4. Orders nodes left-to-right by the CANONICAL platform topology
 *    (ladderOrder.ts): orig-external → NLB VIP → SBC(A) → FS → signaling VIP
 *    → SBC(B) → term-external; chronology only breaks ties within a rank
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

  // Steps 3+4: Order nodes left-to-right by the CANONICAL platform topology
  // (ladderOrder.ts): orig external → NLB VIP → A-leg SBC → FS → signaling VIP
  // → (B-leg SBC splice point) → term external, with the term endpoint pinned
  // rightmost via the failover-aware last-external-INVITE rule. Carrier roles
  // (ingress vs egress) are still refined from call-flow direction so header
  // sublabels and the handoff injector see the right roles.
  const { orderedNodes, bLegInsertIndex } = orderNodes(
    sorted,
    nodeNames,
    aLegCallIds,
    bLegCallIds,
  );

  // Step 4.5: Split nodes that appear in both call legs into virtual A/B-leg
  // columns, splicing the B-leg clones at the canonical rank-6 position (after
  // the signaling VIP, before the egress externals). This creates the pinned
  // symmetric ladder, e.g.:
  //   Sinch-Denver | SBC-VIP | SBC-1 (A) | FS | SBC-SigVIP | SBC-1 (B) | Sinch-Atlanta-LD
  const { finalNodes, bLegColumnIndex } = splitDualLegNodes(
    orderedNodes,
    sorted,
    aLegCallIds,
    bLegCallIds,
    bLegInsertIndex,
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

  // Post-pass: bridge the VIP ↔ sibling-SBC loopback boundary with synthetic
  // connectors so the path reads continuously across the same-box handoff.
  // Runs AFTER every message has its resolved source/dest columns and BEFORE the
  // layout is returned. Purely additive — never mutates the real messages.
  const withHandoffs = injectInternalHandoffs(processedMessages, finalNodes);

  // Calculate overall call duration. Display order may be causally corrected,
  // so use min/max timestamps rather than first/last rows. Synthetic connectors
  // carry a borrowed timestamp, so drive duration off the REAL messages only.
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
    messages: withHandoffs,
    aLegCallIds,
    bLegCallIds,
    callDurationMs,
  };
}

// ─── Internal loopback handoff (VIP ↔ sibling-SBC connector) ─────────────────

/**
 * Extracts the zone prefix of an aliased node name — everything up to and
 * including the "SBC" token, minus the SBC token itself. This is what a VIP and
 * its sibling SBC share:
 *
 *   "Central-SBC-VIP" → "CENTRAL-"     "Central-SBC-1" → "CENTRAL-"
 *   "SBC-VIP"         → ""             "SBC-1"         → ""
 *   "West-SBC-VIP"    → "WEST-"        "West-SBC-2"    → "WEST-"
 *
 * Two nodes belong to the same zone (same physical box family) when their zone
 * prefixes are equal. Case-insensitive; returns `undefined` when the name has no
 * "SBC" token (so a non-SBC node never accidentally matches a VIP).
 */
function zonePrefixOfSbcName(name: string): string | undefined {
  const upper = name.toUpperCase();
  const idx = upper.indexOf('SBC');
  if (idx === -1) return undefined;
  return upper.slice(0, idx);
}

/**
 * Finds the sibling SBC column for a given VIP column: the `sbc`-role node in the
 * SAME zone (matching zone prefix). Returns its column index, or `undefined` when
 * no same-zone SBC column exists in the layout.
 *
 * When several SBC columns share the zone (a split node produces an A-leg and a
 * B-leg column, and there can be SBC-1 / SBC-2), pick the one CLOSEST to the VIP
 * so the connector bridges the smallest, most physically-adjacent gap. That is the
 * A-leg (ingress) SBC for a request-in and stays adjacent for a response-out.
 */
function findSiblingSbcColumn(
  vipCol: number,
  nodes: ReadonlyArray<LadderNode>,
): number | undefined {
  const vipNode = nodes[vipCol];
  if (!vipNode) return undefined;
  const vipZone = zonePrefixOfSbcName(vipNode.displayLabel ?? vipNode.id);
  if (vipZone === undefined) return undefined;

  let best: number | undefined;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.role !== 'sbc') continue;
    if (zonePrefixOfSbcName(node.displayLabel ?? node.id) !== vipZone) continue;
    const dist = Math.abs(i - vipCol);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/**
 * Builds a synthetic "internal loopback handoff" connector message bridging the
 * VIP ↔ sibling-SBC boundary. It is NOT a captured packet: no `raw_msg`, muted
 * neutral color, `directionInferred` (so it reuses the dashed rendering) and
 * `internalHandoff` (so the row can add the loopback affordance and the filter can
 * govern it). Its timestamp is borrowed from the real message it bridges so
 * ordering stays stable and no NaN ever enters the timeline.
 */
function makeHandoffMessage(
  fromCol: number,
  toCol: number,
  anchor: LadderMessage,
  idSuffix: string,
): LadderMessage {
  return {
    // Deterministic, collision-proof id derived from the anchor row.
    id: `${anchor.id}-handoff-${idSuffix}`,
    // Reuse the anchor's original packet purely to satisfy the type / timestamp
    // reads (CallSummary, timestamp gutter). The row is non-clickable because we
    // force `raw_msg` to null on the copy below, so the packet body is never shown.
    original: { ...anchor.original, raw_msg: null },
    sourceCol: fromCol,
    destCol: toCol,
    direction: fromCol <= toCol ? 'right' : 'left',
    color: LADDER_COLORS.internalHandoff,
    label: 'internal loopback',
    isRetransmission: false,
    // Not a hairpin — hairpins are src==dst self-loops with their own glyph. This
    // is a spanning connector between two DISTINCT columns of the same box.
    isHairpin: false,
    tsCorrected: false,
    leg: anchor.leg,
    // Zero elapsed time: it's the same box, no wire transit. Never null (avoids a
    // "first message" absolute-time render) and never NaN.
    timeDeltaMs: 0,
    directionInferred: true,
    internalHandoff: true,
  };
}

/**
 * Post-processing pass that injects synthetic dashed connectors across every
 * VIP ↔ sibling-SBC boundary crossing, so the ladder reads as one continuous path
 * even though the VIP and the SBC are the same physical Kamailio process (the NLB
 * is pass-through and the SBC carries the VIP on its own loopback — there is no
 * wire packet to capture across that boundary).
 *
 * Handles BOTH directions generically (covers requests AND responses on the A-leg).
 * The trigger is a per-leg REACHABILITY test, NOT the immediate neighbour: a
 * provisional response (`100 Trying VIP→carrier`) commonly sits between the inbound
 * request and the onward request, so an "is my immediate neighbour on the sibling
 * SBC?" heuristic silently misses the primary ingress bridge. Instead we ask
 * whether the SAME leg contains the loopback's OTHER end anywhere in the causal
 * direction:
 *
 *   • REQUEST-in  (VIP→SBC): a real message whose DEST is the VIP column, when the
 *                  SAME leg has ANY message SOURCED FROM the sibling SBC at a LATER
 *                  position (the onward INVITE from that SBC). Injected right AFTER
 *                  the inbound-to-VIP row so it lands at the very top of the ladder.
 *                  Dedup guarantees one VIP→SBC per leg, so firing on the FIRST
 *                  inbound-to-VIP message is correct.
 *   • RESPONSE-out (SBC→VIP): a real message whose SOURCE is the VIP and whose DEST
 *                  is the carrier (a response leaving toward the carrier), when the
 *                  SAME leg has an EARLIER message DESTINED TO the sibling SBC (the
 *                  response that arrived at the SBC). Injected right BEFORE that
 *                  outbound-from-VIP row. The "earlier dest to sibling" guard is
 *                  false at the initial `100 Trying VIP→carrier`, so the connector
 *                  never fires before any real response has reached the SBC.
 *
 * Guards (all required before injecting):
 *   - Both the VIP node and its same-zone sibling SBC node exist in the layout.
 *   - There is a genuine column gap to bridge (VIP col ≠ sibling col).
 *   - The bridged endpoint is NOT the VIP itself (never src==dst — those are the
 *     existing hairpins with their own self-loop glyph).
 *   - We do NOT bridge the sbc↔sbc A-leg/B-leg virtual split (both sides are `sbc`,
 *     never `sbc-vip`, so the role checks below already exclude it).
 *   - `isHairpin` rows are skipped entirely (they are the self-loop copies).
 *   - No duplicate connector for the same boundary crossing (dedup by leg + from/to
 *     cols), so a burst of retransmitted INVITEs never stacks N connectors.
 */
function injectInternalHandoffs(
  messages: ReadonlyArray<LadderMessage>,
  nodes: ReadonlyArray<LadderNode>,
): LadderMessage[] {
  // Fast exit: nothing to do without at least one VIP column.
  const hasVip = nodes.some((n) => n.role === 'sbc-vip');
  if (!hasVip) return [...messages];

  const roleOf = (col: number): NodeRole | undefined => nodes[col]?.role;
  const isCarrierCol = (col: number): boolean => {
    const r = roleOf(col);
    return r === 'carrier-ingress' || r === 'carrier-egress';
  };

  // Phase 1: per-leg positional index of the loopback's endpoints. For every leg,
  // record — over REAL messages only, at their array position — the LAST position
  // at which each column is a message SOURCE and the FIRST position at which each
  // column is a message DEST. This lets the walk answer, in O(1):
  //   • "does this leg have a LATER message sourced from the sibling SBC?"  →
  //     lastSrcPosInLeg(leg, sibling) > i           (drives REQUEST-in)
  //   • "does this leg have an EARLIER message destined to the sibling SBC?" →
  //     firstDstPosInLeg(leg, sibling) < i          (drives RESPONSE-out)
  // Precomputing decouples the trigger from the immediate neighbour, so a
  // provisional response wedged between the inbound and onward requests can no
  // longer suppress the ingress bridge. O(n) build, O(1) queries.
  type Leg = LadderMessage['leg'];
  const lastSrcPos = new Map<Leg, Map<number, number>>();
  const firstDstPos = new Map<Leg, Map<number, number>>();
  const bump = (
    store: Map<Leg, Map<number, number>>,
    leg: Leg,
    col: number,
    pos: number,
    keepLatest: boolean,
  ): void => {
    let byCol = store.get(leg);
    if (!byCol) {
      byCol = new Map<number, number>();
      store.set(leg, byCol);
    }
    const cur = byCol.get(col);
    if (cur === undefined || (keepLatest ? pos > cur : pos < cur)) {
      byCol.set(col, pos);
    }
  };
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.internalHandoff || m.isHairpin) continue;
    bump(lastSrcPos, m.leg, m.sourceCol, i, true);
    bump(firstDstPos, m.leg, m.destCol, i, false);
  }
  const hasLaterSrc = (leg: Leg, col: number, pos: number): boolean => {
    const p = lastSrcPos.get(leg)?.get(col);
    return p !== undefined && p > pos;
  };
  const hasEarlierDst = (leg: Leg, col: number, pos: number): boolean => {
    const p = firstDstPos.get(leg)?.get(col);
    return p !== undefined && p < pos;
  };

  // Phase 2: single forward walk emitting connectors inline, in place.
  const out: LadderMessage[] = [];
  // Dedup: one connector per (leg, fromCol, toCol) adjacency is plenty; a burst of
  // retransmitted INVITEs into the VIP must not stack N identical connectors. Seed
  // it from any connectors ALREADY present so a re-run of this pass on its own
  // output stays idempotent (never re-injects a boundary that already has one).
  const emitted = new Set<string>();
  for (const m of messages) {
    if (m.internalHandoff) emitted.add(`${m.leg}:${m.sourceCol}->${m.destCol}`);
  }
  const emitOnce = (from: number, to: number, anchor: LadderMessage, kind: 'in' | 'out'): void => {
    if (from === to) return; // never src==dst (that's a hairpin, not a boundary)
    const key = `${anchor.leg}:${from}->${to}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    out.push(makeHandoffMessage(from, to, anchor, `${kind}-${from}-${to}`));
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.internalHandoff) {
      out.push(msg);
      continue;
    }

    // ── RESPONSE-out: curr SOURCE is the VIP and DEST is the carrier — a response ──
    // leaving the box toward the carrier. It fires only once an EARLIER message in
    // this leg already arrived at the sibling SBC (the real response reaching the
    // SBC face). That guard is false at the initial `100 Trying VIP→carrier`, so the
    // early provisional never triggers it. Bridge SBC → VIP just BEFORE this row.
    if (
      !msg.isHairpin &&
      roleOf(msg.sourceCol) === 'sbc-vip' &&
      isCarrierCol(msg.destCol)
    ) {
      const sibling = findSiblingSbcColumn(msg.sourceCol, nodes);
      if (sibling !== undefined && hasEarlierDst(msg.leg, sibling, i)) {
        emitOnce(sibling, msg.sourceCol, msg, 'out');
      }
    }

    // Emit the real message itself.
    out.push(msg);

    // ── REQUEST-in: curr DEST is the VIP and the SAME leg carries a LATER message ──
    // sourced from the sibling SBC (the onward INVITE from that SBC), regardless of
    // what the immediate next row is (it is usually the `100 Trying` back to the
    // carrier). Bridge VIP → SBC just AFTER this row so the connector lands at the
    // top of the ladder, between `INVITE BW→VIP` and the following rows.
    if (!msg.isHairpin && roleOf(msg.destCol) === 'sbc-vip') {
      const sibling = findSiblingSbcColumn(msg.destCol, nodes);
      if (sibling !== undefined && hasLaterSrc(msg.leg, sibling, i)) {
        emitOnce(msg.destCol, sibling, msg, 'in');
      }
    }
  }

  return out;
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
 * The B-leg virtual nodes are spliced at `bLegInsertIndex` — the canonical
 * rank-6 position computed by ladderOrder.ts (after FreeSWITCH AND the
 * signaling VIP, before any egress externals) — producing the pinned
 * symmetric layout with the term carrier always rightmost:
 *   BW-ATL | SBC-VIP | SBC-1 (A) | FreeSWITCH | SBC-SigVIP | SBC-1 (B) | BW-DAL
 *
 * Returns the modified node list and a map from physical node ID to the B-leg
 * virtual column index (used by resolveColumn to route B-leg messages).
 */
function splitDualLegNodes(
  orderedNodes: LadderNode[],
  sorted: ReadonlyArray<HomerSearchResult>,
  aLegCallIds: Set<string>,
  bLegCallIds: Set<string>,
  bLegInsertIndex: number,
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

  // Build the B-leg virtual clones, preserving A-leg chain order, and splice
  // them at the canonical rank-6 position. Using the ordering module's splice
  // index (instead of "immediately after media-server") keeps the B-leg SBC to
  // the RIGHT of the signaling VIP — wire truth is FS → SigVIP → SBC — and
  // always to the LEFT of the egress externals, term endpoint included. When
  // no egress external exists the index equals the list length (append), which
  // also covers the no-media-server degenerate case.
  const bLegVirtualNodes: LadderNode[] = [];
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

  const finalNodes: LadderNode[] = [...orderedNodes];
  const spliceAt = Math.min(Math.max(bLegInsertIndex, 0), finalNodes.length);
  finalNodes.splice(spliceAt, 0, ...bLegVirtualNodes);

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
 * Orders nodes left-to-right — canonical platform topology.
 *
 * Algorithm:
 * 1. Classify every node's role from its heplify alias (zone-aware substring
 *    matching handles West/Central prefixes).
 * 2. Resolve carrier in/out from CALL FLOW, not timestamps: a carrier that
 *    sources an A-leg INVITE is ingress; one that receives a B-leg INVITE
 *    (or appears only in B-leg traffic) is egress. (Header sublabels and the
 *    loopback-handoff injector consume these roles — unchanged behavior.)
 * 3. Delegate the actual ORDER to the pure ordering module (ladderOrder.ts):
 *    orig external (leftmost, always) → NLB VIP → A-leg SBC → FreeSWITCH →
 *    signaling VIP → [B-leg splice point] → failed term attempts → term
 *    external (rightmost, always). The orig/term endpoints come from the
 *    failover-aware earliest/last external INVITE rule (same rule as the
 *    results table); external-vs-signaling VIPs are told apart by SigVIP
 *    alias vocabulary with a traffic-shape fallback; unclassifiable nodes
 *    place between ranks by first activity, never outside the endpoints.
 *
 * This makes column order immune to BOTH capture-timestamp corruption and
 * first-appearance scrambling (the defect where the term carrier rendered
 * mid-ladder and the SigVIP rendered left of FreeSWITCH).
 */
function orderNodes(
  sorted: ReadonlyArray<HomerSearchResult>,
  allNodeNames: ReadonlyArray<string>,
  aLegCallIds: Set<string>,
  bLegCallIds: Set<string>,
): { orderedNodes: LadderNode[]; bLegInsertIndex: number } {
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

  // Step 3: canonical ordering via the pure module. Participants carry the
  // refined roles; wire rows carry src/dst + INVITE-request flags in display
  // order (array position doubles as the first-activity clock).
  const participants: OrderParticipant[] = allNodeNames.map((id) => ({
    id,
    role: roleById.get(id)!,
  }));
  const wire: OrderWireMessage[] = sorted.map((m) => ({
    src: m.src_ip,
    dst: m.dst_ip,
    isInviteRequest: m.method === 'INVITE' && m.status === null,
  }));

  const { orderedIds, bLegInsertIndex, endpointTags } = orderLadderColumns(
    participants,
    wire,
  );

  // Build LadderNode objects with column indices + endpoint bookend tags.
  const orderedNodes = orderedIds.map((id, columnIndex) => ({
    id,
    role: roleById.get(id)!,
    columnIndex,
    endpointTag: endpointTags.get(id),
  }));

  return { orderedNodes, bLegInsertIndex };
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
