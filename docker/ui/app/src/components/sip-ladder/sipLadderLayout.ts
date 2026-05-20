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

  // Build column index lookup
  const columnIndex = new Map<string, number>();
  orderedNodes.forEach((node, idx) => {
    columnIndex.set(node.id, idx);
  });

  // Refine carrier-egress roles now that we have ordering context
  refineCarrierRoles(orderedNodes, sorted, aLegCallIds);

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

    // Get column positions (default to 0 if somehow unknown)
    const sourceCol = columnIndex.get(msg.src_ip) ?? 0;
    const destCol = columnIndex.get(msg.dst_ip) ?? 0;

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
    nodes: orderedNodes,
    messages: processedMessages,
    aLegCallIds,
    bLegCallIds,
    callDurationMs,
  };
}

// ─── Internal helpers ───────────────────────────────────────────────────────

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
 * 1. Find the first INVITE request in the sorted messages
 * 2. Start from its src_ip (carrier ingress)
 * 3. Follow the INVITE chain: for each node placed, find the next INVITE
 *    where that node is the source, and place its destination next
 * 4. Repeat for the B-leg (different Call-ID)
 * 5. Append any remaining nodes not yet placed
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

  // Find all INVITE requests (status === null means request)
  const invites = sorted.filter((m) => m.method === 'INVITE' && m.status === null);

  if (invites.length === 0) {
    // No INVITEs at all — fall back to discovery order
    for (const name of allNodeNames) {
      place(name);
    }
  } else {
    // Trace the A-leg INVITE chain
    const aLegInvites = invites.filter((m) => aLegCallIds.has(m.callid));
    const bLegInvites = invites.filter((m) => bLegCallIds.has(m.callid));

    // Use A-leg INVITEs first; if none classified as A-leg, use all
    const primaryInvites = aLegInvites.length > 0 ? aLegInvites : invites;

    // Start with the first INVITE's source
    const firstInvite = primaryInvites[0]!;
    place(firstInvite.src_ip);
    place(firstInvite.dst_ip);

    // Follow the chain from the last placed node
    traceInviteChain(primaryInvites, placed, place);

    // Now trace the B-leg chain
    if (bLegInvites.length > 0) {
      const firstBLeg = bLegInvites[0]!;
      place(firstBLeg.src_ip);
      place(firstBLeg.dst_ip);
      traceInviteChain(bLegInvites, placed, place);
    }

    // Append any remaining nodes
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
 * Traces INVITE requests to discover additional nodes in the call path.
 * For each unplaced destination that follows a placed source, adds it.
 */
function traceInviteChain(
  invites: ReadonlyArray<HomerSearchResult>,
  placed: Set<string>,
  place: (name: string) => void,
): void {
  // Multiple passes to handle chains of any depth
  let changed = true;
  let iterations = 0;
  const maxIterations = invites.length + 1; // prevent infinite loops

  while (changed && iterations < maxIterations) {
    changed = false;
    iterations++;

    for (const invite of invites) {
      // If the source is already placed but destination is not, place destination
      if (placed.has(invite.src_ip) && !placed.has(invite.dst_ip)) {
        place(invite.dst_ip);
        changed = true;
      }
      // Also handle the reverse: if dst is placed but src isn't, place src before it
      // (This handles cases where we discover a node that sent to an already-placed node)
      if (!placed.has(invite.src_ip) && placed.has(invite.dst_ip)) {
        place(invite.src_ip);
        changed = true;
      }
    }
  }
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
