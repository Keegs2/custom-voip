/**
 * callGrouping.ts — pure call-grouping logic for the Troubleshooting page.
 *
 * Extracted verbatim from TroubleshootingPage.tsx (2026-09 data-fidelity
 * pass) so the union-find grouping is a PURE, dependency-free module that
 * the dev-time fidelity self-test (components/sip-ladder/
 * sipLadderFidelity.assert.ts) can bundle-and-node-execute against the REAL
 * code — the same pattern as ladderOrder.ts / ladderOrder.assert.ts.
 * No behavior change: TroubleshootingPage imports and uses these exports.
 */
import type { HomerSearchResult } from '../../api/homer';
import type { MessageAttestation } from '../../types/stir';

/** A single call represented by one row in the search results. */
export interface CallGroup {
  /** The representative message (initial inbound INVITE, or earliest message) */
  representative: HomerSearchResult;
  /** All Call-IDs in this correlation group */
  callIds: string[];
  /** Every SIP message belonging to this call */
  messages: HomerSearchResult[];
  /** Final SIP response status (highest non-1xx response, or null) */
  finalStatus: number | null;
  /** Duration in seconds from first INVITE to last BYE, or null if unavailable */
  durationSec: number | null;
  /**
   * STIR/SHAKEN attestation for this call. Per-call, so it's identical across
   * the call's messages — we take the first message that carries a non-null
   * `attestation`. `null` when the call has no stored attestation.
   */
  attestation: MessageAttestation | null;
}

/**
 * Groups SIP messages into calls using the correlations map.
 *
 * The correlations map has Call-ID -> list of related Call-IDs. We build
 * connected components (union-find style) so that A-leg and B-leg messages
 * are merged into a single call group. Then we pick the best representative
 * message for each group: the earliest INVITE request (status === null),
 * falling back to the earliest message overall.
 */
export function groupMessagesByCall(
  results: HomerSearchResult[],
  correlations: Record<string, string[]>,
): CallGroup[] {
  // Build union-find: map each Call-ID to its canonical group key
  const parent = new Map<string, string>();

  function find(id: string): string {
    let root = id;
    while (parent.has(root) && parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    // Path compression
    let current = id;
    while (current !== root) {
      const next = parent.get(current) ?? current;
      parent.set(current, root);
      current = next;
    }
    return root;
  }

  function union(a: string, b: string): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent.set(rootB, rootA);
    }
  }

  // Initialize each Call-ID as its own parent
  for (const row of results) {
    if (!parent.has(row.callid)) {
      parent.set(row.callid, row.callid);
    }
  }

  // Union correlated Call-IDs
  for (const [cid, related] of Object.entries(correlations)) {
    if (!parent.has(cid)) {
      parent.set(cid, cid);
    }
    for (const relatedCid of related) {
      if (!parent.has(relatedCid)) {
        parent.set(relatedCid, relatedCid);
      }
      union(cid, relatedCid);
    }
  }

  // Group messages by their root Call-ID
  const groups = new Map<string, HomerSearchResult[]>();
  for (const row of results) {
    const root = find(row.callid);
    const existing = groups.get(root);
    if (existing) {
      existing.push(row);
    } else {
      groups.set(root, [row]);
    }
  }

  // Build CallGroup objects
  const callGroups: CallGroup[] = [];
  for (const [, messages] of groups) {
    // Sort messages by timestamp (earliest first)
    messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // Collect all unique Call-IDs in this group
    const callIdSet = new Set<string>();
    for (const msg of messages) {
      callIdSet.add(msg.callid);
    }
    const callIds = Array.from(callIdSet);

    // Find the representative: earliest INVITE request (status === null)
    let representative = messages.find(
      (m) => m.method.toUpperCase() === 'INVITE' && m.status === null,
    );
    // Fallback: just the earliest message
    if (!representative) {
      representative = messages[0];
    }

    // Determine the final call status: highest non-1xx response code in the group.
    // This shows whether the call was answered (200), rejected (4xx/5xx), etc.
    let finalStatus: number | null = null;
    for (const msg of messages) {
      if (msg.status !== null && msg.status >= 200) {
        if (finalStatus === null || msg.status > finalStatus) {
          finalStatus = msg.status;
        }
      }
    }
    // If we only have 1xx provisional responses, show the highest one
    if (finalStatus === null) {
      for (const msg of messages) {
        if (msg.status !== null && msg.status >= 100 && msg.status < 200) {
          if (finalStatus === null || msg.status > finalStatus) {
            finalStatus = msg.status;
          }
        }
      }
    }

    // Calculate duration: from first INVITE to the last BYE (or last message)
    let durationSec: number | null = null;
    const firstInvite = messages.find(
      (m) => m.method.toUpperCase() === 'INVITE' && m.status === null,
    );
    const lastBye = [...messages]
      .reverse()
      .find((m) => m.method.toUpperCase() === 'BYE');
    if (firstInvite && lastBye) {
      const startNs = firstInvite.timestamp_ns;
      const endNs = lastBye.timestamp_ns;
      if (
        typeof startNs === 'number' &&
        typeof endNs === 'number' &&
        startNs > 0 &&
        endNs > 0
      ) {
        durationSec = Math.round((endNs - startNs) / 1_000_000_000);
      }
    }

    // Attestation is per-call: the API stamps the SAME object on every message
    // sharing a Call-ID, so the first message that carries a non-null one is
    // representative for the whole group. Falls back to null (no record).
    const attestation =
      messages.find((m) => m.attestation != null)?.attestation ?? null;

    callGroups.push({
      representative: representative!,
      callIds,
      messages,
      finalStatus,
      durationSec,
      attestation,
    });
  }

  // Sort call groups by representative timestamp (newest first for search results)
  callGroups.sort((a, b) =>
    b.representative.timestamp.localeCompare(a.representative.timestamp),
  );

  return callGroups;
}
