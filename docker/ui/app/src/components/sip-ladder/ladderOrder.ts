import type { NodeRole } from './sipLadderTypes';

// ═════════════════════════════════════════════════════════════════════════════
// ladderOrder.ts — canonical left→right column ordering for the SIP ladder.
//
// PURE MODULE: no React, no DOM, no imports beyond an erased type. Feed it the
// participant list + the wire messages (in ladder display order) and it returns
// the ordered columns. Unit-assertable — fixtures live in ladderOrder.assert.ts
// (loaded dev-only from SipLadder.tsx).
//
// ── PINNED PLATFORM TOPOLOGY (ground truth, left → right) ──
//
//   1. Origination external endpoint (carrier PoP — Sinch-Denver / BW-DAL — or
//      a customer PBX / unknown public source). ALWAYS leftmost.
//   2. External NLB VIP (carrier-facing load-balancer address, e.g. West-SBC-VIP).
//   3. A-leg SBC (the SBC serving the inbound leg).
//   4. FreeSWITCH (media server; an FS-2 standby shares this tier).
//   5. Signaling VIP (the INTERNAL ILB address FreeSWITCH targets for its
//      outbound/B-leg and in-dialog requests — wire truth is FS → SigVIP → SBC).
//   6. B-leg SBC (virtual columns from the dual-leg split are spliced in HERE,
//      via `bLegInsertIndex` — between the signaling VIP and the egress
//      externals).
//   7. Termination external endpoint. ALWAYS rightmost, no exceptions. Under
//      carrier failover the LAST externally-destined INVITE wins; earlier
//      failed attempts rank just left of it.
//
//   Unknowns that defy classification are placed BETWEEN ranks by their first
//   activity (just left of the peer they first sent to / just right of the peer
//   they first received from) and are clamped strictly INSIDE the external
//   endpoints — never leftmost of orig, never rightmost of term.
//
// ── ORIG / TERM derivation (failover-aware — same rule as the results table,
//    TroubleshootingPage.deriveCarrierEndpoints) ──
//
//   ORIG = src of the EARLIEST external-source INVITE request.
//   TERM = dst of the LAST externally-destined INVITE request.
//   A call with only ONE external endpoint has no rank-7 column (term === orig
//   collapses to orig); a pure-inbound/failed call simply has no term.
//
// ── External VIP vs Signaling VIP ──
//
//   Primary: alias vocabulary. ip-alias.lua names signaling VIPs with a
//   "SigVIP" token ("SBC-SigVIP", "West-SBC-SigVIP", "Central-SBC-SigVIP") —
//   matched case-insensitively, plus a "signaling" spelling for future aliases.
//
//   Behavioral fallback (covers unaliased future VIPs): a VIP that ever
//   receives FROM an external source — or sends TO one — faces the carrier and
//   is the external VIP; a VIP fed exclusively by platform-internal sources
//   (FreeSWITCH targeting the ILB) is the signaling VIP.
// ═════════════════════════════════════════════════════════════════════════════

// ─── Public types ───────────────────────────────────────────────────────────

/** One ladder participant (a discovered src/dst alias) with its classified role. */
export interface OrderParticipant {
  /** heplify alias ("West-SBC-2", "Sinch-Denver") or raw IP fallback. */
  id: string;
  /** Role from classifyNodeRole (carrier in/out refinement not required). */
  role: NodeRole;
}

/**
 * One wire message, reduced to the fields ordering needs. Pass messages in
 * ladder DISPLAY order — array position doubles as the first-activity clock.
 */
export interface OrderWireMessage {
  /** Source alias/IP (post heplify aliasing). */
  src: string;
  /** Destination alias/IP (post heplify aliasing). */
  dst: string;
  /** True when the row is an INVITE *request* (method INVITE, no status). */
  isInviteRequest: boolean;
}

/** Bookend designation for the two external endpoints of the call. */
export type EndpointTag = 'orig' | 'term';

/** Result of the ordering pass. */
export interface OrderedColumns {
  /** Participant ids in canonical left→right column order. */
  orderedIds: string[];
  /**
   * Index (into `orderedIds`) where the dual-leg split should splice its B-leg
   * virtual SBC columns: after the signaling-VIP tier, before the egress
   * externals — i.e. before the first column of rank ≥ RANK 6/7. Equal to
   * `orderedIds.length` when no egress external exists.
   */
  bLegInsertIndex: number;
  /** id → 'orig' | 'term' for the designated external endpoints. */
  endpointTags: ReadonlyMap<string, EndpointTag>;
}

// ─── Rank constants (the pinned topology, as sortable numbers) ──────────────

