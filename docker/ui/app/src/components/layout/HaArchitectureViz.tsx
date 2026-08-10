import { type CSSProperties, useId, useMemo } from 'react';

/**
 * HaArchitectureViz
 *
 * SVG-based animated diagram visualising the Granite CRAG (Call Routing
 * Application Gateway) HA call-routing architecture in a horizontal
 * left-to-right flow.
 *
 * Architecture (each location has two discrete SBC nodes):
 *
 *                                    ┌─ Granite East: [SBC-1][SBC-2] → [CRAG] ──┐
 *  [Inbound] → [Key Distributor] ────┼─ Granite Central:[SBC-1][SBC-2]→ [CRAG] ──┼→ [Dallas]
 *    Trunk      Primary (active)     └─ Granite West:  [SBC-1][SBC-2] → [CRAG] ──┤→ [LA]
 *               Hot Backup (standby)                                              └→ [Backup]
 *
 * Failover simulation — a 50-second CSS keyframe cycle drives five scenarios:
 *   0–5s    Normal operation
 *   5–10s   SBC-2 in Granite Central fails → traffic reroutes through SBC-1
 *  10–15s   Normal operation
 *  15–20s   Granite West datacenter fails → traffic reroutes to East + Central
 *  20–25s   Normal operation
 *  25–30s   Dallas trunk fails → outbound reroutes to LA + Backup
 *  30–35s   Normal operation
 *  35–40s   SBC-1 in Granite East fails → traffic reroutes through SBC-2
 *  40–45s   Normal operation
 *  45–50s   Primary Key Distributor fails → Hot Backup takes over
 *
 * The two Key Distributors represent redundant GCP Global Load Balancers
 * with independent anycast VIPs sharing the same SBC backends.
 *
 * Status indicator at top-centre shows current failover state.
 * Pure SVG + CSS animations. No JavaScript timers, no requestAnimationFrame.
 */

/* ─── Geometry constants ─────────────────────────────────────────────── */

const VB_W = 1200;
const VB_H = 540;

// Column x-positions
const COL = {
  inbound: 74,    // Stage 1: inbound trunk node
  nlb:     248,   // Stage 2: NLB / geo-router
  locIn:   400,   // left edge of location containers
  locOut:  775,   // right edge of location containers
  sbc1X:   490,   // SBC-1 node centre (upper SBC within location)
  sbc2X:   490,   // SBC-2 node centre — same X as SBC-1, stacked vertically
  ksX:     700,   // CRAG engine node centre (right of SBC column)
  termX:   1105,  // Stage 4: termination trunk nodes (near right edge of 1200px viewBox)
} as const;

// Row y-centres for each geographic location.
// Spacing of 164px between rows; LOC_HALF_H=76 → 12px inter-container gap.
const LOC_Y = [124, 288, 452] as const;  // Granite East, Granite Central, Granite West
const LOC_HALF_H = 76;                    // half-height of each location container
const LOC_W = COL.locOut - COL.locIn;    // 375px
const LOC_TITLE_H = 26;                   // region title-bar height inside container

// SBC node offsets within a location (relative to location centre y).
const SBC_OFFSET = 30; // SBC-1 is cy-30, SBC-2 is cy+30

// Termination trunk y-positions — slightly inset from the location row span
// so the convergence fan keeps a gentle sweep.
const TERM_Y = [140, 288, 436] as const;  // Dallas, LA, Backup

// Inbound trunk y-centres — centred on the KD pair midpoint (288).
const TRUNK_Y = [233, 343] as const;

// Key Distributor y-positions — stacked vertically at the NLB column.
// Primary is above centre, backup is below. Both converge toward the NLB x column.
const KD_PRIMARY_Y = 236;  // primary — above centre row, clear of backup
const KD_BACKUP_Y  = 340;  // backup  — 104px below primary, clear visual separation

/* ─── SVG path helpers ───────────────────────────────────────────────── */

function quadPath(
  x1: number, y1: number,
  cpX: number, cpY: number,
  x2: number, y2: number,
): string {
  return `M ${x1} ${y1} Q ${cpX} ${cpY} ${x2} ${y2}`;
}

function cubicPath(
  x1: number, y1: number,
  cp1X: number, cp1Y: number,
  cp2X: number, cp2Y: number,
  x2: number, y2: number,
): string {
  return `M ${x1} ${y1} C ${cp1X} ${cp1Y} ${cp2X} ${cp2Y} ${x2} ${y2}`;
}

/** Rectangle with only the top two corners rounded — region title bars. */
function topRoundedRect(
  x: number, y: number,
  w: number, h: number,
  r: number,
): string {
  return `M ${x} ${y + h} V ${y + r} Q ${x} ${y} ${x + r} ${y} H ${x + w - r} Q ${x + w} ${y} ${x + w} ${y + r} V ${y + h} Z`;
}

/* ─── Failover group taxonomy ────────────────────────────────────────── */
/**
 * Each path and packet belongs to one failover group.
 * During a failure event the relevant group gets a CSS animation that
 * drives opacity to 0 via the master 80-second keyframe cycle.
 *
 * Primary path groups (visible normally, invisible during KD failure):
 *   The entire primary-KD layer is wrapped in a <g> with a CSS animation
 *   that hides it during 90-100% — no need for individual path changes.
 *
 * Groups:
 *   'normal'              — always visible (within primary layer)
 *   'sbc2-central'        — SBC-2 Granite Central (fails 10-20%)
 *   'west-loc'            — entire Granite West datacenter (fails 30-40%)
 *   'term-dallas'         — Dallas termination trunk (fails 50-60%)
 *   'west-loc-or-dallas'  — hides during BOTH west AND dallas failures
 *   'sbc1-east'           — SBC-1 Granite East (fails 70-80%)
 *
 * Reroute groups (only visible during their paired failure):
 *   'reroute-sbc2central' — extra packets through SBC-1 central when SBC-2 fails
 *   'reroute-west'        — extra packets through East/Central when West fails
 *   'reroute-dallas'      — extra packets through LA/Backup when Dallas fails
 *   'reroute-sbc1east'    — extra packets through SBC-2 east when SBC-1 fails
 *   'reroute-kd'          — backup KD paths + packets (only visible 90-100%)
 */
type FailoverGroup =
  | 'normal'
  | 'sbc2-central'
  | 'west-loc'
  | 'term-dallas'
  | 'west-loc-or-dallas'
  | 'sbc1-east'
  | 'reroute-sbc2central'
  | 'reroute-west'
  | 'reroute-dallas'
  | 'reroute-sbc1east'
  | 'reroute-kd';

interface PathDef {
  id: string;
  d: string;
  group: FailoverGroup;
}

/* ─── Path definitions ───────────────────────────────────────────────── */

// Stage 1→2: Dual inbound trunks → Primary Key Distributor
// Trunk 1 (upper) and Trunk 2 (lower) fan into primary KD at KD_PRIMARY_Y.
// TRUNK_Y is centred on the KD pair midpoint.
const PATH_INBOUND1_NLB: PathDef = {
  id: 'in1-nlb',
  group: 'normal',
  d: quadPath(COL.inbound + 32, TRUNK_Y[0], (COL.inbound + COL.nlb) / 2, TRUNK_Y[0] - 4, COL.nlb - 32, KD_PRIMARY_Y),
};
const PATH_INBOUND2_NLB: PathDef = {
  id: 'in2-nlb',
  group: 'normal',
  d: quadPath(COL.inbound + 32, TRUNK_Y[1], (COL.inbound + COL.nlb) / 2, TRUNK_Y[1] + 4, COL.nlb - 32, KD_PRIMARY_Y),
};

// Stage 1→2 (backup): Dual inbound trunks → Backup Key Distributor (reroute-kd only)
const PATH_INBOUND1_BACKUP: PathDef = {
  id: 'in1-bkd',
  group: 'reroute-kd',
  d: quadPath(COL.inbound + 32, TRUNK_Y[0], (COL.inbound + COL.nlb) / 2, TRUNK_Y[0] + 18, COL.nlb - 32, KD_BACKUP_Y),
};
const PATH_INBOUND2_BACKUP: PathDef = {
  id: 'in2-bkd',
  group: 'reroute-kd',
  d: quadPath(COL.inbound + 32, TRUNK_Y[1], (COL.inbound + COL.nlb) / 2, TRUNK_Y[1] + 6, COL.nlb - 32, KD_BACKUP_Y),
};

// Stage 2→3: Primary NLB → SBC-1 and SBC-2 for each location
function makeNlbToSbc(
  locIdx: number,
  sbcNum: 1 | 2,
  group: FailoverGroup,
  id: string,
): PathDef {
  const sbcOffset = sbcNum === 1 ? -SBC_OFFSET : SBC_OFFSET;
  const locY = LOC_Y[locIdx];
  const targetY = locY + sbcOffset;
  const cpX = (COL.nlb + COL.sbc1X) / 2;
  return {
    id,
    group,
    d: quadPath(COL.nlb + 32, KD_PRIMARY_Y, cpX, targetY, COL.sbc1X - 24, targetY),
  };
}

