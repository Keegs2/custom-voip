/**
 * callGrouping.ts — pure call-grouping logic for the Troubleshooting page.
 *
 * A PURE, dependency-free module so the dev-time self-tests
 * (./callGrouping.assert.ts and components/sip-ladder/
 * sipLadderFidelity.assert.ts) can bundle-and-node-execute the REAL code —
 * the same pattern as ladderOrder.ts / ladderOrder.assert.ts.
 *
 * One row per CALL, not per Call-ID. A forwarded RCF call is an A leg
 * (carrier → FreeSWITCH) plus one B leg per bridge attempt in FS's failover
 * loop (SBC-1/SBC-2 × Dallas/LA). Legs are merged with union-find over two
 * independent link sources:
 *   1. `correlations` (Call-ID → related Call-IDs, X-CID analysis) — always.
 *   2. `legs[cid].a_callid` (API leg classification) — when the API sends it.
 *      Absent on older APIs; grouping then behaves exactly as before.
 *
 * RESULT semantics (why "highest status in the group" was wrong): a call
 * whose first B attempt got 503 and whose second got 200 was ANSWERED. The
 * caller-visible outcome is the final response to the A leg's INITIAL
 * INVITE, so that is the result. Failed failover attempts are surfaced
 * separately via `attempts` and can never override an answer.
 */
import type {
  HomerLegInfo,
  HomerSearchResponse,
  HomerSearchResult,
} from '../../api/homer';
import type { MessageAttestation } from '../../types/stir';

/** Outcome of one B-leg bridge attempt, for compact display on the row. */
export interface LegAttempt {
  callid: string;
  /** 1-based attempt ordinal from the API's leg map; null when unknown. */
  attempt: number | null;
  /** Final (>=200) response to this leg's initial INVITE; null if none captured. */
  finalStatus: number | null;
}

/** A single call represented by one row in the search results. */
export interface CallGroup {
  /** The representative message (A leg's initial INVITE, else earliest INVITE, else earliest message) */
  representative: HomerSearchResult;
  /** All Call-IDs in this correlation group (first-appearance order) */
  callIds: string[];
  /** Every SIP message belonging to this call (timestamp order) */
  messages: HomerSearchResult[];
  /**
   * Call result: final response to the A leg's initial INVITE. Falls back to
   * an INVITE 2xx anywhere in the group, then to the legacy rule (highest
   * final, else highest provisional), then null.
   */
  finalStatus: number | null;
  /** Seconds from A-leg answer to A-leg BYE (legacy fallback: first INVITE → last BYE) */
  durationSec: number | null;
  /**
   * STIR/SHAKEN attestation for this call. Per-call, so it's identical across
   * the call's messages — we take the first message that carries a non-null
   * `attestation`. `null` when the call has no stored attestation.
   */
  attestation: MessageAttestation | null;
  /** The A-leg Call-ID used for RESULT/duration; null when no INVITE was captured. */
  aLegCallId: string | null;
  /** B-leg attempts in attempt order (empty for a call with no B leg captured). */
  attempts: LegAttempt[];
  /**
   * Correlation map scoped to THIS group, for the ladder's A/B lane
   * classification: every Call-ID linked to every other, except extra
   * API-classified A legs (left to the layout's src-IP heuristic). Makes the
   * ladder's lanes independent of whether a link came from `correlations`
   * or from `legs`.
   */
  ladderCorrelations: Record<string, string[]>;
}

// ─── Small SIP helpers ──────────────────────────────────────────────────────

/** Leading CSeq number ("102 INVITE" → 102), or null when absent/unparseable. */
function cseqNumber(m: HomerSearchResult): number | null {
  const match = m.cseq ? /^\s*(\d+)/.exec(m.cseq) : null;
  return match ? Number(match[1]) : null;
}

/** Transaction method: the CSeq method when present (authoritative for responses), else `method`. */
function txnMethod(m: HomerSearchResult): string {
  const match = m.cseq ? /^\s*\d+\s+(\S+)/.exec(m.cseq) : null;
  return (match ? match[1]! : m.method).toUpperCase();
}

function isInviteRequest(m: HomerSearchResult): boolean {
  return m.method.toUpperCase() === 'INVITE' && m.status === null;
}

