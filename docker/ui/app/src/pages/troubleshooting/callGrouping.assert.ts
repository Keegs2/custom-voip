import type { HomerLegInfo, HomerSearchResult } from '../../api/homer';
import { computeLayout } from '../../components/sip-ladder/sipLadderLayout';
import {
  deriveCorrelationNotice,
  groupMessagesByCall,
  summarizeAttempts,
  type CallGroup,
} from './callGrouping';

// ═════════════════════════════════════════════════════════════════════════════
// callGrouping.assert.ts — dev-only self-test for one-row-per-call grouping,
// the RESULT / duration / attempts derivation, and the correlation notice.
//
// Regression it pins: a forwarded call rendered as TWO rows (A + B) because
// leg correlation returned nothing, and a failover call (B attempt #1 503,
// #2 200) showed RESULT 503 because the old rule took the HIGHEST status in
// the group. Drives the REAL groupMessagesByCall + computeLayout.
//
// Same execution model as ladderOrder.assert.ts / sipLadderFidelity.assert.ts
// — there is no JS test runner in this repo; this module IS the suite.
// Loaded via a dev-guarded dynamic import in TroubleshootingPage.tsx
// (dead-code-eliminated in production builds), and runnable by hand:
//
//   npx esbuild src/pages/troubleshooting/callGrouping.assert.ts \
//     --bundle --format=cjs | node
// ═════════════════════════════════════════════════════════════════════════════

const A = 'a-leg-1111@67.231.2.12';
const B1 = 'b-leg-attempt-1-2222';
const B2 = 'b-leg-attempt-2-3333';
const OTHER = 'unrelated-call-9999@216.82.238.134';

const BASE_NS = 1_787_000_000_000_000_000;
const MS = 1_000_000;

/** [callid, method, status, src, dst, offsetMs, cseq] */
type Row = readonly [string, string, number | null, string, string, number, string];

function toIso(tsNs: number): string {
  const ms = Math.floor(tsNs / 1_000_000);
  const frac = String(Math.floor((tsNs % 1_000_000_000) / 1_000)).padStart(6, '0');
  return new Date(ms).toISOString().replace(/\.\d+Z$/, `.${frac}Z`);
}

function build(rows: ReadonlyArray<Row>): HomerSearchResult[] {
  // Display order = chronological (seq on every row, like the API pipeline).
  const sorted = [...rows].sort((a, b) => a[5] - b[5]);
  return sorted.map(([callid, method, status, src, dst, offsetMs, cseq], seq) => {
    const tsNs = BASE_NS + offsetMs * MS;
    return {
      timestamp: toIso(tsNs),
      timestamp_ns: tsNs,
      from_user: '+16174544217',
      to_user: '+17744045256',
      callid,
      method,
      status,
      src_ip: src,
      dst_ip: dst,
      node: '100,200',
      cseq,
      seq,
      raw_msg: null,
      attestation: null,
    };
  });
}