const PATH_NLB_E1: PathDef  = makeNlbToSbc(0, 1, 'sbc1-east',   'nlb-e1');
const PATH_NLB_E2: PathDef  = makeNlbToSbc(0, 2, 'normal',      'nlb-e2');
const PATH_NLB_C1: PathDef  = makeNlbToSbc(1, 1, 'normal',      'nlb-c1');
const PATH_NLB_C2: PathDef  = makeNlbToSbc(1, 2, 'sbc2-central','nlb-c2');
const PATH_NLB_W1: PathDef  = makeNlbToSbc(2, 1, 'west-loc',    'nlb-w1');
const PATH_NLB_W2: PathDef  = makeNlbToSbc(2, 2, 'west-loc',    'nlb-w2');

// Stage 2→3 (backup): Backup KD → each SBC (reroute-kd only)
function makeBackupKdToSbc(
  locIdx: number,
  sbcNum: 1 | 2,
  id: string,
): PathDef {
  const sbcOffset = sbcNum === 1 ? -SBC_OFFSET : SBC_OFFSET;
  const locY = LOC_Y[locIdx];
  const targetY = locY + sbcOffset;
  const cpX = (COL.nlb + COL.sbc1X) / 2;
  return {
    id,
    group: 'reroute-kd',
    d: quadPath(COL.nlb + 32, KD_BACKUP_Y, cpX, targetY, COL.sbc1X - 24, targetY),
  };
}

const PATH_BKD_E1: PathDef = makeBackupKdToSbc(0, 1, 'bkd-e1');
const PATH_BKD_E2: PathDef = makeBackupKdToSbc(0, 2, 'bkd-e2');
const PATH_BKD_C1: PathDef = makeBackupKdToSbc(1, 1, 'bkd-c1');
const PATH_BKD_C2: PathDef = makeBackupKdToSbc(1, 2, 'bkd-c2');
const PATH_BKD_W1: PathDef = makeBackupKdToSbc(2, 1, 'bkd-w1');
const PATH_BKD_W2: PathDef = makeBackupKdToSbc(2, 2, 'bkd-w2');

// Stage 3 internal: SBC → CRAG (within each location)
function makeSbcToKs(
  locIdx: number,
  sbcNum: 1 | 2,
  group: FailoverGroup,
  id: string,
): PathDef {
  const sbcOffset = sbcNum === 1 ? -SBC_OFFSET : SBC_OFFSET;
  const locY = LOC_Y[locIdx];
  const y1 = locY + sbcOffset;
  const y2 = locY;
  const cp1X = COL.sbc1X + (COL.ksX - COL.sbc1X) * 0.35;
  const cp2X = COL.sbc1X + (COL.ksX - COL.sbc1X) * 0.65;
  return {
    id,
    group,
    d: cubicPath(COL.sbc1X + 24, y1, cp1X, y1, cp2X, y2, COL.ksX - 30, y2),
  };
}

const PATH_SBC1_KS_E: PathDef  = makeSbcToKs(0, 1, 'sbc1-east',    's1ks-e');
const PATH_SBC2_KS_E: PathDef  = makeSbcToKs(0, 2, 'normal',       's2ks-e');
const PATH_SBC1_KS_C: PathDef  = makeSbcToKs(1, 1, 'normal',       's1ks-c');
const PATH_SBC2_KS_C: PathDef  = makeSbcToKs(1, 2, 'sbc2-central', 's2ks-c');
const PATH_SBC1_KS_W: PathDef  = makeSbcToKs(2, 1, 'west-loc',     's1ks-w');
const PATH_SBC2_KS_W: PathDef  = makeSbcToKs(2, 2, 'west-loc',     's2ks-w');

// Stage 3→4: each location CRAG → each termination trunk (9 paths)
function makeTermPath(
  locIdx: number,
  termIdx: number,
  group: FailoverGroup,
  id: string,
): PathDef {
  const x1 = COL.ksX + 30;
  const y1 = LOC_Y[locIdx];
  const x2 = COL.termX - 44;
  const y2 = TERM_Y[termIdx];
  const cp1X = x1 + (x2 - x1) * 0.38;
  const cp2X = x1 + (x2 - x1) * 0.62;
  return {
    id,
    group,
    d: cubicPath(x1, y1, cp1X, y1, cp2X, y2, x2, y2),
  };
}

const PATHS_EAST_TERM = [
  makeTermPath(0, 0, 'term-dallas', 'e-t0'),
  makeTermPath(0, 1, 'normal',      'e-t1'),
  makeTermPath(0, 2, 'normal',      'e-t2'),
];
const PATHS_CENTRAL_TERM = [
  makeTermPath(1, 0, 'term-dallas', 'c-t0'),
  makeTermPath(1, 1, 'normal',      'c-t1'),
  makeTermPath(1, 2, 'normal',      'c-t2'),
];
const PATHS_WEST_TERM = [
  makeTermPath(2, 0, 'west-loc',    'w-t0'),
  makeTermPath(2, 1, 'west-loc',    'w-t1'),
  makeTermPath(2, 2, 'west-loc',    'w-t2'),
];

// All static paths used for packet offset-path definitions.
// NOTE: Primary-KD inbound/fan paths are here for packet routing.
// Their visibility during KD failure is controlled by the wrapper <g>
// animation (uid-kd-primary-group), not per-path failover groups.
const PATHS: PathDef[] = [
  PATH_INBOUND1_NLB, PATH_INBOUND2_NLB,
  PATH_INBOUND1_BACKUP, PATH_INBOUND2_BACKUP,
  PATH_NLB_E1, PATH_NLB_E2,
  PATH_NLB_C1, PATH_NLB_C2,
  PATH_NLB_W1, PATH_NLB_W2,
  PATH_BKD_E1, PATH_BKD_E2,
  PATH_BKD_C1, PATH_BKD_C2,
  PATH_BKD_W1, PATH_BKD_W2,
  PATH_SBC1_KS_E, PATH_SBC2_KS_E,
  PATH_SBC1_KS_C, PATH_SBC2_KS_C,
  PATH_SBC1_KS_W, PATH_SBC2_KS_W,
  ...PATHS_EAST_TERM,
  ...PATHS_CENTRAL_TERM,
  ...PATHS_WEST_TERM,
];

/* ─── Packet animation config ────────────────────────────────────────── */

interface PacketConfig {
  pathId: string;
  delay: number;
  duration: number;
  group: FailoverGroup;
  isTerm: boolean;
  beamLen: number;
  bright: boolean;
}

function makePackets(
  pathId: string,
  count: number,
  duration: number,
  group: FailoverGroup,
  isTerm = false,
  startDelay = 0,
  beamLen = 12,
  bright = false,
): PacketConfig[] {
  return Array.from({ length: count }, (_, i) => ({
    pathId,
    delay: startDelay + (duration / count) * i,
    duration,
    group,
    isTerm,
    beamLen,
    bright,
  }));
}