function isByeRequest(m: HomerSearchResult): boolean {
  return m.method.toUpperCase() === 'BYE' && m.status === null;
}

function validNs(ns: number | undefined): ns is number {
  return typeof ns === 'number' && ns > 0;
}

/** Runtime guard — the leg map comes off the wire from a possibly newer/older API. */
function isLegInfo(value: unknown): value is HomerLegInfo {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<Record<keyof HomerLegInfo, unknown>>;
  return (v.role === 'A' || v.role === 'B') && typeof v.a_callid === 'string';
}

interface LegOutcome {
  /** Final response status to the leg's initial INVITE, or null. */
  status: number | null;
  /** Earliest 2xx to the initial INVITE (the answer instant), or null. */
  answer: HomerSearchResult | null;
}

/**
 * Final response to a leg's INITIAL INVITE (re-INVITEs excluded by CSeq).
 * A leg is captured on several hops, so there are several copies of the same
 * final; a 2xx anywhere wins (answered is authoritative), otherwise the
 * LATEST final — the copy furthest back toward the caller.
 *
 * `legMessages` must be one Call-ID's messages in timestamp order.
 */
function initialInviteOutcome(legMessages: ReadonlyArray<HomerSearchResult>): LegOutcome {
  const initialReq = legMessages.find(isInviteRequest);
  let initialSeq = initialReq ? cseqNumber(initialReq) : null;
  const inviteResponses = legMessages.filter(
    (m) => m.status !== null && m.status >= 200 && txnMethod(m) === 'INVITE',
  );
  if (initialSeq === null) {
    // Request not captured — the lowest INVITE CSeq seen is the initial one.
    for (const r of inviteResponses) {
      const n = cseqNumber(r);
      if (n !== null && (initialSeq === null || n < initialSeq)) initialSeq = n;
    }
  }
  const finals = inviteResponses.filter((r) => {
    const n = cseqNumber(r);
    return initialSeq === null || n === null || n === initialSeq;
  });
  const answer = finals.find((r) => r.status! >= 200 && r.status! < 300) ?? null;
  if (answer) return { status: answer.status, answer };
  const last = finals[finals.length - 1];
  return { status: last ? last.status : null, answer: null };
}

/** Legacy result rule: highest final in the group, else highest provisional. */
function legacyFinalStatus(messages: ReadonlyArray<HomerSearchResult>): number | null {
  let best: number | null = null;
  for (const msg of messages) {
    if (msg.status !== null && msg.status >= 200 && (best === null || msg.status > best)) {
      best = msg.status;
    }
  }
  if (best !== null) return best;
  for (const msg of messages) {
    if (
      msg.status !== null &&
      msg.status >= 100 &&
      msg.status < 200 &&
      (best === null || msg.status > best)
    ) {
      best = msg.status;
    }
  }
  return best;
}

function secondsBetween(startNs: number | undefined, endNs: number | undefined): number | null {
  if (!validNs(startNs) || !validNs(endNs) || endNs < startNs) return null;
  return Math.round((endNs - startNs) / 1_000_000_000);
}

/** Legacy duration rule: first INVITE request → last BYE anywhere in the group. */
function legacyDuration(messages: ReadonlyArray<HomerSearchResult>): number | null {
  const firstInvite = messages.find(isInviteRequest);
  const lastBye = [...messages].reverse().find((m) => m.method.toUpperCase() === 'BYE');
  if (!firstInvite || !lastBye) return null;
  return secondsBetween(firstInvite.timestamp_ns, lastBye.timestamp_ns);
}

/**
 * Picks the A-leg Call-ID of a group:
 *   1. a Call-ID the API classified role 'A';
 *   2. else an `a_callid` a group member points at that is itself present;
 *   3. else the earliest INVITE request's Call-ID (legacy / old API);
 *   4. else null (no INVITE captured — RESULT uses the legacy rule).
 */
