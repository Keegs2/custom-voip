/**
 * SIP-ladder layout test — ground-truth fixture call.
 *
 * Source of truth: /tests/fixtures/homer_ground_truth_20260610.md — the real
 * production call (2026-06-10 12:08 ET) that rendered BROKEN in the ladder
 * (carrier-in/VIP columns right of FreeSWITCH, 100 Trying above its INVITE,
 * hairpin VIP self-hops drawn as nonsense arrows).
 *
 * The message list below is the post-pipeline API response for that call:
 * one row per unique on-wire hop (multi-capture duplicates already merged by
 * the API's via-branch dedup), with the NEW additive contract fields:
 *   seq           — authoritative display order (0..n-1)
 *   hairpin       — SBC self-hop / VIP re-traversal copies
 *   ts_corrected  — rows whose stored timestamps were ingest-stamped 15-20ms
 *                   late (all three captures of the A-leg INVITE were)
 *
 * Runs computeLayout twice:
 *   1. NEW format (seq present)            — full assertions
 *   2. OLD format (no seq, corrupted ts)   — topology-first columns must
 *      still be correct; message causality must hold via the defensive pass
 *
 * Run: node scripts/run-layout-test.mjs
 */
import type { HomerSearchResult } from '../src/api/homer';
import { computeLayout } from '../src/components/sip-ladder/sipLadderLayout';
import type { LadderLayout } from '../src/components/sip-ladder/sipLadderTypes';

// ─── Fixture data ───────────────────────────────────────────────────────────

const A_LEG = '258530374_92210034@67.231.13.185';
const B_LEG = '7523baca-df89-123f-0b87-4201c0a80a02';

const CORRELATIONS: Record<string, string[]> = {
  [A_LEG]: [A_LEG, B_LEG].sort(),
  [B_LEG]: [A_LEG, B_LEG].sort(),
};

interface Row {
  seq: number;
  ts: number; // timestamp_ns AS STORED (incl. the corrupted ingest stamps)
  method: string;
  status: number | null;
  src: string;
  dst: string;
  callid: string;
  cseq: string;
  node: string;
  hairpin?: boolean;
  ts_corrected?: boolean;
}

// CSeq values are invariant per transaction across proxy hops (RFC 3261).
const A_INV = '20979 INVITE';
const A_ACK = '20979 ACK';
const A_BYE = '20980 BYE';
const B_INV = '124667839 INVITE';
const B_ACK = '124667839 ACK';
const B_BYE = '124667840 BYE';

