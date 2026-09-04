import type { HomerSearchResult } from '../../api/homer';
import { computeLayout } from './sipLadderLayout';
import { groupMessagesByCall } from '../../pages/troubleshooting/callGrouping';

// ═════════════════════════════════════════════════════════════════════════════
// sipLadderFidelity.assert.ts — dev-only data-fidelity self-test for the SIP
// ladder: the REAL call grouping (pages/troubleshooting/callGrouping.ts) and
// the REAL layout engine (computeLayout) are driven with a synthetic replay of
// the operator-reported West Sinch→Sinch call (2026-09):
//
//   A-leg 51127909_111588655@206.146.100.24
//         Sinch-Denver → West-SBC-VIP → West-SBC-2 → West-FreeSWITCH
//   B-leg bd645f41-22e0-1240-11ad-4201c0a81402
//         West-FreeSWITCH → West-SBC-SigVIP → West-SBC-2 → Sinch-Atlanta-LD
//
// The fixture is the API pipeline's OUTPUT shape (post-dedup: one row per
// distinct wire message, per-capture pairs merged into node "110,210", seq
// assigned) including a full teardown cascade and an RFC 3261 retransmission
// round at +1.5 s (T1-doubling schedule).  Contract asserted:
//
//   1. Grouping: both legs union into ONE call group, no message lost.
//   2. Ladder: every message renders exactly one arrow on its correct hop
//      (source/dest columns resolve to the message's own src/dst aliases) —
//      nothing silently dropped, no non-hairpin row collapses to a dot.
//   3. Retransmissions: the +1.5 s copies are flagged isRetransmission (so
//      ONLY the explicit "Hide Retransmissions" toggle governs them).  The
//      old fixed 500 ms window missed every copy after the first, so
//      T1-doubled retransmits rendered unflagged.
//
// Same execution model as ladderOrder.assert.ts — there is no JS test runner
// in this repo; this module IS the suite.  Loaded via a dev-guarded dynamic
// import in SipLadder.tsx (dead-code-eliminated in production builds), and
// bundle-and-node-executable by hand:
//
//   npx esbuild src/components/sip-ladder/sipLadderFidelity.assert.ts \
//     --bundle --format=cjs | node
// ═════════════════════════════════════════════════════════════════════════════

const A = '51127909_111588655@206.146.100.24';
const B = 'bd645f41-22e0-1240-11ad-4201c0a81402';

const CORRELATIONS: Record<string, string[]> = { [A]: [A, B], [B]: [A, B] };

const BASE_NS = 1_787_000_000_000_000_000;
const MS = 1_000_000;

interface FixtureRow {
  /** [callid, method, status, src, dst, offsetMs, viaBranch, cseq, node] */
  row: readonly [string, string, number | null, string, string, number, string, string, string];
  /** True for the retransmission-round copies (must carry the retrans flag). */
  expectRetrans?: boolean;
}

// Via branches — per-hop transaction fingerprints (as the API extracts them).
const A_INV_C = 'z9hG4bKsnchinv01';
const A_INV_S = 'z9hG4bK5cd1.inv.0';
const B_INV_F = 'z9hG4bKfsBlegInv';
const B_INV_S = 'z9hG4bK9df2.binv.0';
const A_BYE_C = 'z9hG4bKsnch77bye01';
const A_BYE_S = 'z9hG4bK5cd1.a1f7bye.0';
const B_BYE_F = 'z9hG4bKQm3vDgFXKp2Sa';
const B_BYE_S = 'z9hG4bK9df2.bleg0aa.0';