function pickALeg(
  callIds: ReadonlyArray<string>,
  messages: ReadonlyArray<HomerSearchResult>,
  legs: Readonly<Record<string, HomerLegInfo>>,
): string | null {
  const present = new Set(callIds);
  const byRole = callIds.find((cid) => legs[cid]?.role === 'A');
  if (byRole !== undefined) return byRole;
  for (const cid of callIds) {
    const target = legs[cid]?.a_callid;
    if (target !== undefined && present.has(target)) return target;
  }
  return messages.find(isInviteRequest)?.callid ?? null;
}

/** B-leg attempts: attempt order when every attempt is numbered, else first-seen time. */
function buildAttempts(
  callIds: ReadonlyArray<string>,
  aLegCallId: string | null,
  byCallId: ReadonlyMap<string, HomerSearchResult[]>,
  legs: Readonly<Record<string, HomerLegInfo>>,
): LegAttempt[] {
  const rows: Array<LegAttempt & { startNs: number }> = [];
  for (const cid of callIds) {
    if (cid === aLegCallId || legs[cid]?.role === 'A') continue;
    const legMessages = byCallId.get(cid) ?? [];
    const attempt = legs[cid]?.attempt;
    rows.push({
      callid: cid,
      attempt: typeof attempt === 'number' && Number.isFinite(attempt) ? attempt : null,
      finalStatus: initialInviteOutcome(legMessages).status,
      startNs: legMessages[0]?.timestamp_ns ?? 0,
    });
  }
  const allNumbered = rows.every((r) => r.attempt !== null);
  rows.sort((a, b) =>
    allNumbered && a.attempt !== b.attempt ? a.attempt! - b.attempt! : a.startNs - b.startNs,
  );
  return rows.map(({ callid, attempt, finalStatus }) => ({ callid, attempt, finalStatus }));
}

// ─── Grouping ───────────────────────────────────────────────────────────────

/**
 * Groups SIP messages into calls.
 *
 * Union-find over `correlations` (bidirectional Call-ID → related list) plus
 * `legs[cid].a_callid` when the API supplies it, so an A leg and every B
 * attempt land in ONE group even if one link source is incomplete.
 *
 * @param legs  Optional API leg map. Omitted/undefined (older API) ⇒ grouping
 *              is driven by `correlations` alone, exactly as before.
 */