// Derived from the fixture table: dedup survivor per hop (earliest directional
// capture), stored timestamp kept verbatim — including the corrupted ones.
const ROWS: Row[] = [
  // ── Call setup, A-leg ingress ──
  // The carrier INVITE's stored ts is the INGEST stamp (.725964951) — 16ms
  // late, AFTER the 100 Trying it provoked. seq + ts_corrected fix the order.
  { seq: 0, ts: 1781107707725964951, method: 'INVITE', status: null, src: 'BW-ATL', dst: 'SBC-VIP', callid: A_LEG, cseq: A_INV, node: '100', ts_corrected: true },
  { seq: 1, ts: 1781107707709698000, method: 'INVITE', status: 100, src: 'SBC-VIP', dst: 'BW-ATL', callid: A_LEG, cseq: A_INV, node: '100' },
  { seq: 2, ts: 1781107707725832231, method: 'INVITE', status: null, src: 'SBC-1', dst: 'FreeSWITCH', callid: A_LEG, cseq: A_INV, node: '100,200', ts_corrected: true },
  { seq: 3, ts: 1781107707711764000, method: 'INVITE', status: 100, src: 'FreeSWITCH', dst: 'SBC-1', callid: A_LEG, cseq: A_INV, node: '100,200' },
  // ── B-leg egress ──
  { seq: 4, ts: 1781107707742226000, method: 'INVITE', status: null, src: 'FreeSWITCH', dst: 'SBC-1', callid: B_LEG, cseq: B_INV, node: '100,200' },
  { seq: 5, ts: 1781107707743538000, method: 'INVITE', status: null, src: 'SBC-1', dst: 'BW-DAL', callid: B_LEG, cseq: B_INV, node: '100' },
  { seq: 6, ts: 1781107707743660000, method: 'INVITE', status: 100, src: 'SBC-1', dst: 'FreeSWITCH', callid: B_LEG, cseq: B_INV, node: '100,200' },
  { seq: 7, ts: 1781107707782462000, method: 'INVITE', status: 100, src: 'BW-DAL', dst: 'SBC-1', callid: B_LEG, cseq: B_INV, node: '100' },
  // ── Ringback ──
  { seq: 8, ts: 1781107709185304000, method: 'INVITE', status: 183, src: 'BW-DAL', dst: 'SBC-1', callid: B_LEG, cseq: B_INV, node: '100' },
  { seq: 9, ts: 1781107709185708000, method: 'INVITE', status: 183, src: 'SBC-1', dst: 'FreeSWITCH', callid: B_LEG, cseq: B_INV, node: '100,200' },
  { seq: 10, ts: 1781107709192878000, method: 'INVITE', status: 183, src: 'FreeSWITCH', dst: 'SBC-1', callid: A_LEG, cseq: A_INV, node: '100,200' },
  { seq: 11, ts: 1781107709193498000, method: 'INVITE', status: 183, src: 'SBC-VIP', dst: 'BW-ATL', callid: A_LEG, cseq: A_INV, node: '100' },
  // ── Answer ──
  { seq: 12, ts: 1781107716961399000, method: 'INVITE', status: 200, src: 'BW-DAL', dst: 'SBC-1', callid: B_LEG, cseq: B_INV, node: '100' },
  { seq: 13, ts: 1781107716961845000, method: 'INVITE', status: 200, src: 'SBC-1', dst: 'FreeSWITCH', callid: B_LEG, cseq: B_INV, node: '100,200' },
  { seq: 14, ts: 1781107716963730000, method: 'ACK', status: null, src: 'FreeSWITCH', dst: 'SBC-1', callid: B_LEG, cseq: B_ACK, node: '100,200' },
  // HAIRPIN: B-leg ACK toward BW-DAL re-traverses the SBC's own VIP
  // (inner RR consumed, outer Route = same box) — captured src==dst==SBC-VIP.
  { seq: 15, ts: 1781107716964553000, method: 'ACK', status: null, src: 'SBC-VIP', dst: 'SBC-VIP', callid: B_LEG, cseq: B_ACK, node: '100', hairpin: true },
  { seq: 16, ts: 1781107716968394000, method: 'INVITE', status: 200, src: 'FreeSWITCH', dst: 'SBC-1', callid: A_LEG, cseq: A_INV, node: '100,200' },
  { seq: 17, ts: 1781107716969222690, method: 'INVITE', status: 200, src: 'SBC-VIP', dst: 'BW-ATL', callid: A_LEG, cseq: A_INV, node: '100' },
  { seq: 18, ts: 1781107716982023000, method: 'ACK', status: null, src: 'BW-ATL', dst: 'SBC-VIP', callid: A_LEG, cseq: A_ACK, node: '100' },
  { seq: 19, ts: 1781107716982951000, method: 'ACK', status: null, src: 'SBC-1', dst: 'FreeSWITCH', callid: A_LEG, cseq: A_ACK, node: '200' },
  // ── Teardown (caller hangs up) ──
  { seq: 20, ts: 1781107719831940000, method: 'BYE', status: null, src: 'BW-ATL', dst: 'SBC-VIP', callid: A_LEG, cseq: A_BYE, node: '100' },
  { seq: 21, ts: 1781107719832565000, method: 'BYE', status: null, src: 'SBC-1', dst: 'FreeSWITCH', callid: A_LEG, cseq: A_BYE, node: '100,200' },
  { seq: 22, ts: 1781107719855009000, method: 'BYE', status: 200, src: 'FreeSWITCH', dst: 'SBC-1', callid: A_LEG, cseq: A_BYE, node: '100,200' },
  { seq: 23, ts: 1781107719855154000, method: 'BYE', status: 200, src: 'SBC-VIP', dst: 'BW-ATL', callid: A_LEG, cseq: A_BYE, node: '100' },
  { seq: 24, ts: 1781107719859529000, method: 'BYE', status: null, src: 'FreeSWITCH', dst: 'SBC-1', callid: B_LEG, cseq: B_BYE, node: '100,200' },
  // HAIRPIN: B-leg BYE hop 1 through own VIP (the final BYE to BW-DAL carries
  // TWO SBC Via branches, df74.19b… AND df74.5d4…, proving double traversal).
  { seq: 25, ts: 1781107719860191000, method: 'BYE', status: null, src: 'SBC-VIP', dst: 'SBC-VIP', callid: B_LEG, cseq: B_BYE, node: '100', hairpin: true },
  { seq: 26, ts: 1781107719860949000, method: 'BYE', status: null, src: 'SBC-1', dst: 'BW-DAL', callid: B_LEG, cseq: B_BYE, node: '100' },
  { seq: 27, ts: 1781107719898013000, method: 'BYE', status: 200, src: 'BW-DAL', dst: 'SBC-1', callid: B_LEG, cseq: B_BYE, node: '100' },
  // HAIRPIN: the 200 OK retracing the hairpin (2-Via reply leg)
  { seq: 28, ts: 1781107719898207000, method: 'BYE', status: 200, src: 'SBC-VIP', dst: 'SBC-VIP', callid: B_LEG, cseq: B_BYE, node: '100', hairpin: true },
  { seq: 29, ts: 1781107719898705000, method: 'BYE', status: 200, src: 'SBC-1', dst: 'FreeSWITCH', callid: B_LEG, cseq: B_BYE, node: '100,200' },
];