const RANK_ORIG_EXTERNAL = 0; // 1. origination endpoint (+ sibling orig edge proxies)
const RANK_EXTERNAL_VIP = 1; //  2. carrier-facing NLB VIP
const RANK_SBC_A = 2; //         3. A-leg SBC (physical column; B-leg is a splice)
const RANK_MEDIA = 3; //         4. FreeSWITCH tier (FS-2 standby shares it)
const RANK_SIGNALING_VIP = 4; // 5. internal signaling ILB VIP
//                               6. B-leg SBC — virtual columns spliced at bLegInsertIndex
const RANK_EGRESS_EXTERNAL = 5; // failed termination attempts (just left of term)
const RANK_TERM_EXTERNAL = 6; // 7. termination endpoint — ALWAYS rightmost

/** Fractional offset for unclassifiable nodes placed between ranks. */
const RANK_EPSILON = 0.25;

// ─── Vocabulary helpers ─────────────────────────────────────────────────────

/**
 * Platform-owned alias detection — mirrors the token rules of
 * sipLadderUtils.classifyNodeRole + the results table's isPlatformNode:
 * SBC / VIP / FreeSWITCH / standalone-FS / Services tokens are ours; everything
 * else (carrier PoPs, customer PBX IPs, unknown publics) is external.
 */
function isPlatformAlias(name: string): boolean {
  const upper = name.toUpperCase();
  if (
    upper.includes('SBC') ||
    upper.includes('VIP') ||
    upper.includes('FREESWITCH') ||
    upper.includes('SERVICES')
  ) {
    return true;
  }
  // Standalone "FS" token, word-boundary guarded (keeps "Services" etc. out).
  return /(^|[^A-Z0-9])FS($|[^A-Z0-9])/.test(upper);
}

/**
 * True when an alias belongs to the known carrier vocabulary (ip-alias.lua):
 * "BW-*" (Bandwidth) and "Sinch-*" PoP names. Drives the "CARRIER · ORIG/TERM"
 * header subtitles for endpoints the role classifier doesn't recognize yet.
 */
export function matchesCarrierVocab(name: string): boolean {
  const dash = name.indexOf('-');
  const head = (dash === -1 ? name : name.slice(0, dash)).toUpperCase();
  return head === 'BW' || head === 'BANDWIDTH' || head === 'SINCH';
}

/** Signaling-VIP alias vocabulary — "SigVIP" (ip-alias.lua) or "signaling". */
const SIGVIP_NAME_RE = /SIG[-_]?VIP|SIGNALING/i;

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * Orders ladder participants into the canonical platform topology (see module
 * header). Deterministic and pure: same inputs → same output. Ties within a
 * rank break by first activity (earliest message touching the node), then by
 * participant order.
 */