const ALL_PACKETS: PacketConfig[] = [
  // ── Stage 1: Inbound — fire hose of carrier traffic ────────────────────
  ...makePackets('in1-nlb', 6, 0.65, 'normal', false, 0.0,  12, false),
  ...makePackets('in2-nlb', 5, 0.65, 'normal', false, 0.3,  12, false),

  // ── Stage 2: Primary KD → SBCs ─────────────────────────────────────────
  ...makePackets('nlb-e1', 3, 0.5, 'sbc1-east',    false, 0.0,  13, false),
  ...makePackets('nlb-e2', 3, 0.5, 'normal',        false, 0.2,  13, false),
  ...makePackets('nlb-c1', 3, 0.5, 'normal',        false, 0.1,  13, false),
  ...makePackets('nlb-c2', 3, 0.5, 'sbc2-central',  false, 0.3,  13, false),
  ...makePackets('nlb-w1', 3, 0.5, 'west-loc',      false, 0.15, 13, false),
  ...makePackets('nlb-w2', 3, 0.5, 'west-loc',      false, 0.35, 13, false),

  // ── Stage 3: SBC → CRAG ─────────────────────────────────────────────
  ...makePackets('s1ks-e', 3, 0.35, 'sbc1-east',    false, 0.05, 14, true),
  ...makePackets('s2ks-e', 2, 0.35, 'normal',        false, 0.10, 14, true),

  ...makePackets('s1ks-c', 2, 0.35, 'normal',        false, 0.08, 14, true),
  ...makePackets('s2ks-c', 3, 0.35, 'sbc2-central',  false, 0.18, 14, true),

  ...makePackets('s1ks-w', 3, 0.35, 'west-loc',      false, 0.03, 14, true),
  ...makePackets('s2ks-w', 2, 0.35, 'west-loc',      false, 0.13, 14, true),

  // ── Stage 4: CRAG → Termination ─────────────────────────────────────
  ...makePackets('e-t0', 2, 0.5, 'term-dallas', true,  0.00, 14, true),
  ...makePackets('e-t1', 2, 0.5, 'normal',      true,  0.08, 14, true),
  ...makePackets('e-t2', 2, 0.5, 'normal',      true,  0.20, 14, true),

  ...makePackets('c-t0', 2, 0.5, 'term-dallas', true,  0.10, 14, true),
  ...makePackets('c-t1', 2, 0.5, 'normal',      true,  0.05, 14, true),
  ...makePackets('c-t2', 2, 0.5, 'normal',      true,  0.15, 14, true),

  // w-t0 hides during both west-loc AND dallas failure
  ...makePackets('w-t0', 2, 0.5, 'west-loc-or-dallas', true,  0.05, 14, true),
  ...makePackets('w-t1', 2, 0.5, 'west-loc',            true,  0.15, 14, true),
  ...makePackets('w-t2', 2, 0.5, 'west-loc',            true,  0.25, 14, true),

  // ── Reroute packets: only appear during their specific failure event ──

  // SBC-2 Central fails → SBC-1 Central absorbs extra load
  ...makePackets('s1ks-c', 3, 0.35, 'reroute-sbc2central', false, 0.1, 14, true),
  ...makePackets('nlb-c1', 3, 0.5,  'reroute-sbc2central', false, 0.3, 13, false),

  // West datacenter fails → East and Central absorb extra load
  ...makePackets('nlb-e1', 3, 0.5,  'reroute-west', false, 0.1,  13, false),
  ...makePackets('nlb-c1', 3, 0.5,  'reroute-west', false, 0.4,  13, false),
  ...makePackets('s1ks-e', 3, 0.35, 'reroute-west', false, 0.15, 14, true),
  ...makePackets('s1ks-c', 3, 0.35, 'reroute-west', false, 0.35, 14, true),
  ...makePackets('e-t1',   2, 0.5,  'reroute-west', true,  0.10, 14, true),
  ...makePackets('c-t1',   2, 0.5,  'reroute-west', true,  0.30, 14, true),

  // Dallas fails → LA and Backup absorb extra load
  ...makePackets('e-t1', 2, 0.5, 'reroute-dallas', true, 0.05, 14, true),
  ...makePackets('e-t2', 2, 0.5, 'reroute-dallas', true, 0.20, 14, true),
  ...makePackets('c-t1', 2, 0.5, 'reroute-dallas', true, 0.10, 14, true),
  ...makePackets('c-t2', 2, 0.5, 'reroute-dallas', true, 0.25, 14, true),

  // SBC-1 East fails → SBC-2 East absorbs extra load
  ...makePackets('s2ks-e', 3, 0.35, 'reroute-sbc1east', false, 0.1, 14, true),
  ...makePackets('nlb-e2', 3, 0.5,  'reroute-sbc1east', false, 0.3, 13, false),

  // Primary KD fails → Backup KD takes over (all 6 backup paths light up)
  ...makePackets('in1-bkd', 6, 0.65, 'reroute-kd', false, 0.0,  12, false),
  ...makePackets('in2-bkd', 5, 0.65, 'reroute-kd', false, 0.3,  12, false),
  ...makePackets('bkd-e1',  3, 0.5,  'reroute-kd', false, 0.0,  13, false),
  ...makePackets('bkd-e2',  3, 0.5,  'reroute-kd', false, 0.2,  13, false),
  ...makePackets('bkd-c1',  3, 0.5,  'reroute-kd', false, 0.1,  13, false),
  ...makePackets('bkd-c2',  3, 0.5,  'reroute-kd', false, 0.3,  13, false),
  ...makePackets('bkd-w1',  3, 0.5,  'reroute-kd', false, 0.15, 13, false),
  ...makePackets('bkd-w2',  3, 0.5,  'reroute-kd', false, 0.35, 13, false),
];

/* ─── Failover timing (master 50-second cycle) ───────────────────────── */
/**
 * t = time in seconds within the 50s cycle
 * 1s = 2%  |  5s = 10%
 *
 * Schedule:
 *   0–5s    (0–10%)    Normal
 *   5–10s   (10–20%)   SBC-2 Central fails
 *   10–15s  (20–30%)   Normal
 *   15–20s  (30–40%)   West datacenter fails
 *   20–25s  (40–50%)   Normal
 *   25–30s  (50–60%)   Dallas trunk fails
 *   30–35s  (60–70%)   Normal
 *   35–40s  (70–80%)   SBC-1 East fails
 *   40–45s  (80–90%)   Normal
 *   45–50s  (90–100%)  Primary Key Distributor fails → Backup takes over
 */

/* ─── Component ──────────────────────────────────────────────────────── */