function isoFromNs(ns: number): string {
  const ms = Math.floor(ns / 1_000_000);
  const micros = String(Math.floor((ns % 1_000_000_000) / 1_000)).padStart(6, '0');
  return new Date(ms).toISOString().replace(/\.\d+Z$/, `.${micros}Z`);
}

/** Builds the NEW-format API response (seq + hairpin + ts_corrected present). */
function buildNewFormat(): HomerSearchResult[] {
  return ROWS.map((r) => ({
    timestamp: isoFromNs(r.ts),
    timestamp_ns: r.ts,
    from_user: '+15087282017',
    to_user: '+16174544217',
    callid: r.callid,
    method: r.method,
    src_ip: r.src,
    dst_ip: r.dst,
    status: r.status,
    node: r.node,
    cseq: r.cseq,
    hairpin: r.hairpin ?? false,
    ts_corrected: r.ts_corrected ?? false,
    seq: r.seq,
    raw_msg: null,
  }));
}

/** Builds the OLD-format response: no seq/hairpin/ts_corrected, corrupted ts. */
function buildOldFormat(): HomerSearchResult[] {
  return ROWS.map((r) => ({
    timestamp: isoFromNs(r.ts),
    timestamp_ns: r.ts,
    from_user: '+15087282017',
    to_user: '+16174544217',
    callid: r.callid,
    method: r.method,
    src_ip: r.src,
    dst_ip: r.dst,
    status: r.status,
    node: r.node,
    cseq: r.cseq,
    raw_msg: null,
  }));
}

// ─── Tiny assertion harness ─────────────────────────────────────────────────

let failures = 0;
let passes = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passes++;
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// ─── Shared assertions ──────────────────────────────────────────────────────

