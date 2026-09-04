import { orderLadderColumns } from './ladderOrder';
import type { EndpointTag, OrderParticipant, OrderWireMessage } from './ladderOrder';
import { classifyNodeRole } from './sipLadderUtils';

// ═════════════════════════════════════════════════════════════════════════════
// ladderOrder.assert.ts — dev-only self-test for the canonical column ordering.
//
// There is no JS test runner in this repo, so this module IS the test suite:
// executing it runs every fixture and throws (with a full diff) on the first
// failure. It is loaded exactly one way in the app — a dev-guarded dynamic
// import at the top of SipLadder.tsx (`import.meta.env.DEV` is statically
// `false` in production builds, so the whole module is dead-code-eliminated
// and never ships). It is also plain enough to bundle-and-node-execute:
//
//   npx esbuild src/components/sip-ladder/ladderOrder.assert.ts \
//     --bundle --format=cjs | node
//
// Fixtures derive participant roles through the REAL classifier
// (classifyNodeRole) so they exercise exactly what computeLayout feeds the
// ordering function.
// ═════════════════════════════════════════════════════════════════════════════

/** Fixture wire row: [src, dst, isInviteRequest?]. */
type WireRow = readonly [string, string, boolean?];

interface Fixture {
  name: string;
  wire: ReadonlyArray<WireRow>;
  /** Expected physical column order (before the dual-leg B-column splice). */
  expectedOrder: ReadonlyArray<string>;
  /** Expected splice index for B-leg virtual SBC columns. */
  expectedBLegInsertIndex: number;
  /** Expected orig/term endpoint designations. */
  expectedTags: Readonly<Record<string, EndpointTag>>;
}

/** Builds participants (discovery order, real classifier) + messages from wire rows. */
function buildInputs(wire: ReadonlyArray<WireRow>): {
  participants: OrderParticipant[];
  messages: OrderWireMessage[];
} {
  const seen = new Set<string>();
  const participants: OrderParticipant[] = [];
  const messages: OrderWireMessage[] = [];
  for (const [src, dst, isInviteRequest] of wire) {
    for (const id of [src, dst]) {
      if (!seen.has(id)) {
        seen.add(id);
        participants.push({ id, role: classifyNodeRole(id) });
      }
    }
    messages.push({ src, dst, isInviteRequest: isInviteRequest === true });
  }
  return { participants, messages };
}