export function HaArchitectureViz() {
  // useId is render-pure and unique per mounted instance; sanitise the
  // ":r0:"-style value into a valid CSS identifier for class/keyframe names.
  const reactId = useId();
  const uid = useMemo(
    () => `ha-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`,
    [reactId],
  );

  const css = useMemo(() => {
    // 1. Per-path traversal @keyframes
    const pathKf = PATHS.map(
      (p) => `@keyframes ${uid}-pkt-${p.id} {
  0%   { offset-distance:   0%; opacity: 0; }
  8%   { opacity: 1; }
  88%  { opacity: 1; }
  100% { offset-distance: 100%; opacity: 0; }
}`,
    ).join('\n');

    // 2. Group visibility keyframes — all on the 50s master cycle.
    //
    // Percentages (50s base):
    //   SBC-2 Central  : 10%–20%
    //   West datacenter: 30%–40%
    //   Dallas trunk   : 50%–60%
    //   SBC-1 East     : 70%–80%
    //   Primary KD     : 90%–100%  (handled by wrapper <g> animation, not per-path)

    const groupKf = `
@keyframes ${uid}-vis-normal {
  0%, 100% { opacity: 1; }
}
@keyframes ${uid}-vis-sbc2central {
  0%, 9.9%   { opacity: 1; }
  10%        { opacity: 0; }
  19.9%      { opacity: 0; }
  20%        { opacity: 1; }
  100%       { opacity: 1; }
}
@keyframes ${uid}-vis-westloc {
  0%, 29.9%  { opacity: 1; }
  30%        { opacity: 0; }
  39.9%      { opacity: 0; }
  40%        { opacity: 1; }
  100%       { opacity: 1; }
}
@keyframes ${uid}-vis-termdallas {
  0%, 49.9%  { opacity: 1; }
  50%        { opacity: 0; }
  59.9%      { opacity: 0; }
  60%        { opacity: 1; }
  100%       { opacity: 1; }
}
@keyframes ${uid}-vis-sbc1east {
  0%, 69.9%  { opacity: 1; }
  70%        { opacity: 0; }
  79.9%      { opacity: 0; }
  80%        { opacity: 1; }
  100%       { opacity: 1; }
}
@keyframes ${uid}-pkt-sbc2central {
  0%, 9.9%   { opacity: 1; }
  10%        { opacity: 0; }
  19.9%      { opacity: 0; }
  20%, 100%  { opacity: 1; }
}
@keyframes ${uid}-pkt-westloc {
  0%, 29.9%  { opacity: 1; }
  30%        { opacity: 0; }
  39.9%      { opacity: 0; }
  40%, 100%  { opacity: 1; }
}
@keyframes ${uid}-pkt-termdallas {
  0%, 49.9%  { opacity: 1; }
  50%        { opacity: 0; }
  59.9%      { opacity: 0; }
  60%, 100%  { opacity: 1; }
}
@keyframes ${uid}-pkt-westloc-or-dallas {
  0%, 29.9%  { opacity: 1; }
  30%        { opacity: 0; }
  39.9%      { opacity: 0; }
  40%, 49.9% { opacity: 1; }
  50%        { opacity: 0; }
  59.9%      { opacity: 0; }
  60%, 100%  { opacity: 1; }
}
@keyframes ${uid}-pkt-sbc1east {
  0%, 69.9%  { opacity: 1; }
  70%        { opacity: 0; }
  79.9%      { opacity: 0; }
  80%, 100%  { opacity: 1; }
}
@keyframes ${uid}-pkt-reroute-sbc2c {
  0%, 9.9%   { opacity: 0; }
  10%        { opacity: 1; }
  19.9%      { opacity: 1; }
  20%, 100%  { opacity: 0; }
}
@keyframes ${uid}-pkt-reroute-west {
  0%, 29.9%  { opacity: 0; }
  30%        { opacity: 1; }
  39.9%      { opacity: 1; }
  40%, 100%  { opacity: 0; }
}
@keyframes ${uid}-pkt-reroute-dallas {
  0%, 49.9%  { opacity: 0; }
  50%        { opacity: 1; }
  59.9%      { opacity: 1; }
  60%, 100%  { opacity: 0; }
}
@keyframes ${uid}-pkt-reroute-sbc1e {
  0%, 69.9%  { opacity: 0; }
  70%        { opacity: 1; }
  79.9%      { opacity: 1; }
  80%, 100%  { opacity: 0; }
}
@keyframes ${uid}-pkt-reroute-kd {
  0%, 89.9%  { opacity: 0; }
  90%        { opacity: 1; }
  99.9%      { opacity: 1; }
  100%       { opacity: 0; }
}`;

    // Map group to packet visibility animation name
    function pktvizAnim(group: FailoverGroup): string | null {
      switch (group) {
        case 'normal':             return null;
        case 'sbc2-central':       return `${uid}-pkt-sbc2central`;
        case 'west-loc':           return `${uid}-pkt-westloc`;
        case 'term-dallas':        return `${uid}-pkt-termdallas`;
        case 'west-loc-or-dallas': return `${uid}-pkt-westloc-or-dallas`;
        case 'sbc1-east':          return `${uid}-pkt-sbc1east`;
        case 'reroute-sbc2central':return `${uid}-pkt-reroute-sbc2c`;
        case 'reroute-west':       return `${uid}-pkt-reroute-west`;
        case 'reroute-dallas':     return `${uid}-pkt-reroute-dallas`;
        case 'reroute-sbc1east':   return `${uid}-pkt-reroute-sbc1e`;
        case 'reroute-kd':         return `${uid}-pkt-reroute-kd`;
      }
    }

    const packetRules = ALL_PACKETS.map((pkt, i) => {
      const path = PATHS.find((p) => p.id === pkt.pathId);
      if (!path) return '';

      const visAnim = pktvizAnim(pkt.group);

      const animNames = visAnim
        ? `${uid}-pkt-${path.id}, ${visAnim}`
        : `${uid}-pkt-${path.id}`;
      const animDurs = visAnim
        ? `${pkt.duration}s, 50s`
        : `${pkt.duration}s`;
      const animDels = visAnim
        ? `${pkt.delay}s, 0s`
        : `${pkt.delay}s`;
      const animIters = visAnim
        ? 'infinite, infinite'
        : 'infinite';
      const animFills = visAnim
        ? 'both, both'
        : 'both';
      const animTfs = visAnim
        ? 'cubic-bezier(0.4,0,0.6,1), step-start'
        : 'cubic-bezier(0.4,0,0.6,1)';

      const startOpacity = pkt.group.startsWith('reroute') ? 0 : undefined;

      return `.${uid}-p${i} {
  offset-path: path('${path.d}');
  offset-rotate: auto;
  animation-name: ${animNames};
  animation-duration: ${animDurs};
  animation-delay: ${animDels};
  animation-timing-function: ${animTfs};
  animation-iteration-count: ${animIters};
  animation-fill-mode: ${animFills};${startOpacity !== undefined ? `\n  opacity: ${startOpacity};` : ''}
}`;
    }).join('\n');

    // 3. Node visibility animations (red-glow pulsing during failure)
    //
    // Failure windows (50s cycle):
    //   sbc2-central : 10%–20%   (5s)
    //   west-loc     : 30%–40%   (5s)
    //   term-dallas  : 50%–60%   (5s)
    //   sbc1-east    : 70%–80%   (5s)
    //   primary-kd   : 90%–100%  (5s)
    //
    // Pulse cadence: 3 smooth pulses per 10% failure window using clean red
    // drop-shadows only — no sepia/hue-rotate distortion.
    //   Pulse steps per window (e.g. 10%–20%):
    //   10.5% DIM → 12% PEAK → 14% DIM → 16% PEAK → 18% DIM → 19.5% PEAK (recover)

    const F_DIM  = 'drop-shadow(0 0 6px rgba(220,38,38,0.35)) drop-shadow(0 0 18px rgba(220,38,38,0.15))';
    const F_PEAK = 'drop-shadow(0 0 10px rgba(220,38,38,0.55)) drop-shadow(0 0 28px rgba(220,38,38,0.25))';
    const OP_FAIL_DIM  = 0.50;
    const OP_FAIL_PEAK = 0.62;

    const nodeKf = `
@keyframes ${uid}-node-sbc2central {
  0%, 9.9%    { opacity: 1; filter: none; }
  10.5%       { opacity: ${OP_FAIL_DIM};  filter: ${F_DIM};  }
  12%         { opacity: ${OP_FAIL_PEAK}; filter: ${F_PEAK}; }
  14%         { opacity: ${OP_FAIL_DIM};  filter: ${F_DIM};  }
  16%         { opacity: ${OP_FAIL_PEAK}; filter: ${F_PEAK}; }
  18%         { opacity: ${OP_FAIL_DIM};  filter: ${F_DIM};  }
  19.5%       { opacity: ${OP_FAIL_PEAK}; filter: ${F_PEAK}; }
  20.2%       { opacity: 1; filter: none; }
  100%        { opacity: 1; filter: none; }
}
@keyframes ${uid}-node-westloc {
  0%, 29.9%   { opacity: 1; filter: none; }
  30.5%       { opacity: ${OP_FAIL_DIM};  filter: ${F_DIM};  }
  32%         { opacity: ${OP_FAIL_PEAK}; filter: ${F_PEAK}; }
  34%         { opacity: ${OP_FAIL_DIM};  filter: ${F_DIM};  }
  36%         { opacity: ${OP_FAIL_PEAK}; filter: ${F_PEAK}; }
  38%         { opacity: ${OP_FAIL_DIM};  filter: ${F_DIM};  }
  39.5%       { opacity: ${OP_FAIL_PEAK}; filter: ${F_PEAK}; }
  40.2%       { opacity: 1; filter: none; }
  100%        { opacity: 1; filter: none; }
}
@keyframes ${uid}-node-termdallas {
  0%, 49.9%   { opacity: 1; filter: none; }
  50.5%       { opacity: ${OP_FAIL_DIM};  filter: ${F_DIM};  }
  52%         { opacity: ${OP_FAIL_PEAK}; filter: ${F_PEAK}; }
  54%         { opacity: ${OP_FAIL_DIM};  filter: ${F_DIM};  }
  56%         { opacity: ${OP_FAIL_PEAK}; filter: ${F_PEAK}; }
  58%         { opacity: ${OP_FAIL_DIM};  filter: ${F_DIM};  }
  59.5%       { opacity: ${OP_FAIL_PEAK}; filter: ${F_PEAK}; }
  60.2%       { opacity: 1; filter: none; }
  100%        { opacity: 1; filter: none; }
}
@keyframes ${uid}-node-sbc1east {
  0%, 69.9%   { opacity: 1; filter: none; }
  70.5%       { opacity: ${OP_FAIL_DIM};  filter: ${F_DIM};  }
  72%         { opacity: ${OP_FAIL_PEAK}; filter: ${F_PEAK}; }
  74%         { opacity: ${OP_FAIL_DIM};  filter: ${F_DIM};  }
  76%         { opacity: ${OP_FAIL_PEAK}; filter: ${F_PEAK}; }
  78%         { opacity: ${OP_FAIL_DIM};  filter: ${F_DIM};  }
  79.5%       { opacity: ${OP_FAIL_PEAK}; filter: ${F_PEAK}; }
  80%         { opacity: 1; filter: none; }
  100%        { opacity: 1; filter: none; }
}
@keyframes ${uid}-node-kdprimary {
  0%, 89.9%   { opacity: 1; filter: none; }
  90.5%       { opacity: ${OP_FAIL_DIM};  filter: ${F_DIM};  }
  92%         { opacity: ${OP_FAIL_PEAK}; filter: ${F_PEAK}; }
  94%         { opacity: ${OP_FAIL_DIM};  filter: ${F_DIM};  }
  96%         { opacity: ${OP_FAIL_PEAK}; filter: ${F_PEAK}; }
  98%         { opacity: ${OP_FAIL_DIM};  filter: ${F_DIM};  }
  99.5%       { opacity: ${OP_FAIL_PEAK}; filter: ${F_PEAK}; }
  100%        { opacity: 1; filter: none; }
}
@keyframes ${uid}-node-kdbackup {
  0%, 89.9%   { opacity: 0.48; filter: none; }
  90%         { opacity: 1; filter: drop-shadow(0 0 10px rgba(251,191,36,0.70)) drop-shadow(0 0 24px rgba(251,191,36,0.35)) brightness(1.05); }
  99.9%       { opacity: 1; filter: drop-shadow(0 0 10px rgba(251,191,36,0.70)) drop-shadow(0 0 24px rgba(251,191,36,0.35)) brightness(1.05); }
  100%        { opacity: 0.48; filter: none; }
}`;

    // 4. Node CSS classes (50s cycle)
    const nodeRules = `
.${uid}-node-sbc2central {
  animation: ${uid}-node-sbc2central 50s linear infinite;
}
.${uid}-node-westloc {
  animation: ${uid}-node-westloc 50s linear infinite;
}
.${uid}-node-termdallas {
  animation: ${uid}-node-termdallas 50s linear infinite;
}
.${uid}-node-sbc1east {
  animation: ${uid}-node-sbc1east 50s linear infinite;
}
.${uid}-node-kdprimary {
  animation: ${uid}-node-kdprimary 50s linear infinite;
}
.${uid}-node-kdbackup {
  animation: ${uid}-node-kdbackup 50s step-start infinite;
}`;

    // 5. Primary KD layer wrapper — hides entire primary routing layer during 90-100%
    //    This single animation covers inbound→primary and primary→SBC paths and packets.
    const kdLayerKf = `
@keyframes ${uid}-kd-primary-layer {
  0%, 89.9%  { opacity: 1; }
  90%        { opacity: 0; }
  99.9%      { opacity: 0; }
  100%       { opacity: 1; }
}
@keyframes ${uid}-kd-backup-layer {
  0%, 89.9%  { opacity: 0; }
  90%        { opacity: 1; }
  99.9%      { opacity: 1; }
  100%       { opacity: 0; }
}`;

    const kdLayerRules = `
.${uid}-kd-primary-layer {
  animation: ${uid}-kd-primary-layer 50s step-start infinite;
}
.${uid}-kd-backup-layer {
  animation: ${uid}-kd-backup-layer 50s step-start infinite;
}`;

    // 6. Status indicator animations (80s cycle, step-start for crisp switches)
    const statusKf = `
@keyframes ${uid}-status-normal {
  0%,  9.9%  { opacity: 1; }
  10%        { opacity: 0; }
  19.9%      { opacity: 0; }
  20%, 29.9% { opacity: 1; }
  30%        { opacity: 0; }
  39.9%      { opacity: 0; }
  40%, 49.9% { opacity: 1; }
  50%        { opacity: 0; }
  59.9%      { opacity: 0; }
  60%, 69.9% { opacity: 1; }
  70%        { opacity: 0; }
  79.9%      { opacity: 0; }
  80%, 89.9% { opacity: 1; }
  90%        { opacity: 0; }
  99.9%      { opacity: 0; }
  100%       { opacity: 1; }
}
@keyframes ${uid}-status-sbc2c {
  0%, 9.9%   { opacity: 0; }
  10%        { opacity: 1; }
  19.9%      { opacity: 1; }
  20%, 100%  { opacity: 0; }
}
@keyframes ${uid}-status-west {
  0%, 29.9%  { opacity: 0; }
  30%        { opacity: 1; }
  39.9%      { opacity: 1; }
  40%, 100%  { opacity: 0; }
}
@keyframes ${uid}-status-dallas {
  0%, 49.9%  { opacity: 0; }
  50%        { opacity: 1; }
  59.9%      { opacity: 1; }
  60%, 100%  { opacity: 0; }
}
@keyframes ${uid}-status-sbc1e {
  0%, 69.9%  { opacity: 0; }
  70%        { opacity: 1; }
  79.9%      { opacity: 1; }
  80%, 100%  { opacity: 0; }
}
@keyframes ${uid}-status-kdprimary {
  0%, 89.9%  { opacity: 0; }
  90%        { opacity: 1; }
  99.9%      { opacity: 1; }
  100%       { opacity: 0; }
}`;

    const alertHaloKf = `
@keyframes ${uid}-alert-halo-pulse {
  0%   { transform: scale(1);   opacity: 0.70; }
  60%  { transform: scale(2.4); opacity: 0;    }
  100% { transform: scale(2.4); opacity: 0;    }
}`;

    const statusRules = `
.${uid}-status-normal    { animation: ${uid}-status-normal    50s step-start infinite; }
.${uid}-status-sbc2c     { animation: ${uid}-status-sbc2c     50s step-start infinite; opacity: 0; }
.${uid}-status-west      { animation: ${uid}-status-west      50s step-start infinite; opacity: 0; }
.${uid}-status-dallas    { animation: ${uid}-status-dallas    50s step-start infinite; opacity: 0; }
.${uid}-status-sbc1e     { animation: ${uid}-status-sbc1e     50s step-start infinite; opacity: 0; }
.${uid}-status-kdprimary { animation: ${uid}-status-kdprimary 50s step-start infinite; opacity: 0; }
.${uid}-alert-halo       { animation: ${uid}-alert-halo-pulse 0.75s ease-out infinite; }`;

    return [
      pathKf, groupKf, packetRules,
      nodeKf, nodeRules,
      kdLayerKf, kdLayerRules,
      statusKf, alertHaloKf, statusRules,
    ].join('\n');
  }, [uid]);

  return (
    <>
      <div
        style={{
          width: '100%',
          margin: '0 auto',
          background: 'linear-gradient(180deg, #0d1626 0%, #0a111f 100%)',
          border: '1px solid rgba(94,132,196,0.26)',
          borderRadius: 14,
          boxShadow: '0 28px 64px -32px rgba(0,0,0,0.70), 0 2px 8px -2px rgba(0,0,0,0.45)',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
      <style dangerouslySetInnerHTML={{ __html: css }} />

      {/* Azure keyline — engineered top edge */}
      <div
        style={{
          height: 3,
          background:
            'linear-gradient(90deg, #2f7df6 0%, rgba(47,125,246,0.55) 45%, rgba(47,125,246,0.10) 100%)',
        }}
      />

      {/* Card header — title + live tag left, status indicator right */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '14px 28px',
          padding: '20px 28px 18px',
          borderBottom: '1px solid rgba(94,132,196,0.18)',
        }}
      >
        <div style={{ minWidth: 260 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span
              style={{
                background: 'var(--lg-azure, #2f7df6)',
                color: '#ffffff',
                fontSize: '0.60rem',
                fontWeight: 700,
                letterSpacing: '0.14em',
                padding: '3px 8px',
                borderRadius: 3,
                lineHeight: 1.4,
              }}
            >
              LIVE
            </span>
            <h3
              style={{
                fontFamily: '"Archivo", "IBM Plex Sans", sans-serif',
                fontWeight: 800,
                fontSize: '1.15rem',
                letterSpacing: '-0.01em',
                color: '#f2f6ff',
                margin: 0,
                lineHeight: 1.2,
              }}
            >
              High Availability Simulation
            </h3>
          </div>
          <p
            style={{
              margin: '6px 0 0',
              fontSize: '0.8rem',
              lineHeight: 1.5,
              color: '#8ba1c4',
              maxWidth: 560,
            }}
          >
            Five production failover scenarios on a continuous 50-second cycle
            — the same reroutes the live network runs.
          </p>
        </div>

        <StatusIndicatorHtml uid={uid} />
      </div>

      {/* Diagram body */}
      <div style={{ padding: '18px 22px 12px' }}>
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        width="100%"
        height="auto"
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block' }}
        aria-label="CRAG (Call Routing Application Gateway): inbound trunks route through a Primary Key Distributor (GCP Global Load Balancer) — with a Hot Backup Key Distributor on standby — to three Granite locations, each with dual Signal Keys and a CRAG Engine, terminating via Dallas, LA, and Backup PoP trunks. A 50-second animation cycles through five failover scenarios including Primary Key Distributor failure where the Hot Backup automatically takes over."
      >
        <defs>
          {/* Grid background pattern */}
          <pattern
            id={`${uid}-grid`}
            width="48"
            height="48"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M 48 0 L 0 0 0 48"
              fill="none"
              stroke="rgba(99,130,180,0.06)"
              strokeWidth="1"
            />
          </pattern>

          {/* Node glow gradients */}
          <radialGradient id={`${uid}-ng`} cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="#3b82f6" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${uid}-lg`} cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="#60a5fa" stopOpacity="0.32" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`${uid}-tg`} cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="#34d399" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#059669" stopOpacity="0" />
          </radialGradient>
          {/* Amber glow for backup KD standby / active state */}
          <radialGradient id={`${uid}-ag`} cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="#f59e0b" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
          </radialGradient>

          {/* Fiber-optic beam gradients — blue for processing, green for termination */}
          <linearGradient id={`${uid}-beam-blue`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%"   stopColor="#3b82f6" stopOpacity="0" />
            <stop offset="30%"  stopColor="#60a5fa" stopOpacity="0.8" />
            <stop offset="50%"  stopColor="#bfdbfe" stopOpacity="1" />
            <stop offset="70%"  stopColor="#60a5fa" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`${uid}-beam-green`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%"   stopColor="#059669" stopOpacity="0" />
            <stop offset="30%"  stopColor="#34d399" stopOpacity="0.8" />
            <stop offset="50%"  stopColor="#a7f3d0" stopOpacity="1" />
            <stop offset="70%"  stopColor="#34d399" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#059669" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`${uid}-beam-blue-bright`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%"   stopColor="#3b82f6" stopOpacity="0" />
            <stop offset="20%"  stopColor="#93c5fd" stopOpacity="0.92" />
            <stop offset="50%"  stopColor="#eff6ff" stopOpacity="1" />
            <stop offset="80%"  stopColor="#93c5fd" stopOpacity="0.92" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`${uid}-beam-green-bright`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%"   stopColor="#059669" stopOpacity="0" />
            <stop offset="20%"  stopColor="#6ee7b7" stopOpacity="0.92" />
            <stop offset="50%"  stopColor="#ecfdf5" stopOpacity="1" />
            <stop offset="80%"  stopColor="#6ee7b7" stopOpacity="0.92" />
            <stop offset="100%" stopColor="#059669" stopOpacity="0" />
          </linearGradient>

          {/* Clip path */}
          <clipPath id={`${uid}-clip`}>
            <rect x="0" y="0" width={VB_W} height={VB_H} />
          </clipPath>

          {/* Beam glow filter */}
          <filter id={`${uid}-pf`} x="-200%" y="-400%" width="500%" height="900%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="2.4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Node inner glow filter */}
          <filter id={`${uid}-nf`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* CRAG / KD logo glow — blue halo */}
          <filter id={`${uid}-imgf`} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="2.8" result="blur" />
            <feColorMatrix in="blur" type="matrix"
              values="0 0 0 0 0.23   0 0 0 0 0.51   0 0 0 0 0.96   0 0 0 0.55 0"
              result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Dimmed glow filter for backup KD standby mode — softer, narrower halo */}
          <filter id={`${uid}-imgf-dim`} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="1.6" result="blur" />
            <feColorMatrix in="blur" type="matrix"
              values="0 0 0 0 0.23   0 0 0 0 0.51   0 0 0 0 0.96   0 0 0 0.25 0"
              result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Grid background */}
        <rect x="0" y="0" width={VB_W} height={VB_H} fill={`url(#${uid}-grid)`} />

        {/* Central ambient glow */}
        <ellipse
          cx={VB_W / 2} cy={VB_H / 2}
          rx={VB_W * 0.46} ry={VB_H * 0.58}
          fill="rgba(59,130,246,0.022)"
        />

        {/* ── Connection lines ────────────────────────────────────── */}
        {/*
          PRIMARY KD LAYER — inbound→primary and primary→SBC static lines.
          These are NOT wrapped in the kd-primary-layer animation because
          static lines should remain faintly visible at all times for diagram
          legibility. The animated packets inside the wrapper g are what hide.
          We draw the backup lines always-on at lower opacity for context.
        */}
        <g fill="none" clipPath={`url(#${uid}-clip)`}>
          {/* Stage 1→2: inbound → Primary KD */}
          <path d={PATH_INBOUND1_NLB.d} stroke="rgba(59,130,246,0.30)" strokeWidth="1.2" />
          <path d={PATH_INBOUND2_NLB.d} stroke="rgba(59,130,246,0.30)" strokeWidth="1.2" />

          {/* Stage 1→2: inbound → Backup KD (always visible, dimmer — dormant paths) */}
          <path d={PATH_INBOUND1_BACKUP.d} stroke="rgba(59,130,246,0.14)" strokeWidth="0.9" strokeDasharray="5 4" />
          <path d={PATH_INBOUND2_BACKUP.d} stroke="rgba(59,130,246,0.14)" strokeWidth="0.9" strokeDasharray="5 4" />

          {/* Stage 2→3 fan — Primary NLB to SBC pairs */}
          <path d={PATH_NLB_E1.d} stroke="rgba(59,130,246,0.24)" strokeWidth="1.1" />
          <path d={PATH_NLB_E2.d} stroke="rgba(59,130,246,0.24)" strokeWidth="1.1" />
          <path d={PATH_NLB_C1.d} stroke="rgba(59,130,246,0.24)" strokeWidth="1.1" />
          <path d={PATH_NLB_C2.d} stroke="rgba(59,130,246,0.24)" strokeWidth="1.1" />
          <path d={PATH_NLB_W1.d} stroke="rgba(59,130,246,0.24)" strokeWidth="1.1" />
          <path d={PATH_NLB_W2.d} stroke="rgba(59,130,246,0.24)" strokeWidth="1.1" />

          {/* Stage 2→3 fan — Backup KD to SBC pairs (always visible, dimmer) */}
          <path d={PATH_BKD_E1.d} stroke="rgba(59,130,246,0.10)" strokeWidth="0.85" strokeDasharray="5 4" />
          <path d={PATH_BKD_E2.d} stroke="rgba(59,130,246,0.10)" strokeWidth="0.85" strokeDasharray="5 4" />
          <path d={PATH_BKD_C1.d} stroke="rgba(59,130,246,0.10)" strokeWidth="0.85" strokeDasharray="5 4" />
          <path d={PATH_BKD_C2.d} stroke="rgba(59,130,246,0.10)" strokeWidth="0.85" strokeDasharray="5 4" />
          <path d={PATH_BKD_W1.d} stroke="rgba(59,130,246,0.10)" strokeWidth="0.85" strokeDasharray="5 4" />
          <path d={PATH_BKD_W2.d} stroke="rgba(59,130,246,0.10)" strokeWidth="0.85" strokeDasharray="5 4" />

          {/* Stage 3 internal — SBC to CRAG (dashed) */}
          <path d={PATH_SBC1_KS_E.d} stroke="rgba(59,130,246,0.20)" strokeWidth="0.9" strokeDasharray="4 3" />
          <path d={PATH_SBC2_KS_E.d} stroke="rgba(59,130,246,0.20)" strokeWidth="0.9" strokeDasharray="4 3" />
          <path d={PATH_SBC1_KS_C.d} stroke="rgba(59,130,246,0.20)" strokeWidth="0.9" strokeDasharray="4 3" />
          <path d={PATH_SBC2_KS_C.d} stroke="rgba(59,130,246,0.20)" strokeWidth="0.9" strokeDasharray="4 3" />
          <path d={PATH_SBC1_KS_W.d} stroke="rgba(59,130,246,0.20)" strokeWidth="0.9" strokeDasharray="4 3" />
          <path d={PATH_SBC2_KS_W.d} stroke="rgba(59,130,246,0.20)" strokeWidth="0.9" strokeDasharray="4 3" />

          {/* Stage 3→4 convergence fan — green-tinted */}
          {[...PATHS_EAST_TERM, ...PATHS_CENTRAL_TERM, ...PATHS_WEST_TERM].map((p) => (
            <path key={p.id} d={p.d} stroke="rgba(52,211,153,0.18)" strokeWidth="1.0" />
          ))}
        </g>

        {/* ── Animated fiber-optic light beams ─────────────────── */}
        {/*
          Packets are split into two animated wrapper groups:
          - Primary KD layer: inbound + primary-fan packets — hides at 90%
          - Backup KD layer: backup-fan packets — appears at 90%
          - Unaffected packets (SBC→CRAG, CRAG→Termination) are
            outside both wrappers and run on their own per-group animations.

          We identify primary-layer packets as those using paths:
            in1-nlb, in2-nlb, nlb-e1, nlb-e2, nlb-c1, nlb-c2, nlb-w1, nlb-w2
          and their associated reroute paths.

          Backup-layer packets use: in1-bkd, in2-bkd, bkd-e1..bkd-w2

          All other packets (s1ks-*, s2ks-*, *-t*) are in neither wrapper.
        */}
        {(() => {
          const PRIMARY_KD_PATH_IDS = new Set([
            'in1-nlb', 'in2-nlb',
            'nlb-e1', 'nlb-e2', 'nlb-c1', 'nlb-c2', 'nlb-w1', 'nlb-w2',
          ]);
          const BACKUP_KD_PATH_IDS = new Set([
            'in1-bkd', 'in2-bkd',
            'bkd-e1', 'bkd-e2', 'bkd-c1', 'bkd-c2', 'bkd-w1', 'bkd-w2',
          ]);

          const primaryPkts: { pkt: PacketConfig; i: number }[] = [];
          const backupPkts:  { pkt: PacketConfig; i: number }[] = [];
          const otherPkts:   { pkt: PacketConfig; i: number }[] = [];

          ALL_PACKETS.forEach((pkt, i) => {
            if (PRIMARY_KD_PATH_IDS.has(pkt.pathId)) {
              primaryPkts.push({ pkt, i });
            } else if (BACKUP_KD_PATH_IDS.has(pkt.pathId)) {
              backupPkts.push({ pkt, i });
            } else {
              otherPkts.push({ pkt, i });
            }
          });

          function renderBeam(pkt: PacketConfig, i: number) {
            const halfLen = pkt.beamLen;
            const fullLen = halfLen * 2;
            const gradId = pkt.isTerm
              ? (pkt.bright ? `${uid}-beam-green-bright` : `${uid}-beam-green`)
              : (pkt.bright ? `${uid}-beam-blue-bright`  : `${uid}-beam-blue`);
            return (
              <rect
                key={i}
                x={-halfLen}
                y="-1.5"
                width={fullLen}
                height="3"
                rx="1.5"
                fill={`url(#${gradId})`}
                filter={`url(#${uid}-pf)`}
                className={`${uid}-p${i}`}
              />
            );
          }

          return (
            <>
              {/* Primary KD packet layer — hidden during 90-100% */}
              <g clipPath={`url(#${uid}-clip)`} className={`${uid}-kd-primary-layer`}>
                {primaryPkts.map(({ pkt, i }) => renderBeam(pkt, i))}
              </g>
              {/* Backup KD packet layer — visible only during 90-100% */}
              <g clipPath={`url(#${uid}-clip)`} className={`${uid}-kd-backup-layer`}>
                {backupPkts.map(({ pkt, i }) => renderBeam(pkt, i))}
              </g>
              {/* All other packets — SBC→KS and KS→Term, unaffected by KD failure */}
              <g clipPath={`url(#${uid}-clip)`}>
                {otherPkts.map(({ pkt, i }) => renderBeam(pkt, i))}
              </g>
            </>
          );
        })()}

        {/* ── Stage nodes ───────────────────────────────────────── */}
        {/* Dual redundant inbound trunks — stacked vertically */}
        <InboundTrunkNode uid={uid} cy={TRUNK_Y[0]} label="Trunk 1" />
        <InboundTrunkNode uid={uid} cy={TRUNK_Y[1]} label="Trunk 2" />

        {/* Primary and Backup Key Distributor nodes */}
        <NlbNode uid={uid} cy={KD_PRIMARY_Y} isBackup={false} nodeClass={`${uid}-node-kdprimary`} />
        <NlbNode uid={uid} cy={KD_BACKUP_Y}  isBackup={true}  nodeClass={`${uid}-node-kdbackup`} />

        {/* Three geographic location containers */}
        <LocationGroup uid={uid} locIdx={0} label="Granite East"    sbc1Class={`${uid}-node-sbc1east`}    locClass={undefined} />
        <LocationGroup uid={uid} locIdx={1} label="Granite Central" sbc2Class={undefined}                  locClass={undefined} sbc1Class={undefined} sbc2CentralClass={`${uid}-node-sbc2central`} />
        <LocationGroup uid={uid} locIdx={2} label="Granite West"    sbc2Class={undefined}                  locClass={`${uid}-node-westloc`} />

        {/* Three termination trunk nodes */}
        <TermNode uid={uid} termIdx={0} label="Dallas" sublabel="PoP"   nodeClass={`${uid}-node-termdallas`} />
        <TermNode uid={uid} termIdx={1} label="LA"     sublabel="PoP"   nodeClass={undefined} />
        <TermNode uid={uid} termIdx={2} label="Backup" sublabel="Trunk" nodeClass={undefined} />

        {/* ── Column header labels ───────────────────────────────── */}
        <ColumnLabel text="ORIGINATION"  x={COL.inbound}                      y={24} />
        <ColumnLabel text="DISTRIBUTION" x={COL.nlb}                          y={24} />
        <ColumnLabel text="PROCESSING"   x={(COL.locIn + COL.locOut) / 2}     y={24} />
        <ColumnLabel text="TERMINATION"  x={COL.termX}                        y={24} />
      </svg>
      </div>
      </div>
    </>
  );
}

/* ─── Sub-components ─────────────────────────────────────────────────── */

function ColumnLabel({ text, x, y }: { text: string; x: number; y: number }) {
  return (
    <g>
      <text
        x={x} y={y}
        textAnchor="middle"
        fontSize="11.5"
        fontFamily={'"Archivo", "IBM Plex Sans", sans-serif'}
        letterSpacing="0.22em"
        fill="rgba(168,193,232,0.80)"
        fontWeight="700"
      >
        {text}
      </text>
      {/* Azure stage tick — echoes the landing tag mark */}
      <rect x={x - 11} y={y + 7} width={22} height={2.5} fill="rgba(47,125,246,0.60)" />
    </g>
  );
}

/**
 * InboundTrunkNode
 * One of two redundant inbound carrier trunks.
 */
function InboundTrunkNode({
  uid,
  cy,
  label,
}: {
  uid: string;
  cy: number;
  label: string;
}) {
  const cx = COL.inbound;
  const W  = 64;
  const H  = 32;
  const R  = 8;

  return (
    <g transform={`translate(${cx}, ${cy})`}>
      <circle r="44" fill={`url(#${uid}-ng)`} />
      <rect
        x={-W / 2} y={-H / 2}
        width={W} height={H} rx={R}
        fill="rgba(15,17,23,0.75)"
        stroke="rgba(59,130,246,0.38)"
        strokeWidth="1.1"
      />
      {/* Top shimmer */}
      <rect
        x={-W / 2 + 1} y={-H / 2 + 1}
        width={W - 2} height={H * 0.28} rx={R - 1}
        fill="rgba(96,165,250,0.07)"
      />
      {/* Bandwidth / signal bars */}
      <g transform="translate(-8, -8)" opacity="0.62">
        <rect x="0"   y="8.5" width="3.8" height="5.5"  rx="1" fill="rgba(96,165,250,0.70)" />
        <rect x="5.6" y="6"   width="3.8" height="8"    rx="1" fill="rgba(96,165,250,0.70)" />
        <rect x="11.2" y="2.5" width="3.8" height="11.5" rx="1" fill="rgba(96,165,250,0.70)" />
      </g>
      <text y={H / 2 + 14} textAnchor="middle" fontSize="9" stroke="rgba(8,14,26,0.85)" strokeWidth="3" paintOrder="stroke"
        fontFamily={'"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace'}
        letterSpacing="0.08em" fill="rgba(196,212,236,0.85)" fontWeight="600">
        {label}
      </text>
    </g>
  );
}

/**
 * NlbNode — Key Distributor (GCP Global Load Balancer).
 * Renders both the primary (active) and backup (standby) instances.
 * The backup is visually dimmed during normal operation and has a "STANDBY"
 * sub-label in amber to indicate hot-standby status.
 */
function NlbNode({
  uid,
  cy,
  isBackup,
  nodeClass,
}: {
  uid: string;
  cy: number;
  isBackup: boolean;
  nodeClass?: string;
}) {
  const cx = COL.nlb;
  // Slightly smaller image for backup to reinforce subordinate role
  const S  = isBackup ? 46 : 56;

  return (
    <g transform={`translate(${cx}, ${cy})`} className={nodeClass}>
      {/* Ambient glow halo — amber for backup, blue for primary */}
      <circle
        r={isBackup ? 52 : 66}
        fill={isBackup ? `url(#${uid}-ag)` : `url(#${uid}-lg)`}
      />
      <image
        href="/key_distributor.png"
        x={-S / 2} y={-S / 2}
        width={S} height={S}
        filter={`url(#${isBackup ? `${uid}-imgf-dim` : `${uid}-imgf`})`}
        preserveAspectRatio="xMidYMid meet"
      />
      <text y={S / 2 + 14} textAnchor="middle" fontSize={isBackup ? 8.5 : 9.5} stroke="rgba(8,14,26,0.85)" strokeWidth="3" paintOrder="stroke"
        fontFamily={'"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace'}
        letterSpacing="0.07em"
        fill={isBackup ? 'rgba(170,186,210,0.66)' : 'rgba(203,219,242,0.90)'}
        fontWeight="600">
        Key Distributor
      </text>
      {/* Role tag — azure PRIMARY / amber STANDBY */}
      <text y={S / 2 + 25} textAnchor="middle" fontSize="7" stroke="rgba(8,14,26,0.85)" strokeWidth="3" paintOrder="stroke"
        fontFamily={'"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace'}
        letterSpacing="0.14em"
        fill={isBackup ? 'rgba(245,158,11,0.70)' : 'rgba(96,165,250,0.72)'}
        fontWeight="700">
        {isBackup ? 'STANDBY' : 'PRIMARY'}
      </text>
    </g>
  );
}

/* ── Geographic Location Container ── */
function LocationGroup({
  uid,
  locIdx,
  label,
  locClass,
  sbc1Class,
  sbc2Class,
  sbc2CentralClass,
}: {
  uid: string;
  locIdx: number;
  label: string;
  locClass?: string;
  sbc1Class?: string;
  sbc2Class?: string;
  sbc2CentralClass?: string;
}) {
  const cy  = LOC_Y[locIdx];
  const x   = COL.locIn;
  const h   = LOC_HALF_H * 2;
  const R   = 10;
  const top = cy - LOC_HALF_H;

  const sbc1Y = cy - SBC_OFFSET;
  const sbc2Y = cy + SBC_OFFSET;

  return (
    <g className={locClass}>
      {/* Container background — reads as a self-contained availability zone */}
      <rect
        x={x}
        y={top}
        width={LOC_W}
        height={h}
        rx={R}
        fill="rgba(16,26,45,0.55)"
        stroke="rgba(79,146,255,0.32)"
        strokeWidth="1.1"
      />
      {/* Title bar — rounded top corners only */}
      <path
        d={topRoundedRect(x + 0.6, top + 0.6, LOC_W - 1.2, LOC_TITLE_H, R - 1)}
        fill="rgba(47,125,246,0.10)"
      />
      <line
        x1={x} y1={top + LOC_TITLE_H}
        x2={x + LOC_W} y2={top + LOC_TITLE_H}
        stroke="rgba(79,146,255,0.24)"
        strokeWidth="1"
      />
      {/* Zone tick + name */}
      <rect x={x + 14} y={top + 10.5} width={9} height={5} fill="rgba(47,125,246,0.85)" />
      <text
        x={x + 31}
        y={top + 18}
        fontSize="12"
        fontFamily={'"Archivo", "IBM Plex Sans", sans-serif'}
        letterSpacing="0.14em"
        fill="#d3e2fb"
        fontWeight="700"
      >
        {label.toUpperCase()}
      </text>
      {/* Zone descriptor — right side of title bar */}
      <text
        x={x + LOC_W - 14}
        y={top + 17.5}
        textAnchor="end"
        fontSize="7.5"
        fontFamily={'"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace'}
        letterSpacing="0.12em"
        fill="rgba(143,176,232,0.55)"
        fontWeight="600"
      >
        INDEPENDENT ZONE
      </text>

      {/* SBC-1 (upper) */}
      <SbcNode uid={uid} cx={COL.sbc1X} cy={sbc1Y} label="Signal Key 1" nodeClass={sbc1Class} />

      {/* SBC-2 (lower) */}
      <SbcNode
        uid={uid}
        cx={COL.sbc2X}
        cy={sbc2Y}
        label="Signal Key 2"
        nodeClass={sbc2CentralClass ?? sbc2Class}
      />

      {/* CRAG engine — right side of the container */}
      <KsNode uid={uid} cx={COL.ksX} cy={cy} />
    </g>
  );
}

/* ── Individual SBC / Signal Key node ── */
function SbcNode({
  uid,
  cx,
  cy,
  label,
  nodeClass,
}: {
  uid: string;
  cx: number;
  cy: number;
  label: string;
  nodeClass?: string;
}) {
  const S = 36;

  return (
    <g transform={`translate(${cx}, ${cy})`} className={nodeClass}>
      <circle r="30" fill={`url(#${uid}-ng)`} />
      <image
        href="/signal_key.png"
        x={-S / 2} y={-S / 2}
        width={S} height={S}
        filter={`url(#${uid}-imgf)`}
        preserveAspectRatio="xMidYMid meet"
      />
      <text y={S / 2 + 11} textAnchor="middle" fontSize="8.5" stroke="rgba(8,14,26,0.85)" strokeWidth="3" paintOrder="stroke"
        fontFamily={'"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace'}
        letterSpacing="0.06em" fill="rgba(196,212,236,0.82)" fontWeight="600">
        {label}
      </text>
    </g>
  );
}

/* ── CRAG Media Engine — logo image node ── */
function KsNode({ uid, cx, cy }: { uid: string; cx: number; cy: number }) {
  const S = 44;
  return (
    <g transform={`translate(${cx}, ${cy})`}>
      <circle r="38" fill={`url(#${uid}-ng)`} />
      <image
        href="/crag.png"
        x={-S / 2}
        y={-S / 2}
        width={S}
        height={S}
        filter={`url(#${uid}-imgf)`}
        preserveAspectRatio="xMidYMid meet"
      />
      <text y={S / 2 + 13} textAnchor="middle" fontSize="8.5" stroke="rgba(8,14,26,0.85)" strokeWidth="3" paintOrder="stroke"
        fontFamily={'"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace'}
        letterSpacing="0.06em" fill="rgba(147,197,253,0.80)" fontWeight="600">
        CRAG Engine
      </text>
    </g>
  );
}

/* ── Termination Trunk — green-accented pill ── */
function TermNode({
  uid,
  termIdx,
  label,
  sublabel,
  nodeClass,
}: {
  uid: string;
  termIdx: number;
  label: string;
  sublabel: string;
  nodeClass?: string;
}) {
  const cx = COL.termX;
  const cy = TERM_Y[termIdx];
  const W  = 76;
  const H  = 42;
  const R  = 9;

  return (
    <g transform={`translate(${cx}, ${cy})`} className={nodeClass}>
      <circle r="52" fill={`url(#${uid}-tg)`} />
      <rect
        x={-W / 2} y={-H / 2}
        width={W} height={H} rx={R}
        fill="rgba(15,17,23,0.72)"
        stroke="rgba(52,211,153,0.36)"
        strokeWidth="1.1"
      />
      <rect
        x={-W / 2 + 1} y={-H / 2 + 1}
        width={W - 2} height={H * 0.28} rx={R - 1}
        fill="rgba(52,211,153,0.06)"
      />
      <circle r="3.5" cx="0" cy="0" fill="rgba(52,211,153,0.40)" />
      <circle r="1.8" cx="0" cy="0" fill="rgba(167,243,208,0.92)" />
      <text y={H / 2 + 15} textAnchor="middle" fontSize="10" stroke="rgba(8,14,26,0.85)" strokeWidth="3" paintOrder="stroke"
        fontFamily={'"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace'}
        letterSpacing="0.08em" fill="rgba(196,222,210,0.88)" fontWeight="600">
        {label}
      </text>
      <text y={H / 2 + 26} textAnchor="middle" fontSize="7.5" stroke="rgba(8,14,26,0.85)" strokeWidth="3" paintOrder="stroke"
        fontFamily={'"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace'}
        letterSpacing="0.07em" fill="rgba(134,158,150,0.62)" fontWeight="500">
        {sublabel}
      </text>
    </g>
  );
}

/* ── Status indicator — colour-keyed chip in the card header ── */
/*
 * The six state rows are absolutely stacked inside a fixed-height chip and
 * toggled by the existing 50s step-start animation classes — the chip is
 * styling only; timings and class taxonomy are unchanged.
 */
function StatusIndicatorHtml({ uid }: { uid: string }) {
  const dotStyle = (color: string): CSSProperties => ({
    width: 9,
    height: 9,
    borderRadius: '50%',
    background: color,
    flexShrink: 0,
    position: 'relative',
  });

  const haloStyle = (color: string): CSSProperties => ({
    position: 'absolute',
    inset: -3,
    borderRadius: '50%',
    background: color,
  });

  const rowStyle = (accent: string, bg: string, border: string): CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    position: 'absolute',
    inset: 0,
    padding: '0 16px',
    borderRadius: 8,
    border: `1px solid ${border}`,
    borderLeft: `3px solid ${accent}`,
    background: bg,
  });

  const okRow = rowStyle(
    'rgba(34,197,94,0.90)', 'rgba(34,197,94,0.07)', 'rgba(34,197,94,0.30)',
  );
  const alertRow: CSSProperties = {
    ...rowStyle('rgba(239,68,68,0.95)', 'rgba(239,68,68,0.08)', 'rgba(239,68,68,0.35)'),
    opacity: 0,
  };

  const okText: CSSProperties = {
    fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: '0.74rem',
    fontWeight: 600,
    letterSpacing: '0.05em',
    color: 'rgba(167,243,208,0.95)',
    whiteSpace: 'nowrap',
  };

  const alertText: CSSProperties = {
    fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: '0.74rem',
    fontWeight: 700,
    letterSpacing: '0.04em',
    color: 'rgba(254,202,202,0.98)',
    textShadow: '0 0 12px rgba(239,68,68,0.45)',
    whiteSpace: 'nowrap',
  };

  const alertDot = (
    <div style={{ position: 'relative', width: 9, height: 9, flexShrink: 0 }}>
      <div style={haloStyle('rgba(239,68,68,0.30)')} className={`${uid}-alert-halo`} />
      <div style={dotStyle('rgba(239,68,68,0.95)')} />
    </div>
  );

  return (
    <div style={{ position: 'relative', height: 40, width: 350, maxWidth: '100%' }}>
      {/* Normal — green */}
      <div className={`${uid}-status-normal`} style={okRow}>
        <div style={{ position: 'relative', width: 9, height: 9, flexShrink: 0 }}>
          <div style={haloStyle('rgba(34,197,94,0.18)')} />
          <div style={dotStyle('rgba(34,197,94,0.90)')} />
        </div>
        <span style={okText}>All Systems Operational</span>
      </div>

      {/* Failover: Signal Key 2 Granite Central */}
      <div className={`${uid}-status-sbc2c`} style={alertRow}>
        {alertDot}
        <span style={alertText}>Failover: Signal Key 2 Granite Central</span>
      </div>

      {/* Failover: Granite West Zone */}
      <div className={`${uid}-status-west`} style={alertRow}>
        {alertDot}
        <span style={alertText}>Failover: Granite West Zone</span>
      </div>

      {/* Failover: Dallas PoP */}
      <div className={`${uid}-status-dallas`} style={alertRow}>
        {alertDot}
        <span style={alertText}>Failover: Dallas PoP</span>
      </div>

      {/* Failover: Signal Key 1 Granite East */}
      <div className={`${uid}-status-sbc1e`} style={alertRow}>
        {alertDot}
        <span style={alertText}>Failover: Signal Key 1 Granite East</span>
      </div>

      {/* Failover: Primary Key Distributor */}
      <div className={`${uid}-status-kdprimary`} style={alertRow}>
        {alertDot}
        <span style={alertText}>Failover: Primary Key Distributor</span>
      </div>
    </div>
  );
}

export default HaArchitectureViz;