// ── Canonical failover call ──────────────────────────────────────────────────
// A: BW-Dallas → SBC-VIP → SBC-1 → FS. FS attempt #1 (B1) → SBC → 503.
// FS attempt #2 (B2) → SBC → BW-Dallas → 180 → 200 at +6 s. Talk 60 s, the
// carrier hangs up the A leg at +66 s; FS tears B2 down; a late BYE
// retransmission on B2 draws 481. Old rule: RESULT = max(503, 481, 200) = 503.
const FAILOVER_ROWS: Row[] = [
  [A, 'INVITE', null, 'BW-Dallas', 'SBC-VIP', 0, '1 INVITE'],
  [A, 'INVITE', 100, 'SBC-VIP', 'BW-Dallas', 2, '1 INVITE'],
  [A, 'INVITE', null, 'SBC-1', 'FreeSWITCH', 3, '1 INVITE'],
  [A, 'INVITE', 100, 'FreeSWITCH', 'SBC-1', 5, '1 INVITE'],
  // attempt #1 — fails fast
  [B1, 'INVITE', null, 'FreeSWITCH', 'SBC-SigVIP', 20, '10 INVITE'],
  [B1, 'INVITE', 100, 'SBC-SigVIP', 'FreeSWITCH', 22, '10 INVITE'],
  [B1, 'INVITE', 503, 'SBC-SigVIP', 'FreeSWITCH', 400, '10 INVITE'],
  [B1, 'ACK', null, 'FreeSWITCH', 'SBC-SigVIP', 401, '10 ACK'],
  // attempt #2 — answered
  [B2, 'INVITE', null, 'FreeSWITCH', 'SBC-SigVIP', 450, '20 INVITE'],
  [B2, 'INVITE', null, 'SBC-1', 'BW-Dallas', 455, '20 INVITE'],
  [B2, 'INVITE', 180, 'BW-Dallas', 'SBC-1', 1500, '20 INVITE'],
  [B2, 'INVITE', 200, 'BW-Dallas', 'SBC-1', 5990, '20 INVITE'],
  [B2, 'INVITE', 200, 'SBC-1', 'FreeSWITCH', 5995, '20 INVITE'],
  [A, 'INVITE', 200, 'FreeSWITCH', 'SBC-1', 6000, '1 INVITE'],
  [A, 'INVITE', 200, 'SBC-VIP', 'BW-Dallas', 6002, '1 INVITE'],
  [A, 'ACK', null, 'BW-Dallas', 'SBC-VIP', 6050, '1 ACK'],
  [B2, 'ACK', null, 'FreeSWITCH', 'SBC-SigVIP', 6010, '20 ACK'],
  // teardown
  [A, 'BYE', null, 'BW-Dallas', 'SBC-VIP', 66_000, '2 BYE'],
  [A, 'BYE', null, 'SBC-1', 'FreeSWITCH', 66_001, '2 BYE'],
  [A, 'BYE', 200, 'FreeSWITCH', 'SBC-1', 66_010, '2 BYE'],
  [B2, 'BYE', null, 'FreeSWITCH', 'SBC-SigVIP', 66_020, '21 BYE'],
  [B2, 'BYE', 200, 'SBC-SigVIP', 'FreeSWITCH', 66_090, '21 BYE'],
  [B2, 'BYE', 481, 'SBC-SigVIP', 'FreeSWITCH', 67_600, '21 BYE'],
];

const FULL_LEGS: Record<string, HomerLegInfo> = {
  [A]: { role: 'A', a_callid: A, attempt: null },
  [B1]: { role: 'B', a_callid: A, attempt: 1 },
  [B2]: { role: 'B', a_callid: A, attempt: 2 },
};

// ─── Assertion runner ───────────────────────────────────────────────────────

function fail(what: string, expected: unknown, actual: unknown): never {
  throw new Error(
    `[callGrouping self-test] ${what}\n` +
      `  expected: ${JSON.stringify(expected)}\n` +
      `  actual:   ${JSON.stringify(actual)}`,
  );
}

function eq(what: string, expected: unknown, actual: unknown): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) fail(what, expected, actual);
}

function only(what: string, groups: CallGroup[]): CallGroup {
  eq(`${what}: group count`, 1, groups.length);
  return groups[0]!;
}

function assertFailoverGroup(what: string, g: CallGroup, totalRows: number): void {
  eq(`${what}: no message lost`, totalRows, g.messages.length);
  eq(`${what}: A leg`, A, g.aLegCallId);
  eq(`${what}: representative is the A-leg initial INVITE`, [A, null], [
    g.representative.callid,
    g.representative.status,
  ]);
  eq(`${what}: RESULT is the A-leg final (a failed attempt never overrides 200)`, 200, g.finalStatus);
  eq(`${what}: duration = A answer (+6.000 s) → A BYE (+66.000 s)`, 60, g.durationSec);
}