const FIXTURES: ReadonlyArray<Fixture> = [
  {
    // The operator screenshot's exact call: Sinch orig into West, Sinch term
    // out. Broken render was first-appearance order with the term carrier
    // mid-ladder and the SigVIP left of FS. Canonical physical order below;
    // after the dual-leg split the full 7-column ladder reads:
    //   Sinch-Denver | West-SBC-VIP | West-SBC-2 (A-LEG) | West-FreeSWITCH |
    //   West-SBC-SigVIP | West-SBC-2 (B-LEG) | Sinch-Atlanta-LD
    name: 'screenshot: Sinch→West→Sinch (7-column case)',
    wire: [
      ['Sinch-Denver', 'West-SBC-VIP', true], // carrier INVITE into the NLB VIP
      ['West-SBC-VIP', 'Sinch-Denver'], //       100 Trying
      ['West-SBC-2', 'West-FreeSWITCH', true], // A-leg SBC → FS :5080
      ['West-FreeSWITCH', 'West-SBC-2'], //      100 Trying
      ['West-FreeSWITCH', 'West-SBC-SigVIP', true], // B-leg out via signaling ILB
      ['West-SBC-SigVIP', 'West-FreeSWITCH'], // 100 Trying
      ['West-SBC-2', 'Sinch-Atlanta-LD', true], // B-leg INVITE to term carrier
      ['Sinch-Atlanta-LD', 'West-SBC-2'], //     180 Ringing
    ],
    expectedOrder: [
      'Sinch-Denver',
      'West-SBC-VIP',
      'West-SBC-2',
      'West-FreeSWITCH',
      'West-SBC-SigVIP',
      'Sinch-Atlanta-LD',
    ],
    expectedBLegInsertIndex: 5, // B-leg SBC column lands between SigVIP and Sinch-Atlanta-LD
    expectedTags: { 'Sinch-Denver': 'orig', 'Sinch-Atlanta-LD': 'term' },
  },
  {
    // Trunk delivery: BW origination, terminal is a customer PBX (raw public
    // IP, no alias). The PBX must bookend RIGHT (rank 7) despite being
    // role-'unknown'.
    name: 'trunk delivery: BW orig → customer PBX term',
    wire: [
      ['BW-NY', 'SBC-VIP', true],
      ['SBC-VIP', 'BW-NY'],
      ['SBC-1', 'FreeSWITCH', true],
      ['FreeSWITCH', 'SBC-1'],
      ['FreeSWITCH', 'SBC-SigVIP', true],
      ['SBC-1', '203.0.113.50', true], // trunk delivery to the PBX
      ['203.0.113.50', 'SBC-1'],
    ],
    expectedOrder: ['BW-NY', 'SBC-VIP', 'SBC-1', 'FreeSWITCH', 'SBC-SigVIP', '203.0.113.50'],
    expectedBLegInsertIndex: 5,
    expectedTags: { 'BW-NY': 'orig', '203.0.113.50': 'term' },
  },
  {
    // Inbound-only failed call: no externally-destined INVITE ever leaves the
    // platform → no term column, no rank-7; splice index degrades to length.
    name: 'inbound-only: failed call, no term leg',
    wire: [
      ['BW-ATL', 'SBC-VIP', true],
      ['SBC-VIP', 'BW-ATL'],
      ['SBC-1', 'FreeSWITCH', true],
      ['FreeSWITCH', 'SBC-1'], // 404
    ],
    expectedOrder: ['BW-ATL', 'SBC-VIP', 'SBC-1', 'FreeSWITCH'],
    expectedBLegInsertIndex: 4,
    expectedTags: { 'BW-ATL': 'orig' },
  },
  {
    // Carrier failover: two term attempts. The LAST externally-destined INVITE
    // (BW-LA) wins term and bookends rightmost; the failed attempt (BW-DAL)
    // ranks just left of it.
    name: 'failover: two term attempts — last wins, failed just left of it',
    wire: [
      ['BW-NY', 'SBC-VIP', true],
      ['SBC-1', 'FreeSWITCH', true],
      ['FreeSWITCH', 'SBC-SigVIP', true],
      ['SBC-1', 'BW-DAL', true], // attempt 1
      ['BW-DAL', 'SBC-1'], //       503
      ['SBC-1', 'BW-LA', true], //  attempt 2 — the terminating leg
      ['BW-LA', 'SBC-1'], //        180
    ],
    expectedOrder: ['BW-NY', 'SBC-VIP', 'SBC-1', 'FreeSWITCH', 'SBC-SigVIP', 'BW-DAL', 'BW-LA'],
    expectedBLegInsertIndex: 5, // B-leg SBC lands left of BOTH egress externals
    expectedTags: { 'BW-NY': 'orig', 'BW-LA': 'term' },
  },
  {
    // Legacy zone (pre-SigVIP): FS bridges to the SBC's direct IP. No rank-5
    // column; the B-leg splice point falls straight after FreeSWITCH.
    name: 'legacy zone: no SigVIP',
    wire: [
      ['BW-NY', 'SBC-VIP', true],
      ['SBC-1', 'FreeSWITCH', true],
      ['FreeSWITCH', 'SBC-1', true], // B-leg direct to SBC (no ILB)
      ['SBC-1', 'BW-DAL', true],
      ['BW-DAL', 'SBC-1'],
    ],
    expectedOrder: ['BW-NY', 'SBC-VIP', 'SBC-1', 'FreeSWITCH', 'BW-DAL'],
    expectedBLegInsertIndex: 4,
    expectedTags: { 'BW-NY': 'orig', 'BW-DAL': 'term' },
  },
  {
    // Behavioral VIP fallback: two VIPs, NEITHER carries SigVIP naming (a
    // future zone alias miss). VIP-A receives from the carrier → external VIP
    // (rank 2). VIP-B is only ever fed by FreeSWITCH → signaling VIP (rank 5).
    name: 'behavioral fallback: unaliased signaling VIP still orders correctly',
    wire: [
      ['BW-DAL', 'Texas-SBC-VIP-A', true],
      ['Texas-SBC-1', 'Texas-FreeSWITCH', true],
      ['Texas-FreeSWITCH', 'Texas-SBC-VIP-B', true], // internal-only feed
      ['Texas-SBC-VIP-B', 'Texas-FreeSWITCH'], //       100 Trying
      ['Texas-SBC-1', 'BW-LA', true],
    ],
    expectedOrder: [
      'BW-DAL',
      'Texas-SBC-VIP-A',
      'Texas-SBC-1',
      'Texas-FreeSWITCH',
      'Texas-SBC-VIP-B',
      'BW-LA',
    ],
    expectedBLegInsertIndex: 5,
    expectedTags: { 'BW-DAL': 'orig', 'BW-LA': 'term' },
  },
];

// ─── Assertion runner ───────────────────────────────────────────────────────

function fail(fixture: string, what: string, expected: unknown, actual: unknown): never {
  throw new Error(
    `[ladderOrder self-test] FIXTURE "${fixture}" — ${what}\n` +
      `  expected: ${JSON.stringify(expected)}\n` +
      `  actual:   ${JSON.stringify(actual)}`,
  );
}

/** Runs every fixture; throws on the first mismatch. Returns fixture count. */
export function runLadderOrderSelfTest(): number {
  for (const f of FIXTURES) {
    const { participants, messages } = buildInputs(f.wire);
    const result = orderLadderColumns(participants, messages);

    if (JSON.stringify(result.orderedIds) !== JSON.stringify(f.expectedOrder)) {
      fail(f.name, 'column order mismatch', f.expectedOrder, result.orderedIds);
    }
    if (result.bLegInsertIndex !== f.expectedBLegInsertIndex) {
      fail(f.name, 'B-leg splice index mismatch', f.expectedBLegInsertIndex, result.bLegInsertIndex);
    }
    const actualTags = Object.fromEntries(result.endpointTags);
    if (JSON.stringify(actualTags) !== JSON.stringify(f.expectedTags)) {
      fail(f.name, 'endpoint tag mismatch', f.expectedTags, actualTags);
    }
  }
  return FIXTURES.length;
}

// Execute on module load (the module is only ever loaded in dev / by hand).
const passed = runLadderOrderSelfTest();
console.info(`[ladderOrder self-test] ${passed}/${FIXTURES.length} fixtures passed ✓`);