function teardownRound(offsetMs: number, expectRetrans: boolean): FixtureRow[] {
  const t = offsetMs;
  return [
    // A-leg: carrier BYE → VIP; SBC BYE → FS (merged capture pair); 200s back
    { row: [A, 'BYE', null, 'Sinch-Denver', 'West-SBC-VIP', t, A_BYE_C, '103 BYE', '110'], expectRetrans },
    { row: [A, 'BYE', null, 'West-SBC-2', 'West-FreeSWITCH', t + 1, A_BYE_S, '103 BYE', '110,210'], expectRetrans },
    { row: [A, 'BYE', 200, 'West-FreeSWITCH', 'West-SBC-2', t + 20, A_BYE_S, '103 BYE', '110,210'], expectRetrans },
    { row: [A, 'BYE', 200, 'West-SBC-VIP', 'Sinch-Denver', t + 21, A_BYE_C, '103 BYE', '110'], expectRetrans },
    // B-leg: FS BYE → SigVIP; SBC BYE → Sinch-Atlanta (long-span); 200s back
    { row: [B, 'BYE', null, 'West-FreeSWITCH', 'West-SBC-SigVIP', t + 30, B_BYE_F, '79 BYE', '110,210'], expectRetrans },
    { row: [B, 'BYE', null, 'West-SBC-2', 'Sinch-Atlanta-LD', t + 31, B_BYE_S, '79 BYE', '110'], expectRetrans },
    { row: [B, 'BYE', 200, 'Sinch-Atlanta-LD', 'West-SBC-2', t + 70, B_BYE_S, '79 BYE', '110'], expectRetrans },
    { row: [B, 'BYE', 200, 'West-SBC-2', 'West-FreeSWITCH', t + 71, B_BYE_F, '79 BYE', '110,210'], expectRetrans },
  ];
}

const FIXTURE: FixtureRow[] = [
  // ── Setup (compact but leg-complete: drives column ordering + leg split) ──
  { row: [A, 'INVITE', null, 'Sinch-Denver', 'West-SBC-VIP', 0, A_INV_C, '102 INVITE', '110'] },
  { row: [A, 'INVITE', 100, 'West-SBC-VIP', 'Sinch-Denver', 2, A_INV_C, '102 INVITE', '110'] },
  { row: [A, 'INVITE', null, 'West-SBC-2', 'West-FreeSWITCH', 3, A_INV_S, '102 INVITE', '110,210'] },
  { row: [A, 'INVITE', 100, 'West-FreeSWITCH', 'West-SBC-2', 5, A_INV_S, '102 INVITE', '110,210'] },
  { row: [B, 'INVITE', null, 'West-FreeSWITCH', 'West-SBC-SigVIP', 20, B_INV_F, '51 INVITE', '110,210'] },
  { row: [B, 'INVITE', 100, 'West-SBC-SigVIP', 'West-FreeSWITCH', 22, B_INV_F, '51 INVITE', '110,210'] },
  { row: [B, 'INVITE', null, 'West-SBC-2', 'Sinch-Atlanta-LD', 25, B_INV_S, '51 INVITE', '110'] },
  { row: [B, 'INVITE', 180, 'Sinch-Atlanta-LD', 'West-SBC-2', 900, B_INV_S, '51 INVITE', '110'] },
  { row: [B, 'INVITE', 200, 'Sinch-Atlanta-LD', 'West-SBC-2', 4000, B_INV_S, '51 INVITE', '110'] },
  { row: [B, 'INVITE', 200, 'West-SBC-2', 'West-FreeSWITCH', 4002, B_INV_F, '51 INVITE', '110,210'] },
  { row: [A, 'INVITE', 200, 'West-FreeSWITCH', 'West-SBC-2', 4005, A_INV_S, '102 INVITE', '110,210'] },
  { row: [A, 'INVITE', 200, 'West-SBC-VIP', 'Sinch-Denver', 4006, A_INV_C, '102 INVITE', '110'] },
  // ── Teardown at +20 s: original cascade + T1-doubled retransmission round ─
  ...teardownRound(20_000, false),
  ...teardownRound(21_500, true), // +1.5 s — outside the old 500 ms window
];

function toIso(tsNs: number): string {
  const ms = Math.floor(tsNs / 1_000_000);
  const frac = String(Math.floor((tsNs % 1_000_000_000) / 1_000)).padStart(6, '0');
  return new Date(ms).toISOString().replace(/\.\d+Z$/, `.${frac}Z`);
}

function buildMessages(): HomerSearchResult[] {
  return FIXTURE.map((f, seq) => {
    const [callid, method, status, src, dst, offsetMs, viaBranch, cseq, node] = f.row;
    const tsNs = BASE_NS + offsetMs * MS;
    return {
      timestamp: toIso(tsNs),
      timestamp_ns: tsNs,
      from_user: '+15305480845',
      to_user: '+15305480846',
      callid,
      method,
      status,
      src_ip: src,
      dst_ip: dst,
      node,
      cseq,
      via_branch: viaBranch,
      hairpin: false,
      ts_corrected: false,
      seq,
      raw_msg: null,
      attestation: null,
    };
  });
}