const EXPECTED_COLUMNS = ['BW-ATL', 'SBC-VIP', 'SBC-1', 'FreeSWITCH', 'SBC-1__bleg', 'BW-DAL'];
const EXPECTED_ROLES = ['carrier-ingress', 'sbc-vip', 'sbc', 'media-server', 'sbc', 'carrier-egress'];

function assertColumns(layout: LadderLayout): void {
  const ids = layout.nodes.map((n) => n.id);
  check(
    `column order is [${EXPECTED_COLUMNS.join(' | ')}]`,
    JSON.stringify(ids) === JSON.stringify(EXPECTED_COLUMNS),
    `got [${ids.join(' | ')}]`,
  );
  const roles = layout.nodes.map((n) => n.role);
  check(
    'column roles are carrier-in | LB | SBC | media | SBC | carrier-out',
    JSON.stringify(roles) === JSON.stringify(EXPECTED_ROLES),
    `got [${roles.join(' | ')}]`,
  );
  const mediaIdx = layout.nodes.findIndex((n) => n.role === 'media-server');
  const carrierInIdx = layout.nodes.findIndex((n) => n.role === 'carrier-ingress');
  const vipIdx = layout.nodes.findIndex((n) => n.role === 'sbc-vip');
  check(
    'carrier-in and VIP are LEFT of the media server',
    carrierInIdx >= 0 && vipIdx >= 0 && mediaIdx >= 0 && carrierInIdx < mediaIdx && vipIdx < mediaIdx,
    `carrier-in=${carrierInIdx} vip=${vipIdx} media=${mediaIdx}`,
  );
  const sbcA = layout.nodes.find((n) => n.id === 'SBC-1');
  const sbcB = layout.nodes.find((n) => n.id === 'SBC-1__bleg');
  check(
    'split SBC columns carry A-leg / B-leg header tags',
    sbcA?.legTag === 'a' && sbcB?.legTag === 'b' && sbcB?.displayLabel === 'SBC-1',
    `legTags: ${sbcA?.legTag}/${sbcB?.legTag}`,
  );
}

function assertCausality(layout: LadderLayout, label: string): void {
  // Within one Call-ID + CSeq transaction, no response renders above the
  // transaction's first request row.
  const firstReqIdx = new Map<string, number>();
  layout.messages.forEach((m, i) => {
    if (m.original.status === null) {
      const k = `${m.original.callid}|${m.original.cseq}`;
      if (!firstReqIdx.has(k)) firstReqIdx.set(k, i);
    }
  });
  const violations: string[] = [];
  layout.messages.forEach((m, i) => {
    if (m.original.status === null) return;
    const k = `${m.original.callid}|${m.original.cseq}`;
    const reqIdx = firstReqIdx.get(k);
    if (reqIdx !== undefined && i < reqIdx) {
      violations.push(`row ${i} (${m.label}) above its request at ${reqIdx}`);
    }
  });
  check(`${label}: no response renders above its request`, violations.length === 0, violations.join('; '));
}

function assertHairpins(layout: LadderLayout): void {
  const hairpins = layout.messages.filter((m) => m.isHairpin);
  check('exactly 3 hairpin rows detected', hairpins.length === 3, `got ${hairpins.length}`);
  check(
    'hairpin rows draw no spanning arrow (sourceCol === destCol)',
    hairpins.every((m) => m.sourceCol === m.destCol),
  );
  const bLegSbcCol = layout.nodes.findIndex((n) => n.id === 'SBC-1__bleg');
  check(
    'hairpin self-loops anchor on the B-leg SBC column',
    hairpins.every((m) => m.sourceCol === bLegSbcCol),
    `cols: ${hairpins.map((m) => m.sourceCol).join(',')} expected ${bLegSbcCol}`,
  );
  // Default visible set = hideHairpins ON (the SipLadder default), other filters off.
  const defaultVisible = layout.messages.filter((m) => !m.isHairpin);
  check(
    `hairpins excluded from default visible set (${defaultVisible.length}/${layout.messages.length} shown)`,
    defaultVisible.every((m) => !m.isHairpin) &&
      defaultVisible.length === layout.messages.length - 3,
  );
}