export function orderLadderColumns(
  participants: ReadonlyArray<OrderParticipant>,
  messages: ReadonlyArray<OrderWireMessage>,
): OrderedColumns {
  const roleById = new Map<string, NodeRole>();
  for (const p of participants) roleById.set(p.id, p.role);

  /** External = not a platform node: carrier roles, carrier-vocab aliases the
   *  classifier missed, customer PBX / unknown public raw IPs. */
  const isExternal = (id: string): boolean => {
    const role = roleById.get(id);
    if (role === 'carrier-ingress' || role === 'carrier-egress') return true;
    if (role === undefined || role === 'unknown') return !isPlatformAlias(id);
    return false; // sbc / sbc-vip / media-server are ours by definition
  };

  // ── Pass 1: first activity + failover-aware ORIG/TERM + INVITE roles ──
  const firstActivity = new Map<string, number>();
  const sentInviteExternals = new Set<string>(); // externals that SOURCED an INVITE
  const receivedInviteExternals = new Set<string>(); // externals that RECEIVED one
  let orig: string | null = null;
  let term: string | null = null;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (!firstActivity.has(m.src)) firstActivity.set(m.src, i);
    if (!firstActivity.has(m.dst)) firstActivity.set(m.dst, i);
    if (!m.isInviteRequest) continue;
    if (isExternal(m.src)) {
      sentInviteExternals.add(m.src);
      if (orig === null) orig = m.src; // EARLIEST external-source INVITE
    }
    if (isExternal(m.dst)) {
      receivedInviteExternals.add(m.dst);
      term = m.dst; // LAST externally-destined INVITE wins (failover-aware)
    }
  }
  // One external endpoint only (term folded onto orig) → no rank-7 column.
  if (term !== null && term === orig) term = null;

  // ── Behavioral VIP classification (alias first, then traffic shape) ──
  const isSignalingVip = (id: string): boolean => {
    if (SIGVIP_NAME_RE.test(id)) return true;
    let receivesAnything = false;
    for (const m of messages) {
      if (m.dst === id) {
        receivesAnything = true;
        if (isExternal(m.src)) return false; // fed from the wire → external VIP
      }
      if (m.src === id && isExternal(m.dst)) return false; // talks to carriers
    }
    // Fed exclusively by platform-internal sources (FS → ILB) → signaling VIP.
    // A VIP with no received traffic at all defaults to external (rank 2 tier).
    return receivesAnything;
  };

  // ── Pass 2: rank assignment ──
  const ranks = new Map<string, number>();
  const unresolved: string[] = [];

  for (const p of participants) {
    if (isExternal(p.id)) {
      if (p.id === orig) {
        ranks.set(p.id, RANK_ORIG_EXTERNAL);
      } else if (p.id === term) {
        ranks.set(p.id, RANK_TERM_EXTERNAL);
      } else if (receivedInviteExternals.has(p.id)) {
        // Failed termination attempt — ranks just left of the winning term.
        ranks.set(p.id, RANK_EGRESS_EXTERNAL);
      } else if (sentInviteExternals.has(p.id)) {
        // Sibling origination edge proxy (e.g. Bandwidth duplicate-INVITE
        // sources) — ingress cluster; orig stays leftmost via first activity.
        ranks.set(p.id, RANK_ORIG_EXTERNAL);
      } else {
        unresolved.push(p.id); // external with no INVITE involvement
      }
    } else if (p.role === 'sbc-vip') {
      ranks.set(p.id, isSignalingVip(p.id) ? RANK_SIGNALING_VIP : RANK_EXTERNAL_VIP);
    } else if (p.role === 'sbc') {
      ranks.set(p.id, RANK_SBC_A);
    } else if (p.role === 'media-server') {
      ranks.set(p.id, RANK_MEDIA);
    } else {
      unresolved.push(p.id); // internal unknown (Services, unaliased boxes)
    }
  }

  // ── Pass 3: fractional placement for the unclassifiable ──
  // Each unresolved node takes its first resolved peer's rank ∓ ε (senders sit
  // upstream/left of their receiver), clamped strictly INSIDE the external
  // bookends. Multi-round so chains of unknowns resolve off each other.
  const clampInside = (r: number): number =>
    Math.min(Math.max(r, RANK_ORIG_EXTERNAL + RANK_EPSILON), RANK_TERM_EXTERNAL - RANK_EPSILON);

  let progress = true;
  while (progress && unresolved.length > 0) {
    progress = false;
    for (let i = 0; i < unresolved.length; i++) {
      const id = unresolved[i]!;
      // First directional message touching this node whose peer already has a rank.
      const anchor = messages.find(
        (m) =>
          (m.src === id || m.dst === id) &&
          m.src !== m.dst &&
          ranks.has(m.src === id ? m.dst : m.src),
      );
      if (!anchor) continue;
      const peerRank = ranks.get(anchor.src === id ? anchor.dst : anchor.src)!;
      ranks.set(
        id,
        clampInside(anchor.src === id ? peerRank - RANK_EPSILON : peerRank + RANK_EPSILON),
      );
      unresolved.splice(i, 1);
      progress = true;
      break;
    }
  }
  // Isolated leftovers (self-traffic only, no ranked peer): beside the B2BUA.
  for (const id of unresolved) ranks.set(id, clampInside(RANK_MEDIA + RANK_EPSILON));

  // ── Pass 4: deterministic sort — rank, then first activity, then input order ──
  const inputOrder = new Map<string, number>();
  participants.forEach((p, i) => inputOrder.set(p.id, i));

  const orderedIds = participants
    .map((p) => p.id)
    .sort((a, b) => {
      const rankDiff = ranks.get(a)! - ranks.get(b)!;
      if (rankDiff !== 0) return rankDiff;
      const actDiff =
        (firstActivity.get(a) ?? Number.MAX_SAFE_INTEGER) -
        (firstActivity.get(b) ?? Number.MAX_SAFE_INTEGER);
      if (actDiff !== 0) return actDiff;
      return inputOrder.get(a)! - inputOrder.get(b)!;
    });

  // B-leg virtual SBC columns splice in before the first egress external
  // (failed attempts + term) — i.e. right after the signaling-VIP tier.
  const firstEgress = orderedIds.findIndex((id) => ranks.get(id)! >= RANK_EGRESS_EXTERNAL);
  const bLegInsertIndex = firstEgress === -1 ? orderedIds.length : firstEgress;

  const endpointTags = new Map<string, EndpointTag>();
  if (orig !== null) endpointTags.set(orig, 'orig');
  if (term !== null) endpointTags.set(term, 'term');

  return { orderedIds, bLegInsertIndex, endpointTags };
}