// ─── Assertion runner ───────────────────────────────────────────────────────

function fail(what: string, expected: unknown, actual: unknown): never {
  throw new Error(
    `[sipLadderFidelity self-test] ${what}\n` +
      `  expected: ${JSON.stringify(expected)}\n` +
      `  actual:   ${JSON.stringify(actual)}`,
  );
}

/** Physical node label for a ladder column (B-leg clones carry displayLabel). */
function physicalLabel(
  nodes: ReadonlyArray<{ id: string; displayLabel?: string }>,
  col: number,
): string {
  const node = nodes[col];
  if (!node) fail('column index out of range', `< ${nodes.length}`, col);
  return node.displayLabel ?? node.id;
}

export function runSipLadderFidelitySelfTest(): number {
  const messages = buildMessages();

  // ── 1. REAL grouping: one call, both legs, zero message loss ──
  const groups = groupMessagesByCall(messages, CORRELATIONS);
  if (groups.length !== 1) {
    fail('group count', 1, groups.length);
  }
  const group = groups[0]!;
  if (group.messages.length !== messages.length) {
    fail('grouped message count', messages.length, group.messages.length);
  }
  if ([...group.callIds].sort().join(',') !== [A, B].sort().join(',')) {
    fail('group call-ids', [A, B], group.callIds);
  }

  // ── 2. REAL layout: every message renders one arrow on its correct hop ──
  const layout = computeLayout(group.messages, CORRELATIONS);
  const realRows = layout.messages.filter((m) => !m.internalHandoff);
  if (realRows.length !== messages.length) {
    fail(
      'ladder dropped/duplicated rows (non-connector count)',
      messages.length,
      realRows.length,
    );
  }

  // Expected 7-column physical order (canonical packet path after the
  // dual-leg SBC split — same call as ladderOrder.assert's screenshot case).
  const expectedColumns = [
    'Sinch-Denver',
    'West-SBC-VIP',
    'West-SBC-2',
    'West-FreeSWITCH',
    'West-SBC-SigVIP',
    'West-SBC-2',
    'Sinch-Atlanta-LD',
  ];
  const actualColumns = layout.nodes.map((n) => n.displayLabel ?? n.id);
  if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) {
    fail('column order', expectedColumns, actualColumns);
  }

  for (const row of realRows) {
    const src = physicalLabel(layout.nodes, row.sourceCol);
    const dst = physicalLabel(layout.nodes, row.destCol);
    const orig = row.original;
    if (src !== orig.src_ip || dst !== orig.dst_ip) {
      fail(
        `hop mismatch for ${orig.method}${orig.status !== null ? ` ${orig.status}` : ''} @seq=${orig.seq}`,
        `${orig.src_ip} -> ${orig.dst_ip}`,
        `${src} -> ${dst}`,
      );
    }
    if (!row.isHairpin && row.sourceCol === row.destCol) {
      fail(`non-hairpin row collapsed to a dot @seq=${orig.seq}`, 'distinct columns', row.sourceCol);
    }
  }

  // ── 3. Retransmission flags: the +1.5 s round is flagged, originals not ──
  const bySeq = new Map(realRows.map((m) => [m.original.seq!, m]));
  FIXTURE.forEach((f, seq) => {
    const row = bySeq.get(seq);
    if (!row) fail(`fixture row seq=${seq} missing from ladder`, 'present', 'absent');
    const expect = f.expectRetrans === true;
    if (row!.isRetransmission !== expect) {
      const [callid, method, status, src, dst] = f.row;
      fail(
        `isRetransmission for ${method}${status !== null ? ` ${status}` : ''} ` +
          `${src} -> ${dst} (${callid === A ? 'A' : 'B'}-leg, seq=${seq})`,
        expect,
        row!.isRetransmission,
      );
    }
  });

  // Retransmissions must be VISIBLE by default (governed only by the explicit
  // toggle): they are real rows in layout.messages, not filtered here.
  const retransCount = realRows.filter((m) => m.isRetransmission).length;
  if (retransCount !== 8) {
    fail('retransmission-flagged row count', 8, retransCount);
  }

  return realRows.length;
}

// Execute on module load (dev / by-hand only, like ladderOrder.assert.ts).
const checked = runSipLadderFidelitySelfTest();
console.info(
  `[sipLadderFidelity self-test] ${checked} rows verified — every wire message on its hop, retransmissions flagged ✓`,
);