export function groupMessagesByCall(
  results: HomerSearchResult[],
  correlations: Record<string, string[]>,
  legs?: Record<string, HomerLegInfo>,
): CallGroup[] {
  // Sanitize the wire leg map once; downstream code trusts `legMap`.
  const legMap: Record<string, HomerLegInfo> = {};
  if (legs) {
    for (const [cid, info] of Object.entries(legs)) {
      if (isLegInfo(info)) legMap[cid] = info;
    }
  }

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

  function ensure(id: string): void {
    if (!parent.has(id)) parent.set(id, id);
  }

  function union(a: string, b: string): void {
    ensure(a);
    ensure(b);
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent.set(rootB, rootA);
    }
  }

  for (const row of results) ensure(row.callid);

  // Link source 1: X-CID correlations.
  for (const [cid, related] of Object.entries(correlations)) {
    ensure(cid);
    for (const relatedCid of related) union(cid, relatedCid);
  }

  // Link source 2: the API's leg map (B leg → its A leg).
  for (const [cid, info] of Object.entries(legMap)) {
    if (info.a_callid !== '' && info.a_callid !== cid) union(info.a_callid, cid);
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

  const callGroups: CallGroup[] = [];
  for (const [, messages] of groups) {
    messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // Per-Call-ID message lists (each inherits timestamp order) + first-seen order.
    const byCallId = new Map<string, HomerSearchResult[]>();
    for (const msg of messages) {
      const list = byCallId.get(msg.callid);
      if (list) list.push(msg);
      else byCallId.set(msg.callid, [msg]);
    }
    const callIds = Array.from(byCallId.keys());

    const aLegCallId = pickALeg(callIds, messages, legMap);
    const aMessages = aLegCallId !== null ? (byCallId.get(aLegCallId) ?? []) : [];

    // Representative: the A leg's initial INVITE → earliest INVITE → earliest message.
    const representative =
      aMessages.find(isInviteRequest) ?? messages.find(isInviteRequest) ?? messages[0]!;

    // RESULT: A leg's initial-INVITE final. Fallbacks never let a failed
    // attempt mask an answer: any INVITE 2xx in the group beats the legacy
    // "highest status" rule (which would rank 503 above 200).
    const aOutcome = initialInviteOutcome(aMessages);
    let finalStatus: number | null = aOutcome.status;
    if (finalStatus === null) {
      const anyAnswer = messages.find(
        (m) => m.status !== null && m.status >= 200 && m.status < 300 && txnMethod(m) === 'INVITE',
      );
      finalStatus = anyAnswer ? anyAnswer.status : legacyFinalStatus(messages);
    }

    // DURATION: A-leg answer → first A-leg BYE after it (the caller's billed
    // talk time; excludes ring time and B-leg teardown lag). Fallback: the
    // A answer → first BYE anywhere after it, then the legacy rule.
    let durationSec: number | null = null;
    const answer = aOutcome.answer;
    if (answer && validNs(answer.timestamp_ns)) {
      const answerNs = answer.timestamp_ns;
      const afterAnswer = (m: HomerSearchResult): boolean =>
        isByeRequest(m) && validNs(m.timestamp_ns) && m.timestamp_ns >= answerNs;
      const bye = aMessages.find(afterAnswer) ?? messages.find(afterAnswer);
      if (bye) durationSec = secondsBetween(answerNs, bye.timestamp_ns);
    }
    if (durationSec === null) durationSec = legacyDuration(messages);

    const attestation =
      messages.find((m) => m.attestation != null)?.attestation ?? null;

    const attempts = buildAttempts(callIds, aLegCallId, byCallId, legMap);

    // Group-scoped ladder map (see CallGroup.ladderCorrelations).
    const linked = callIds.filter((cid) => cid === aLegCallId || legMap[cid]?.role !== 'A');
    const ladderCorrelations: Record<string, string[]> = {};
    if (linked.length > 1) {
      for (const cid of linked) ladderCorrelations[cid] = linked;
    }

    callGroups.push({
      representative,
      callIds,
      messages,
      finalStatus,
      durationSec,
      attestation,
      aLegCallId,
      attempts,
      ladderCorrelations,
    });
  }

  // Newest call first
  callGroups.sort((a, b) =>
    b.representative.timestamp.localeCompare(a.representative.timestamp),
  );

  return callGroups;
}

// ─── Attempt summary + correlation notice (pure display derivations) ─────────

/**
 * Compact failover summary for the Result cell, e.g. "503 → 200", or null
 * when there was at most one attempt (nothing worth flagging). Unknown
 * outcomes render as "—".
 */
export function summarizeAttempts(attempts: ReadonlyArray<LegAttempt>): string | null {
  if (attempts.length < 2) return null;
  return attempts.map((a) => (a.finalStatus !== null ? String(a.finalStatus) : '—')).join(' → ');
}

/** Why the results may show a call split across rows. */
export interface CorrelationNotice {
  /**
   * The API's correlation_status verbatim — normally a HomerCorrelationStatus,
   * but kept as a string so a value newer than this build still surfaces.
   */
  status: string | null;
  /** Staff-facing reason from the API, if any. */
  reason: string | null;
  /** The X-CID correlation window was truncated server-side. */
  truncated: boolean;
}

/**
 * Returns a notice when leg linking is known to be incomplete: any
 * correlation_status other than 'ok', or correlation_truncated. Absent
 * fields (older API) ⇒ null (no banner — nothing is known to be wrong).
 */
export function deriveCorrelationNotice(
  response:
    | Pick<HomerSearchResponse, 'correlation_status' | 'correlation_reason' | 'correlation_truncated'>
    | undefined,
): CorrelationNotice | null {
  if (!response) return null;
  const rawStatus: unknown = response.correlation_status;
  const status = typeof rawStatus === 'string' && rawStatus !== '' ? rawStatus : null;
  const truncated = response.correlation_truncated === true;
  const statusBad = status !== null && status !== 'ok';
  if (!statusBad && !truncated) return null;
  const rawReason: unknown = response.correlation_reason;
  const reason = typeof rawReason === 'string' && rawReason.trim() !== '' ? rawReason.trim() : null;
  return { status, reason, truncated };
}
