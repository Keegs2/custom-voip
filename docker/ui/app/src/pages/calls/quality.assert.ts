import {
  gradeForMos,
  gradeLabel,
  gradeColor,
  mosColor,
  packetLossColor,
  rFactorColor,
  jitterColor,
  percentileCont,
  qualityStatusReason,
  summarizeCallQuality,
  GOOD,
  WARN,
  BAD,
  INK_FAINT,
} from './quality';
import type { CallQualityFields, Grade } from './quality';

// ═════════════════════════════════════════════════════════════════════════════
// quality.assert.ts — dev-only self-test for THE grade definition
// (docs/CALL_QUALITY_ACCURACY_PLAN.md §D). Boundaries are identical to the
// Python ones in tests/test_call_quality_model.py (4.34/4.33, 4.02/4.01,
// 3.60/3.59) so the UI, services/call_quality.py and SQL cq_grade() can never
// disagree on a stored 2-dp MOS.
//
// Same pattern as components/sip-ladder/ladderOrder.assert.ts: there is no JS
// test runner, so executing this module IS the test suite — it throws on the
// first failure. Loaded only through a dev-guarded dynamic import in
// CdrDetailModal.tsx (`import.meta.env.DEV` is statically false in production
// builds, so it is dead-code-eliminated and never ships). By hand:
//
//   npx esbuild src/pages/calls/quality.assert.ts --bundle --format=cjs | node
// ═════════════════════════════════════════════════════════════════════════════

function check(what: string, expected: unknown, actual: unknown): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(
      `[quality self-test] ${what}\n` +
        `  expected: ${JSON.stringify(expected)}\n` +
        `  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

/** [mos, expected grade] — the §D boundary pairs plus the extremes. */
const GRADE_CASES: ReadonlyArray<readonly [number | null, Grade | null]> = [
  [4.5, 'great'],
  [4.41, 'great'], // clean G.711 ceiling
  [4.34, 'great'],
  [4.33, 'good'],
  [4.02, 'good'],
  [4.01, 'fair'],
  [3.6, 'fair'],
  [3.59, 'poor'],
  [1.0, 'poor'],
  [null, null],
];

const LOSS_COLOR_CASES: ReadonlyArray<readonly [number | null, string]> = [
  [0, GOOD], [4, GOOD], [4.01, WARN], [8, WARN], [8.01, BAD], [null, INK_FAINT],
];

const R_COLOR_CASES: ReadonlyArray<readonly [number | null, string]> = [
  [93.2, GOOD], [80, GOOD], [79.99, WARN], [70, WARN], [69.99, BAD], [null, INK_FAINT],
];

const JITTER_COLOR_CASES: ReadonlyArray<readonly [number | null, string]> = [
  [0, GOOD], [20, GOOD], [20.01, WARN], [50, WARN], [50.01, BAD], [null, INK_FAINT],
];

/** Runs every case; throws on the first mismatch. Returns the case count. */
export function runQualitySelfTest(): number {
  let n = 0;

  for (const [mos, grade] of GRADE_CASES) {
    check(`gradeForMos(${mos})`, grade, gradeForMos(mos));
    n++;
  }
  // Float noise must not cross a boundary the stored 2-dp value sits on.
  check('gradeForMos(4.3399999999)', 'great', gradeForMos(4.3399999999));
  check('gradeForMos(NaN)', null, gradeForMos(Number.NaN));
  n += 2;

  // MOS colour is the grade colour — no second threshold set.
  check('mosColor(4.33) == good colour', gradeColor('good'), mosColor(4.33));
  check('mosColor(4.01) == fair colour', WARN, mosColor(4.01));
  check('mosColor(3.59) == poor colour', BAD, mosColor(3.59));
  n += 3;

  for (const [v, c] of LOSS_COLOR_CASES) { check(`packetLossColor(${v})`, c, packetLossColor(v)); n++; }
  for (const [v, c] of R_COLOR_CASES) { check(`rFactorColor(${v})`, c, rFactorColor(v)); n++; }
  for (const [v, c] of JITTER_COLOR_CASES) { check(`jitterColor(${v})`, c, jitterColor(v)); n++; }

  // One-way audio is graded poor but is LABELLED as one-way; ungraded is a dash.
  check('gradeLabel(poor, no_rtp)', 'One-way', gradeLabel('poor', 'no_rtp'));
  check('gradeLabel(fair)', 'Fair', gradeLabel('fair'));
  check('gradeLabel(null, short)', '—', gradeLabel(null, 'short'));
  check('reason(rated)', null, qualityStatusReason('rated', 'customer'));
  check('reason(short, staff)', 'Not graded — call under 5 s', qualityStatusReason('short', 'staff'));
  check('reason(null) = no data', qualityStatusReason('no_data', 'customer'), qualityStatusReason(null, 'customer'));
  n += 6;

  // percentile_cont semantics.
  check('p50 [1,2,3,4]', 2.5, percentileCont([4, 1, 3, 2], 0.5));
  check('p95 [0..100]', 95, percentileCont(Array.from({ length: 101 }, (_, i) => i), 0.95));
  check('p50 []', null, percentileCont([], 0.5));
  n += 3;

  // Call-level summary: one-way counts as graded + poor, never as a MOS.
  const rows: CallQualityFields[] = [
    { call_quality_status: 'rated', call_quality_grade: 'great', call_mos: 4.41 },
    { call_quality_status: 'rated', call_quality_grade: 'good', call_mos: 4.2 },
    { call_quality_status: 'rated', call_quality_grade: 'fair', call_mos: 3.7 },
    { call_quality_status: 'no_rtp', call_quality_grade: 'poor', call_mos: null },
    { call_quality_status: 'short', call_quality_grade: null, call_mos: null },
  ];
  const s = summarizeCallQuality(rows);
  check('summary.graded', 4, s.graded);
  check('summary.goodOrBetter', 2, s.goodOrBetter);
  check('summary.poor (incl one-way)', 1, s.poor);
  check('summary.oneWay', 1, s.oneWay);
  check('summary.goodSharePct', 50, s.goodSharePct);
  check('summary.medianMos', 4.2, s.medianMos);
  n += 6;

  return n;
}

// Execute on module load (the module is only ever loaded in dev / by hand).
const passed = runQualitySelfTest();
console.info(`[quality self-test] ${passed} assertions passed ✓`);
