import type { HomerSearchResult } from '../../api/homer';
import type { LadderLayout, LadderMessage, LadderNode, NodeRole } from './sipLadderTypes';
import {
  classifyNodeRole,
  formatMessageLabel,
  getMessageColor,
  isRetransmission,
  LADDER_COLORS,
} from './sipLadderUtils';

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

    // Get column positions, using the B-leg virtual column when applicable
    const sourceCol = resolveColumn(msg.src_ip, leg, columnIndex, bLegColumnIndex);
    const destCol = resolveColumn(msg.dst_ip, leg, columnIndex, bLegColumnIndex);

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
      sourceCol,
      destCol,
      direction: sourceCol <= destCol ? 'right' : 'left',
      color,
      label: formatMessageLabel(msg),
      isRetransmission: isRetransmit,
      leg,
      timeDeltaMs,
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
 * Resolves the column index for a physical node ID, taking into account whether
 * the message is A-leg or B-leg. For B-leg messages involving a split node, returns
 * the B-leg virtual column index instead of the A-leg column.
 */
function resolveColumn(
  physicalId: string,
  leg: 'a' | 'b' | 'unknown',
  columnIndex: Map<string, number>,
  bLegColumnIndex: Map<string, number>,
): number {
  // For B-leg messages, check if this node has been split
  if (leg === 'b') {
    const bLegCol = bLegColumnIndex.get(physicalId);
    if (bLegCol !== undefined) {
      return bLegCol;
    }
  }
  // Fall back to the standard (A-leg / unsplit) column
  return columnIndex.get(physicalId) ?? 0;
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