// ─── Test runs ──────────────────────────────────────────────────────────────

export function run(): number {
  console.log('━━━ SIP ladder layout — ground-truth fixture call ━━━');

  // ── 1. NEW format (seq authoritative) ──
  console.log('\n[1] NEW-format response (seq + hairpin + ts_corrected present)');
  const newLayout = computeLayout(buildNewFormat(), CORRELATIONS);

  assertColumns(newLayout);

  const first = newLayout.messages[0];
  check(
    'first rendered row is the A-leg INVITE BW-ATL → SBC-VIP',
    !!first &&
      first.original.method === 'INVITE' &&
      first.original.status === null &&
      first.original.src_ip === 'BW-ATL' &&
      first.original.dst_ip === 'SBC-VIP' &&
      first.leg === 'a' &&
      first.sourceCol === 0 &&
      first.destCol === 1,
    first
      ? `got ${first.label} ${first.original.src_ip}→${first.original.dst_ip} cols ${first.sourceCol}→${first.destCol}`
      : 'no messages',
  );

  check(
    'rows are in seq order',
    newLayout.messages.every((m, i) => m.original.seq === i),
  );

  assertCausality(newLayout, 'new-format');
  assertHairpins(newLayout);

  const corrected = newLayout.messages.filter((m) => m.tsCorrected);
  check(
    'ts_corrected rows carry the corrected marker (both A-leg INVITE hops)',
    corrected.length === 2 && corrected.every((m) => m.original.method === 'INVITE' && m.original.status === null),
    `got ${corrected.length}: ${corrected.map((m) => `${m.original.src_ip}→${m.original.dst_ip}`).join(', ')}`,
  );

  check(
    'A/B leg call-id classification',
    newLayout.aLegCallIds.has(A_LEG) && newLayout.bLegCallIds.has(B_LEG),
  );

  // ── 2. OLD format (no seq, corrupted timestamps) ──
  console.log('\n[2] OLD-format response (no seq, stored timestamps corrupted)');
  const oldLayout = computeLayout(buildOldFormat(), CORRELATIONS);

  assertColumns(oldLayout);
  assertCausality(oldLayout, 'old-format (defensive pass)');
  assertHairpins(oldLayout);

  const moved = oldLayout.messages.filter((m) => m.tsCorrected);
  check(
    'defensive pass marked the rows it moved as corrected',
    moved.length > 0 && moved.every((m) => m.original.status !== null),
    `moved ${moved.length} rows`,
  );

  check(
    'old-format A/B leg classification still correct',
    oldLayout.aLegCallIds.has(A_LEG) && oldLayout.bLegCallIds.has(B_LEG),
  );

  // ── Render preview (what the engineer sees) ──
  console.log('\n[3] New-format render preview (default filters: SBC internal hops hidden)');
  console.log(`    Columns: ${newLayout.nodes.map((n) => `${n.displayLabel ?? n.id}[${n.legTag ? `SBC·${n.legTag.toUpperCase()}-LEG` : n.role}]`).join(' | ')}`);
  for (const m of newLayout.messages) {
    if (m.isHairpin) continue; // hidden by default
    const marker = m.tsCorrected ? '~' : ' ';
    console.log(
      `   ${marker}seq=${String(m.original.seq).padStart(2)} [${m.leg.toUpperCase()}] col${m.sourceCol}→col${m.destCol}  ${m.label}  (${m.original.src_ip} → ${m.original.dst_ip})`,
    );
  }
  console.log(`    (+${newLayout.messages.filter((m) => m.isHairpin).length} SBC internal hops hidden behind the toggle)`);

  console.log(`\n━━━ ${passes} passed, ${failures} failed ━━━`);
  return failures;
}