export function runCallGroupingSelfTest(): number {
  let checks = 0;
  const failover = build(FAILOVER_ROWS);

  // ── 1. A + 2 B attempts (503 → 200), full legs map, PARTIAL correlations
  //       (X-CID only linked B2) → 1 row, RESULT 200, attempts in order.
  {
    const partialCorr = { [A]: [A, B2], [B2]: [A, B2] };
    const g = only('failover', groupMessagesByCall(failover, partialCorr, FULL_LEGS));
    assertFailoverGroup('failover', g, failover.length);
    eq('failover: attempts in order', [
      { callid: B1, attempt: 1, finalStatus: 503 },
      { callid: B2, attempt: 2, finalStatus: 200 },
    ], g.attempts);
    eq('failover: attempt summary', '503 → 200', summarizeAttempts(g.attempts));

    // Ladder gets EVERY leg (incl. the failed attempt) with A/B lanes.
    const layout = computeLayout(g.messages, g.ladderCorrelations);
    eq('failover ladder: A lane', [A], [...layout.aLegCallIds]);
    eq('failover ladder: B lanes', [B1, B2].sort(), [...layout.bLegCallIds].sort());
    const real = layout.messages.filter((m) => !m.internalHandoff);
    eq('failover ladder: every wire message rendered', failover.length, real.length);
    const order = real.map((m) => m.original.timestamp_ns);
    eq('failover ladder: timestamp order', [...order].sort((a, b) => a - b), order);
    checks += 12;
  }

  // ── 2. B legs linked ONLY via legs (no correlations; A has no legs entry)
  //       → joins A through a_callid; A picked via the B's pointer.
  {
    const bOnlyLegs: Record<string, HomerLegInfo> = {
      [B1]: { role: 'B', a_callid: A, attempt: 1 },
      [B2]: { role: 'B', a_callid: A, attempt: 2 },
    };
    const g = only('legs-only link', groupMessagesByCall(failover, {}, bOnlyLegs));
    assertFailoverGroup('legs-only link', g, failover.length);
    eq('legs-only link: attempts', [1, 2], g.attempts.map((a) => a.attempt));
    checks += 7;
  }

  // ── 3. Old API (no `legs`): correlations drive grouping exactly as before.
  {
    const other = build([
      [OTHER, 'INVITE', null, 'BW-LA', 'SBC-VIP', 100, '1 INVITE'],
      [OTHER, 'INVITE', 486, 'SBC-VIP', 'BW-LA', 900, '1 INVITE'],
    ]);
    const rows = [...failover, ...other];
    const fullCorr = {
      [A]: [A, B1, B2],
      [B1]: [A, B1, B2],
      [B2]: [A, B1, B2],
    };
    const twoArg = groupMessagesByCall(rows, fullCorr);
    const threeArg = groupMessagesByCall(rows, fullCorr, undefined);
    eq('old API: 2-arg ≡ 3-arg(undefined)', twoArg.map((g) => g.callIds), threeArg.map((g) => g.callIds));
    eq('old API: calls', 2, twoArg.length);
    const call = twoArg.find((g) => g.callIds.includes(A));
    if (!call) fail('old API: failover group present', 'present', 'absent');
    assertFailoverGroup('old API', call!, failover.length);
    // Without attempt ordinals, attempts fall back to first-seen time order.
    eq('old API: attempts by time', [
      { callid: B1, attempt: null, finalStatus: 503 },
      { callid: B2, attempt: null, finalStatus: 200 },
    ], call!.attempts);
    const lone = twoArg.find((g) => g.callIds.includes(OTHER))!;
    eq('old API: unrelated call untouched', [[OTHER], 486], [lone.callIds, lone.finalStatus]);

    // No links at all (old API with broken correlation) → split, as today.
    eq('old API, no links: one group per Call-ID', 4, groupMessagesByCall(rows, {}).length);
    checks += 11;
  }

  // ── 4. A-leg final not captured → an INVITE 2xx anywhere still beats the
  //       legacy max-status rule (which would say 503).
  {
    const noAFinal = build(
      FAILOVER_ROWS.filter((r) => !(r[0] === A && r[1] === 'INVITE' && r[2] !== null && r[2] >= 200)),
    );
    const g = only('no A final', groupMessagesByCall(noAFinal, {}, FULL_LEGS));
    eq('no A final: RESULT falls back to the B answer, not 503', 200, g.finalStatus);
    checks += 2;
  }

  // ── 5. Correlation notice (banner flag).
  {
    eq('notice: absent fields (old API)', null, deriveCorrelationNotice({}));
    eq('notice: undefined response', null, deriveCorrelationNotice(undefined));
    eq('notice: ok', null, deriveCorrelationNotice({ correlation_status: 'ok', correlation_reason: null }));
    eq(
      'notice: degraded',
      { status: 'degraded', reason: 'X-CID lookup timed out', truncated: false },
      deriveCorrelationNotice({ correlation_status: 'degraded', correlation_reason: ' X-CID lookup timed out ' }),
    );
    eq(
      'notice: partial, no reason',
      { status: 'partial', reason: null, truncated: false },
      deriveCorrelationNotice({ correlation_status: 'partial', correlation_reason: null }),
    );
    eq(
      'notice: ok but truncated',
      { status: 'ok', reason: null, truncated: true },
      deriveCorrelationNotice({ correlation_status: 'ok', correlation_truncated: true }),
    );
    checks += 6;
  }

  return checks;
}

// Execute on module load (dev / by-hand only, like ladderOrder.assert.ts).
const checked = runCallGroupingSelfTest();
console.info(
  `[callGrouping self-test] ${checked} checks passed — one row per call, RESULT from the A leg, attempts ordered ✓`,
);
