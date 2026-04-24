import { type CSSProperties, useMemo } from 'react';

/**
 * HaArchitectureViz
 *
 * SVG-based animated diagram visualising the Granite Keystone HA
 * call-routing architecture in a horizontal left-to-right flow.
 *
 * Architecture (each location has two discrete SBC nodes):
 *
 *                                    ┌─ Granite East: [SBC-1][SBC-2] → [Keystone] ──┐
 *  [Inbound] → [Keystone] ──────────┼─ Granite Central:[SBC-1][SBC-2]→ [Keystone] ──┼→ [Dallas]
 *    Trunk      HA Server           └─ Granite West:  [SBC-1][SBC-2] → [Keystone] ──┤→ [LA]
 *                                                                               └→ [Backup]
 *
 * Failover simulation — a 64-second CSS keyframe cycle drives four scenarios:
 *   0–8s   Normal operation
 *   8–16s  SBC-2 in Granite Central fails → traffic reroutes through SBC-1
 *  16–24s  Normal operation
 *  24–32s  Granite West datacenter fails → traffic reroutes to East + Central
 *  32–40s  Normal operation
 *  40–48s  Dallas trunk fails → outbound reroutes to LA + Backup
 *  48–56s  Normal operation
 *  56–64s  SBC-1 in Granite East fails → traffic reroutes through SBC-2
 *
 * Status indicator at top-centre shows current failover state.
 * Pure SVG + CSS animations. No JavaScript timers, no requestAnimationFrame.
 */

/* ─── Geometry constants ─────────────────────────────────────────────── */

const VB_W = 1200;
const VB_H = 300;

// Column x-positions
const COL = {
  inbound: 80,    // Stage 1: inbound trunk node
  nlb:     240,   // Stage 2: NLB / geo-router
  locIn:   370,   // left edge of location containers
  locOut:  800,   // right edge of location containers
  sbc1X:   468,   // SBC-1 node centre (upper SBC within location)
  sbc2X:   468,   // SBC-2 node centre — same X as SBC-1, stacked vertically
  ksX:     660,   // Keystone engine node centre (right of SBC column)
  termX:   1120,  // Stage 4: termination trunk nodes (near right edge of 1200px viewBox)
} as const;

// Row y-centres for each geographic location
const LOC_Y = [68, 150, 232] as const;   // Granite East, Granite Central, Granite West
const LOC_HALF_H = 36;                    // half-height of each location container
const LOC_W = COL.locOut - COL.locIn;    // 392px

// SBC node offsets within a location (relative to location centre y)
const SBC_OFFSET = 17; // SBC-1 is cy-17, SBC-2 is cy+17

// Termination trunk y-positions
const TERM_Y = [82, 150, 218] as const;  // Dallas, LA, Backup

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

/* ─── Failover group taxonomy ────────────────────────────────────────── */
/**
 * Each path and packet belongs to one or more failover groups.
 * During a failure event, the relevant group gets a CSS class that
 * drives opacity to 0 via the master 64-second keyframe cycle.
 *
 * Groups:
 *   'normal'         — always visible
 *   'sbc2-central'   — SBC-2 in Granite Central (fails 8-16s)
 *   'west-loc'       — entire Granite West datacenter (fails 24-32s)
 *   'term-dallas'    — Dallas termination trunk (fails 40-48s)
 *   'sbc1-east'      — SBC-1 in Granite East (fails 56-64s)
 *
 * Reroute groups (only visible during their paired failure):
 *   'reroute-sbc2central'  — extra packets through SBC-1 central when SBC-2 fails
 *   'reroute-west'         — extra packets through East/Central when West fails
 *   'reroute-dallas'       — extra packets through LA/Backup when Dallas fails
 *   'reroute-sbc1east'     — extra packets through SBC-2 east when SBC-1 fails
 */
type FailoverGroup =
  | 'normal'
  | 'sbc2-central'
  | 'west-loc'
  | 'term-dallas'
  | 'west-loc-or-dallas'   // hides during BOTH west datacenter AND dallas trunk failures
  | 'sbc1-east'
  | 'reroute-sbc2central'
  | 'reroute-west'
  | 'reroute-dallas'
  | 'reroute-sbc1east';

interface PathDef {
  id: string;
  d: string;
  group: FailoverGroup;
}

/* ─── Path definitions ───────────────────────────────────────────────── */

// Stage 1→2: Dual inbound trunks → NLB (Keystone HA Server)
// Trunk 1 (upper, y≈133) curves slightly up into NLB at y=150
const PATH_INBOUND1_NLB: PathDef = {
  id: 'in1-nlb',
  group: 'normal',
  d: quadPath(COL.inbound + 20, 133, (COL.inbound + COL.nlb) / 2, 130, COL.nlb - 26, 150),
};
// Trunk 2 (lower, y≈167) curves slightly down into NLB at y=150
const PATH_INBOUND2_NLB: PathDef = {
  id: 'in2-nlb',
  group: 'normal',
  d: quadPath(COL.inbound + 20, 167, (COL.inbound + COL.nlb) / 2, 170, COL.nlb - 26, 150),
};

// Stage 2→3: NLB → SBC-1 and SBC-2 for each location
// Each location has two entry paths (one per SBC)
function makeNlbToSbc(
  locIdx: number,
  sbcNum: 1 | 2,
  group: FailoverGroup,
  id: string,
): PathDef {
  const sbcColX = sbcNum === 1 ? COL.sbc1X : COL.sbc2X;
  const sbcOffset = sbcNum === 1 ? -SBC_OFFSET : SBC_OFFSET;
  const locY = LOC_Y[locIdx];
  const targetY = locY + sbcOffset;
  const cpX = (COL.nlb + sbcColX) / 2;
  return {
    id,
    group,
    d: quadPath(COL.nlb + 26, 150, cpX, targetY, sbcColX - 14, targetY),
  };
}

const PATH_NLB_E1: PathDef  = makeNlbToSbc(0, 1, 'sbc1-east',   'nlb-e1');
const PATH_NLB_E2: PathDef  = makeNlbToSbc(0, 2, 'normal',      'nlb-e2');
const PATH_NLB_C1: PathDef  = makeNlbToSbc(1, 1, 'normal',      'nlb-c1');
const PATH_NLB_C2: PathDef  = makeNlbToSbc(1, 2, 'sbc2-central','nlb-c2');
const PATH_NLB_W1: PathDef  = makeNlbToSbc(2, 1, 'west-loc',    'nlb-w1');
const PATH_NLB_W2: PathDef  = makeNlbToSbc(2, 2, 'west-loc',    'nlb-w2');

// Stage 3 internal: SBC → Keystone (within each location)
function makeSbcToKs(
  locIdx: number,
  sbcNum: 1 | 2,
  group: FailoverGroup,
  id: string,
): PathDef {
  const sbcColX = sbcNum === 1 ? COL.sbc1X : COL.sbc2X;
  const sbcOffset = sbcNum === 1 ? -SBC_OFFSET : SBC_OFFSET;
  const locY = LOC_Y[locIdx];
  const y1 = locY + sbcOffset;
  const y2 = locY;
  // Cubic bezier: slight arc converging to Keystone centre
  const cp1X = sbcColX + (COL.ksX - sbcColX) * 0.35;
  const cp2X = sbcColX + (COL.ksX - sbcColX) * 0.65;
  return {
    id,
    group,
    d: cubicPath(sbcColX + 14, y1, cp1X, y1, cp2X, y2, COL.ksX - 18, y2),
  };
}

const PATH_SBC1_KS_E: PathDef  = makeSbcToKs(0, 1, 'sbc1-east',    's1ks-e');
const PATH_SBC2_KS_E: PathDef  = makeSbcToKs(0, 2, 'normal',       's2ks-e');
const PATH_SBC1_KS_C: PathDef  = makeSbcToKs(1, 1, 'normal',       's1ks-c');
const PATH_SBC2_KS_C: PathDef  = makeSbcToKs(1, 2, 'sbc2-central', 's2ks-c');
const PATH_SBC1_KS_W: PathDef  = makeSbcToKs(2, 1, 'west-loc',     's1ks-w');
const PATH_SBC2_KS_W: PathDef  = makeSbcToKs(2, 2, 'west-loc',     's2ks-w');

// Stage 3→4: each location Keystone → each termination trunk (9 paths)
// Paths originate from the right edge of the Keystone engine node (ksX + 14),
// since Keystone is the entity that dispatches calls to the termination trunks.
function makeTermPath(
  locIdx: number,
  termIdx: number,
  group: FailoverGroup,
  id: string,
): PathDef {
  const x1 = COL.ksX + 14;  // right edge of KsNode (S=28, so half = 14)
  const y1 = LOC_Y[locIdx];
  const x2 = COL.termX - 22;
  const y2 = TERM_Y[termIdx];
  const cp1X = x1 + (x2 - x1) * 0.38;
  const cp2X = x1 + (x2 - x1) * 0.62;
  return {
    id,
    group,
    d: cubicPath(x1, y1, cp1X, y1, cp2X, y2, x2, y2),
  };
}

// Dallas-bound paths (e-t0, c-t0, w-t0) are in the 'term-dallas' failover group
// so they fade when the Dallas trunk fails during the 40–48s window.
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
// West paths are also in 'west-loc' so they disappear during datacenter failure.
// West→Dallas is doubly-faulted (west-loc takes precedence; handled by packet groups).
const PATHS_WEST_TERM = [
  makeTermPath(2, 0, 'west-loc',    'w-t0'),
  makeTermPath(2, 1, 'west-loc',    'w-t1'),
  makeTermPath(2, 2, 'west-loc',    'w-t2'),
];

// All static paths (no reroute paths need separate SVG <path> elements
// because we render extra packets on existing healthy paths)
const PATHS: PathDef[] = [
  PATH_INBOUND1_NLB, PATH_INBOUND2_NLB,
  PATH_NLB_E1, PATH_NLB_E2,
  PATH_NLB_C1, PATH_NLB_C2,
  PATH_NLB_W1, PATH_NLB_W2,
  PATH_SBC1_KS_E, PATH_SBC2_KS_E,
  PATH_SBC1_KS_C, PATH_SBC2_KS_C,
  PATH_SBC1_KS_W, PATH_SBC2_KS_W,
  ...PATHS_EAST_TERM,
  ...PATHS_CENTRAL_TERM,
  ...PATHS_WEST_TERM,
];

/* ─── Packet animation config ────────────────────────────────────────── */

/**
 * PacketConfig describes one animated dot:
 *   pathId   — which SVG path it rides
 *   delay    — animation-delay for staggering
 *   duration — time for one full traversal
 *   group    — which failover scenario controls its visibility
 *   isTerm   — render green (termination leg) vs blue (processing leg)
 */
interface PacketConfig {
  pathId: string;
  delay: number;
  duration: number;
  group: FailoverGroup;
  isTerm: boolean;
}

function makePackets(
  pathId: string,
  count: number,
  duration: number,
  group: FailoverGroup,
  isTerm = false,
  startDelay = 0,
): PacketConfig[] {
  return Array.from({ length: count }, (_, i) => ({
    pathId,
    delay: startDelay + (duration / count) * i,
    duration,
    group,
    isTerm,
  }));
}

const ALL_PACKETS: PacketConfig[] = [
  // Dual inbound trunks → NLB (both always flowing — staggered for visual separation)
  ...makePackets('in1-nlb', 3, 1.2, 'normal', false, 0.0),
  ...makePackets('in2-nlb', 3, 1.2, 'normal', false, 0.6),

  // NLB → SBC-1 and SBC-2 for each location (normal operation)
  ...makePackets('nlb-e1', 3, 1.6, 'sbc1-east',   false, 0.0),
  ...makePackets('nlb-e2', 3, 1.6, 'normal',       false, 0.8),
  ...makePackets('nlb-c1', 3, 1.6, 'normal',      false, 0.3),
  ...makePackets('nlb-c2', 3, 1.6, 'sbc2-central',false, 1.1),
  ...makePackets('nlb-w1', 3, 1.6, 'west-loc',    false, 0.5),
  ...makePackets('nlb-w2', 3, 1.6, 'west-loc',    false, 1.3),

  // SBC-1 → East Keystone (normal; fails during sbc1-east event)
  ...makePackets('s1ks-e', 3, 1.0, 'sbc1-east', false, 0.2),
  // SBC-2 → East Keystone (normal always)
  ...makePackets('s2ks-e', 3, 1.0, 'normal',    false, 0.7),

  // SBC-1 → Central Keystone (normal always)
  ...makePackets('s1ks-c', 3, 1.0, 'normal',       false, 0.4),
  // SBC-2 → Central Keystone (fails during sbc2-central event)
  ...makePackets('s2ks-c', 3, 1.0, 'sbc2-central', false, 0.9),

  // SBC-1/2 → West Keystone (fail during west-loc event)
  ...makePackets('s1ks-w', 3, 1.0, 'west-loc', false, 0.1),
  ...makePackets('s2ks-w', 3, 1.0, 'west-loc', false, 0.6),

  // East Keystone → termination trunks
  ...makePackets('e-t0', 2, 1.8, 'term-dallas', true,  0.0),
  ...makePackets('e-t1', 2, 1.8, 'normal',      true,  0.2),
  ...makePackets('e-t2', 2, 1.8, 'normal',      true,  0.4),

  // Central Keystone → termination trunks
  ...makePackets('c-t0', 2, 1.8, 'term-dallas', true,  0.6),
  ...makePackets('c-t1', 2, 1.8, 'normal',      true,  0.8),
  ...makePackets('c-t2', 2, 1.8, 'normal',      true,  1.0),

  // West Keystone → termination trunks (fail during west-loc event)
  // w-t0 (Dallas-bound from West) must ALSO stop during the Dallas failure window,
  // so it uses the combined 'west-loc-or-dallas' group instead of plain 'west-loc'.
  ...makePackets('w-t0', 2, 1.8, 'west-loc-or-dallas', true,  0.3),
  ...makePackets('w-t1', 2, 1.8, 'west-loc',            true,  0.5),
  ...makePackets('w-t2', 2, 1.8, 'west-loc',            true,  0.7),

  // ── Reroute packets: only appear during their specific failure event ──

  // When SBC-2 Central fails → SBC-1 Central absorbs extra load
  ...makePackets('s1ks-c', 3, 0.9, 'reroute-sbc2central', false, 0.1),
  ...makePackets('nlb-c1', 3, 1.4, 'reroute-sbc2central', false, 0.3),

  // When West datacenter fails → East and Central absorb extra load
  ...makePackets('nlb-e1', 3, 1.2, 'reroute-west', false, 0.1),
  ...makePackets('nlb-c1', 3, 1.2, 'reroute-west', false, 0.5),
  ...makePackets('s1ks-e', 3, 0.8, 'reroute-west', false, 0.2),
  ...makePackets('s1ks-c', 3, 0.8, 'reroute-west', false, 0.4),
  ...makePackets('e-t1',   2, 1.4, 'reroute-west', true,  0.2),
  ...makePackets('c-t1',   2, 1.4, 'reroute-west', true,  0.4),

  // When Dallas fails → LA and Backup absorb extra load
  ...makePackets('e-t1', 2, 1.3, 'reroute-dallas', true, 0.1),
  ...makePackets('e-t2', 2, 1.3, 'reroute-dallas', true, 0.3),
  ...makePackets('c-t1', 2, 1.3, 'reroute-dallas', true, 0.2),
  ...makePackets('c-t2', 2, 1.3, 'reroute-dallas', true, 0.4),

  // When SBC-1 East fails → SBC-2 East absorbs extra load
  ...makePackets('s2ks-e', 3, 0.8, 'reroute-sbc1east', false, 0.1),
  ...makePackets('nlb-e2', 3, 1.3, 'reroute-sbc1east', false, 0.3),
];

/* ─── Failover timing (master 64-second cycle) ───────────────────────── */
/**
 * t = time in seconds within the 64s cycle
 * pct(t) = t/64 * 100 expressed as a percentage string
 *
 * Schedule:
 *   0–8s    (0–12.5%)    Normal
 *   8–16s   (12.5–25%)   SBC-2 Central fails
 *   16–24s  (25–37.5%)   Normal
 *   24–32s  (37.5–50%)   West datacenter fails
 *   32–40s  (50–62.5%)   Normal
 *   40–48s  (62.5–75%)   Dallas trunk fails
 *   48–56s  (75–87.5%)   Normal
 *   56–64s  (87.5–100%)  SBC-1 East fails
 */

/* ─── Component ──────────────────────────────────────────────────────── */

export function HaArchitectureViz() {
  const uid = useMemo(
    () => `ha-${Math.random().toString(36).substring(2, 8)}`,
    [],
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

    // 2. Per-packet CSS class rules
    // Each packet gets a traversal animation AND a visibility animation
    // driven by its failover group and the 64s master cycle.

    /**
     * For each failover group, define an opacity keyframe over 64s:
     *
     *   'normal'             — always 1
     *   'sbc2-central'       — 0→12.5%: 1, 12.5%: fade to 0.15, 25%: back to 1, rest: 1
     *   'west-loc'           — 0→37.5%: 1, 37.5%: fade to 0.15, 50%: back to 1, rest: 1
     *   'term-dallas'        — 0→62.5%: 1, 62.5%: fade to 0.15, 75%: back to 1, rest: 1
     *   'sbc1-east'          — 0→87.5%: 1, 87.5%: fade to 0.15, 100%: 1
     *   'reroute-sbc2central'— only visible 12.5–25%, zero otherwise
     *   'reroute-west'       — only visible 37.5–50%
     *   'reroute-dallas'     — only visible 62.5–75%
     *   'reroute-sbc1east'   — only visible 87.5–100%
     */

    // Group visibility keyframes (all 64s cycle)
    const groupKf = `
@keyframes ${uid}-vis-normal {
  0%, 100% { opacity: 1; }
}
@keyframes ${uid}-vis-sbc2central {
  0%, 12.4%  { opacity: 1; filter: none; }
  12.5%      { opacity: 0.15; filter: sepia(1) hue-rotate(320deg) brightness(1.2); }
  24.9%      { opacity: 0.15; filter: sepia(1) hue-rotate(320deg) brightness(1.2); }
  25%        { opacity: 1; filter: none; }
  100%       { opacity: 1; filter: none; }
}
@keyframes ${uid}-vis-westloc {
  0%, 37.4%  { opacity: 1; filter: none; }
  37.5%      { opacity: 0.15; filter: sepia(1) hue-rotate(20deg) brightness(1.8); }
  49.9%      { opacity: 0.15; filter: sepia(1) hue-rotate(20deg) brightness(1.8); }
  50%        { opacity: 1; filter: none; }
  100%       { opacity: 1; filter: none; }
}
@keyframes ${uid}-vis-termdallas {
  0%, 62.4%  { opacity: 1; filter: none; }
  62.5%      { opacity: 0.15; filter: sepia(1) hue-rotate(320deg) brightness(1.2); }
  74.9%      { opacity: 0.15; filter: sepia(1) hue-rotate(320deg) brightness(1.2); }
  75%        { opacity: 1; filter: none; }
  100%       { opacity: 1; filter: none; }
}
@keyframes ${uid}-vis-sbc1east {
  0%, 87.4%  { opacity: 1; filter: none; }
  87.5%      { opacity: 0.15; filter: sepia(1) hue-rotate(320deg) brightness(1.2); }
  99.9%      { opacity: 0.15; filter: sepia(1) hue-rotate(320deg) brightness(1.2); }
  100%       { opacity: 1; filter: none; }
}
@keyframes ${uid}-pkt-sbc2central {
  0%, 12.4%  { opacity: 1; }
  12.5%      { opacity: 0; }
  24.9%      { opacity: 0; }
  25%, 100%  { opacity: 1; }
}
@keyframes ${uid}-pkt-westloc {
  0%, 37.4%  { opacity: 1; }
  37.5%      { opacity: 0; }
  49.9%      { opacity: 0; }
  50%, 100%  { opacity: 1; }
}
@keyframes ${uid}-pkt-termdallas {
  0%, 62.4%  { opacity: 1; }
  62.5%      { opacity: 0; }
  74.9%      { opacity: 0; }
  75%, 100%  { opacity: 1; }
}
@keyframes ${uid}-pkt-westloc-or-dallas {
  0%, 37.4%  { opacity: 1; }
  37.5%      { opacity: 0; }
  49.9%      { opacity: 0; }
  50%, 62.4% { opacity: 1; }
  62.5%      { opacity: 0; }
  74.9%      { opacity: 0; }
  75%, 100%  { opacity: 1; }
}
@keyframes ${uid}-pkt-sbc1east {
  0%, 87.4%  { opacity: 1; }
  87.5%      { opacity: 0; }
  99.9%      { opacity: 0; }
  100%       { opacity: 1; }
}
@keyframes ${uid}-pkt-reroute-sbc2c {
  0%, 12.4%  { opacity: 0; }
  12.5%      { opacity: 1; }
  24.9%      { opacity: 1; }
  25%, 100%  { opacity: 0; }
}
@keyframes ${uid}-pkt-reroute-west {
  0%, 37.4%  { opacity: 0; }
  37.5%      { opacity: 1; }
  49.9%      { opacity: 1; }
  50%, 100%  { opacity: 0; }
}
@keyframes ${uid}-pkt-reroute-dallas {
  0%, 62.4%  { opacity: 0; }
  62.5%      { opacity: 1; }
  74.9%      { opacity: 1; }
  75%, 100%  { opacity: 0; }
}
@keyframes ${uid}-pkt-reroute-sbc1e {
  0%, 87.4%  { opacity: 0; }
  87.5%      { opacity: 1; }
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
        ? `${pkt.duration}s, 64s`
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

      // Reroute packets start invisible (visibility animation controls them)
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

    // 3. Node visibility animations (drive the node opacity during failure)
    // These use the same 64s cycle but with smooth transitions instead of steps
    const nodeKf = `
@keyframes ${uid}-node-sbc2central {
  0%, 12.4%  { opacity: 1; filter: none; }
  13%        { opacity: 0.15; filter: sepia(1) hue-rotate(320deg) brightness(1.4); }
  24.5%      { opacity: 0.15; filter: sepia(1) hue-rotate(320deg) brightness(1.4); }
  25.2%      { opacity: 1; filter: none; }
  100%       { opacity: 1; filter: none; }
}
@keyframes ${uid}-node-westloc {
  0%, 37.4%  { opacity: 1; filter: none; }
  38%        { opacity: 0.15; filter: sepia(1) hue-rotate(20deg) brightness(2.0); }
  49.5%      { opacity: 0.15; filter: sepia(1) hue-rotate(20deg) brightness(2.0); }
  50.2%      { opacity: 1; filter: none; }
  100%       { opacity: 1; filter: none; }
}
@keyframes ${uid}-node-termdallas {
  0%, 62.4%  { opacity: 1; filter: none; }
  63%        { opacity: 0.15; filter: sepia(1) hue-rotate(320deg) brightness(1.4); }
  74.5%      { opacity: 0.15; filter: sepia(1) hue-rotate(320deg) brightness(1.4); }
  75.2%      { opacity: 1; filter: none; }
  100%       { opacity: 1; filter: none; }
}
@keyframes ${uid}-node-sbc1east {
  0%, 87.4%  { opacity: 1; filter: none; }
  88%        { opacity: 0.15; filter: sepia(1) hue-rotate(320deg) brightness(1.4); }
  99.5%      { opacity: 0.15; filter: sepia(1) hue-rotate(320deg) brightness(1.4); }
  100%       { opacity: 1; filter: none; }
}`;

    // 4. Node CSS classes
    const nodeRules = `
.${uid}-node-sbc2central {
  animation: ${uid}-node-sbc2central 64s linear infinite;
}
.${uid}-node-westloc {
  animation: ${uid}-node-westloc 64s linear infinite;
}
.${uid}-node-termdallas {
  animation: ${uid}-node-termdallas 64s linear infinite;
}
.${uid}-node-sbc1east {
  animation: ${uid}-node-sbc1east 64s linear infinite;
}`;

    // 5. Status indicator text animations (switch at exact keyframe boundaries)
    // Four text elements, only one visible at a time
    const statusKf = `
@keyframes ${uid}-status-normal {
  0%,  12.4%  { opacity: 1; }
  12.5%       { opacity: 0; }
  24.9%       { opacity: 0; }
  25%,  37.4% { opacity: 1; }
  37.5%       { opacity: 0; }
  49.9%       { opacity: 0; }
  50%, 62.4%  { opacity: 1; }
  62.5%       { opacity: 0; }
  74.9%       { opacity: 0; }
  75%, 87.4%  { opacity: 1; }
  87.5%       { opacity: 0; }
  99.9%       { opacity: 0; }
  100%        { opacity: 1; }
}
@keyframes ${uid}-status-sbc2c {
  0%, 12.4%  { opacity: 0; }
  12.5%      { opacity: 1; }
  24.9%      { opacity: 1; }
  25%, 100%  { opacity: 0; }
}
@keyframes ${uid}-status-west {
  0%, 37.4%  { opacity: 0; }
  37.5%      { opacity: 1; }
  49.9%      { opacity: 1; }
  50%, 100%  { opacity: 0; }
}
@keyframes ${uid}-status-dallas {
  0%, 62.4%  { opacity: 0; }
  62.5%      { opacity: 1; }
  74.9%      { opacity: 1; }
  75%, 100%  { opacity: 0; }
}
@keyframes ${uid}-status-sbc1e {
  0%, 87.4%  { opacity: 0; }
  87.5%      { opacity: 1; }
  99.9%      { opacity: 1; }
  100%       { opacity: 0; }
}`;

    const statusRules = `
.${uid}-status-normal  { animation: ${uid}-status-normal  64s step-start infinite; }
.${uid}-status-sbc2c   { animation: ${uid}-status-sbc2c   64s step-start infinite; opacity: 0; }
.${uid}-status-west    { animation: ${uid}-status-west    64s step-start infinite; opacity: 0; }
.${uid}-status-dallas  { animation: ${uid}-status-dallas  64s step-start infinite; opacity: 0; }
.${uid}-status-sbc1e   { animation: ${uid}-status-sbc1e   64s step-start infinite; opacity: 0; }`;

    return [pathKf, groupKf, packetRules, nodeKf, nodeRules, statusKf, statusRules].join('\n');
  }, [uid]);

  return (
    <div
      style={{
        width: '100%',
        maxWidth: 1560,
        margin: '0 auto',
        marginTop: 40,
        marginBottom: 48,
        background: 'rgba(19, 21, 29, 0.70)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        border: '1px solid rgba(59,130,246,0.12)',
        borderRadius: 20,
        padding: '24px 32px 20px',
        boxShadow: '0 4px 24px -8px rgba(0,0,0,0.50)',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* Section label */}
      <div
        style={{
          fontSize: '0.62rem',
          fontWeight: 700,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: '#3b82f6',
          marginBottom: 8,
          opacity: 0.75,
        }}
      >
        High Availability Architecture
      </div>

      <style dangerouslySetInnerHTML={{ __html: css }} />

      {/* Status indicator — HTML element above the SVG, centered */}
      <StatusIndicatorHtml uid={uid} />

      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        width="100%"
        height="auto"
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block' }}
        aria-label="Granite Keystone HA: inbound trunk routes through Keystone HA Server to three geographic locations each with two discrete SBCs and a Keystone engine, terminating via Dallas, LA, and Backup Bandwidth PoP trunks"
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
          <radialGradient id={`${uid}-ag`} cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="#f59e0b" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
          </radialGradient>

          {/* Fiber-optic beam gradients — blue for processing paths, green for termination */}
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

          {/* Clip path */}
          <clipPath id={`${uid}-clip`}>
            <rect x="0" y="0" width={VB_W} height={VB_H} />
          </clipPath>

          {/* Beam glow filter — wider and more diffuse than the old dot glow */}
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

          {/* Keystone logo glow — blue halo */}
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
        <g fill="none" clipPath={`url(#${uid}-clip)`}>
          {/* Stage 1→2: dual inbound trunks */}
          <path d={PATH_INBOUND1_NLB.d} stroke="rgba(59,130,246,0.22)" strokeWidth="1.0" />
          <path d={PATH_INBOUND2_NLB.d} stroke="rgba(59,130,246,0.22)" strokeWidth="1.0" />

          {/* Stage 2→3 fan — NLB to SBC pairs */}
          <path d={PATH_NLB_E1.d} stroke="rgba(59,130,246,0.17)" strokeWidth="0.9" />
          <path d={PATH_NLB_E2.d} stroke="rgba(59,130,246,0.17)" strokeWidth="0.9" />
          <path d={PATH_NLB_C1.d} stroke="rgba(59,130,246,0.17)" strokeWidth="0.9" />
          <path d={PATH_NLB_C2.d} stroke="rgba(59,130,246,0.17)" strokeWidth="0.9" />
          <path d={PATH_NLB_W1.d} stroke="rgba(59,130,246,0.17)" strokeWidth="0.9" />
          <path d={PATH_NLB_W2.d} stroke="rgba(59,130,246,0.17)" strokeWidth="0.9" />

          {/* Stage 3 internal — SBC to Keystone (dashed) */}
          <path d={PATH_SBC1_KS_E.d} stroke="rgba(59,130,246,0.14)" strokeWidth="0.75" strokeDasharray="3 2.5" />
          <path d={PATH_SBC2_KS_E.d} stroke="rgba(59,130,246,0.14)" strokeWidth="0.75" strokeDasharray="3 2.5" />
          <path d={PATH_SBC1_KS_C.d} stroke="rgba(59,130,246,0.14)" strokeWidth="0.75" strokeDasharray="3 2.5" />
          <path d={PATH_SBC2_KS_C.d} stroke="rgba(59,130,246,0.14)" strokeWidth="0.75" strokeDasharray="3 2.5" />
          <path d={PATH_SBC1_KS_W.d} stroke="rgba(59,130,246,0.14)" strokeWidth="0.75" strokeDasharray="3 2.5" />
          <path d={PATH_SBC2_KS_W.d} stroke="rgba(59,130,246,0.14)" strokeWidth="0.75" strokeDasharray="3 2.5" />

          {/* Stage 3→4 convergence fan — green-tinted */}
          {[...PATHS_EAST_TERM, ...PATHS_CENTRAL_TERM, ...PATHS_WEST_TERM].map((p) => (
            <path key={p.id} d={p.d} stroke="rgba(52,211,153,0.12)" strokeWidth="0.8" />
          ))}
        </g>

        {/* ── Animated fiber-optic light beams ─────────────────── */}
        {/* Each rect is 24×3px, centered at origin, oriented along the path
            via offset-rotate:auto in CSS. The linearGradient fades to
            transparent at both ends, creating a photon-pulse effect. */}
        <g clipPath={`url(#${uid}-clip)`}>
          {ALL_PACKETS.map((pkt, i) => (
            <rect
              key={i}
              x="-12"
              y="-1.5"
              width="24"
              height="3"
              rx="1.5"
              fill={pkt.isTerm ? `url(#${uid}-beam-green)` : `url(#${uid}-beam-blue)`}
              filter={`url(#${uid}-pf)`}
              className={`${uid}-p${i}`}
            />
          ))}
        </g>

        {/* ── Stage nodes ───────────────────────────────────────── */}
        {/* Dual redundant inbound trunks — stacked vertically */}
        {/* "Inbound" group label sits above the pair */}
        <text
          x={COL.inbound}
          y={116}
          textAnchor="middle"
          fontSize="6"
          fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
          letterSpacing="0.12em"
          fill="rgba(148,163,184,0.38)"
          fontWeight="700"
        >
          INBOUND
        </text>
        <InboundTrunkNode uid={uid} cy={133} label="Trunk 1" />
        <InboundTrunkNode uid={uid} cy={167} label="Trunk 2" />
        <NlbNode uid={uid} />

        {/* Three geographic location containers */}
        <LocationGroup uid={uid} locIdx={0} label="Granite East"    sbc1Class={`${uid}-node-sbc1east`}    locClass={undefined} />
        <LocationGroup uid={uid} locIdx={1} label="Granite Central" sbc2Class={undefined}                  locClass={undefined} sbc1Class={undefined} sbc2CentralClass={`${uid}-node-sbc2central`} />
        <LocationGroup uid={uid} locIdx={2} label="Granite West"    sbc2Class={undefined}                  locClass={`${uid}-node-westloc`} />

        {/* Three termination trunk nodes */}
        <TermNode uid={uid} termIdx={0} label="Dallas" sublabel="PoP"   nodeClass={`${uid}-node-termdallas`} />
        <TermNode uid={uid} termIdx={1} label="LA"     sublabel="PoP"   nodeClass={undefined} />
        <TermNode uid={uid} termIdx={2} label="Backup" sublabel="Trunk" nodeClass={undefined} />

        {/* ── Column header labels ───────────────────────────────── */}
        <ColumnLabel text="ORIGINATION"  x={COL.inbound}                      y={22} />
        <ColumnLabel text="DISTRIBUTION" x={COL.nlb}                          y={22} />
        <ColumnLabel text="PROCESSING"   x={(COL.locIn + COL.locOut) / 2}     y={22} />
        <ColumnLabel text="TERMINATION"  x={COL.termX}                        y={22} />

        {/* ── Watermark ──────────────────────────────────────────── */}
        <text
          x={VB_W - 8} y={VB_H - 6}
          textAnchor="end"
          fontSize="6"
          fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
          letterSpacing="0.12em"
          fill="rgba(59,130,246,0.18)"
          fontWeight="600"
        >
          LIVE INFRASTRUCTURE
        </text>
      </svg>
    </div>
  );
}

/* ─── Sub-components ─────────────────────────────────────────────────── */

function ColumnLabel({ text, x, y }: { text: string; x: number; y: number }) {
  return (
    <text
      x={x} y={y}
      textAnchor="middle"
      fontSize="7"
      fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
      letterSpacing="0.13em"
      fill="rgba(148,163,184,0.28)"
      fontWeight="600"
    >
      {text}
    </text>
  );
}

/**
 * InboundTrunkNode
 * One of two redundant inbound carrier trunks, rendered as a smaller rounded
 * rectangle. Both instances sit at the same x column, stacked vertically.
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
  const W  = 52;
  const H  = 26;
  const R  = 7;

  return (
    <g transform={`translate(${cx}, ${cy})`}>
      <circle r="36" fill={`url(#${uid}-ng)`} />
      <rect
        x={-W / 2} y={-H / 2}
        width={W} height={H} rx={R}
        fill="rgba(15,17,23,0.75)"
        stroke="rgba(59,130,246,0.30)"
        strokeWidth="0.9"
      />
      {/* Top shimmer */}
      <rect
        x={-W / 2 + 1} y={-H / 2 + 1}
        width={W - 2} height={H * 0.28} rx={R - 1}
        fill="rgba(96,165,250,0.07)"
      />
      {/* Bandwidth / signal bars — scaled down to fit the smaller node */}
      <g transform="translate(-6, -7)" opacity="0.52">
        <rect x="0"   y="7"  width="3" height="4"  rx="0.8" fill="rgba(96,165,250,0.60)" />
        <rect x="4.5" y="5"  width="3" height="6"  rx="0.8" fill="rgba(96,165,250,0.60)" />
        <rect x="9"   y="2"  width="3" height="9"  rx="0.8" fill="rgba(96,165,250,0.60)" />
      </g>
      {/* Label below the node */}
      <text y={H / 2 + 9} textAnchor="middle" fontSize="6.5"
        fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
        letterSpacing="0.09em" fill="rgba(148,163,184,0.60)" fontWeight="600">
        {label}
      </text>
    </g>
  );
}

/* ── NLB / Geo Router — diamond ── */
function NlbNode({ uid }: { uid: string }) {
  const cx = COL.nlb;
  const cy = 150;
  const s  = 26;

  return (
    <g transform={`translate(${cx}, ${cy})`}>
      <circle r="56" fill={`url(#${uid}-lg)`} />
      <polygon
        points={`0,${-s} ${s},0 0,${s} ${-s},0`}
        fill="rgba(15,17,23,0.72)"
        stroke="rgba(59,130,246,0.34)"
        strokeWidth="1"
      />
      <polygon
        points={`0,${-s * 0.42} ${s * 0.42},0 0,${s * 0.42} ${-s * 0.42},0`}
        fill="rgba(59,130,246,0.15)"
        stroke="rgba(96,165,250,0.28)"
        strokeWidth="0.75"
      />
      <line x1="-10" y1="0" x2="10" y2="0" stroke="rgba(96,165,250,0.40)" strokeWidth="0.9" />
      <line x1="0" y1="-10" x2="0" y2="10" stroke="rgba(96,165,250,0.40)" strokeWidth="0.9" />
      <text y={s + 14} textAnchor="middle" fontSize="7.5"
        fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
        letterSpacing="0.09em" fill="rgba(148,163,184,0.62)" fontWeight="600">
        Keystone
      </text>
      <text y={s + 23} textAnchor="middle" fontSize="6"
        fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
        letterSpacing="0.07em" fill="rgba(100,116,139,0.52)" fontWeight="500">
        HA Server
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
  const cy = LOC_Y[locIdx];
  const x  = COL.locIn;
  const h  = LOC_HALF_H * 2;  // 72px total height
  const R  = 9;

  const sbc1Y = cy - SBC_OFFSET;
  const sbc2Y = cy + SBC_OFFSET;

  return (
    <g className={locClass}>
      {/* Container background */}
      <rect
        x={x}
        y={cy - LOC_HALF_H}
        width={LOC_W}
        height={h}
        rx={R}
        fill="rgba(15,17,23,0.52)"
        stroke="rgba(59,130,246,0.18)"
        strokeWidth="0.75"
      />
      {/* Top shimmer */}
      <rect
        x={x + 1}
        y={cy - LOC_HALF_H + 1}
        width={LOC_W - 2}
        height={h * 0.22}
        rx={R - 1}
        fill="rgba(96,165,250,0.045)"
      />
      {/* Location name */}
      <text
        x={x + 10}
        y={cy - LOC_HALF_H + 12}
        fontSize="6.5"
        fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
        letterSpacing="0.10em"
        fill="rgba(148,163,184,0.45)"
        fontWeight="700"
      >
        {label}
      </text>

      {/* SBC-1 (upper) */}
      <SbcNode uid={uid} cx={COL.sbc1X} cy={sbc1Y} label="SBC-1" nodeClass={sbc1Class} />

      {/* SBC-2 (lower) — may have its own failure class */}
      <SbcNode
        uid={uid}
        cx={COL.sbc2X}
        cy={sbc2Y}
        label="SBC-2"
        nodeClass={sbc2CentralClass ?? sbc2Class}
      />

      {/* Keystone engine — right side of the container */}
      <KsNode uid={uid} cx={COL.ksX} cy={cy} />
    </g>
  );
}

/* ── Individual SBC node ── */
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
  const W = 46;
  const H = 24;
  const R = 6;

  return (
    <g transform={`translate(${cx}, ${cy})`} className={nodeClass}>
      <circle r="28" fill={`url(#${uid}-ng)`} />
      <rect
        x={-W / 2} y={-H / 2}
        width={W} height={H} rx={R}
        fill="rgba(15,17,23,0.76)"
        stroke="rgba(59,130,246,0.28)"
        strokeWidth="0.8"
      />
      <rect
        x={-W / 2 + 1} y={-H / 2 + 1}
        width={W - 2} height={H * 0.30} rx={R - 1}
        fill="rgba(96,165,250,0.07)"
      />
      {/* Stack lines — visual metaphor for SBC stacking/redundancy */}
      <line x1="-12" y1="-4" x2="12" y2="-4" stroke="rgba(59,130,246,0.30)" strokeWidth="0.65" />
      <line x1="-8"  y1=" 0" x2="8"  y2=" 0" stroke="rgba(59,130,246,0.20)" strokeWidth="0.65" />
      <line x1="-4"  y1=" 4" x2="4"  y2=" 4" stroke="rgba(59,130,246,0.12)" strokeWidth="0.65" />
      {/* Label below */}
      <text y={H / 2 + 9} textAnchor="middle" fontSize="6"
        fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
        letterSpacing="0.07em" fill="rgba(148,163,184,0.52)" fontWeight="600">
        {label}
      </text>
    </g>
  );
}

/* ── Keystone Media Engine — logo image node ── */
function KsNode({ uid, cx, cy }: { uid: string; cx: number; cy: number }) {
  const S = 28;
  return (
    <g transform={`translate(${cx}, ${cy})`}>
      <circle r="28" fill={`url(#${uid}-ng)`} />
      <image
        href="/keystone_logo.png"
        x={-S / 2}
        y={-S / 2}
        width={S}
        height={S}
        filter={`url(#${uid}-imgf)`}
        preserveAspectRatio="xMidYMid meet"
      />
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
  const W  = 60;
  const H  = 34;
  const R  = 8;

  return (
    <g transform={`translate(${cx}, ${cy})`} className={nodeClass}>
      <circle r="42" fill={`url(#${uid}-tg)`} />
      <rect
        x={-W / 2} y={-H / 2}
        width={W} height={H} rx={R}
        fill="rgba(15,17,23,0.72)"
        stroke="rgba(52,211,153,0.28)"
        strokeWidth="0.9"
      />
      <rect
        x={-W / 2 + 1} y={-H / 2 + 1}
        width={W - 2} height={H * 0.28} rx={R - 1}
        fill="rgba(52,211,153,0.06)"
      />
      <circle r="3"   cx="0" cy="0" fill="rgba(52,211,153,0.40)" />
      <circle r="1.5" cx="0" cy="0" fill="rgba(167,243,208,0.92)" />
      <text y={H / 2 + 12} textAnchor="middle" fontSize="7.5"
        fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
        letterSpacing="0.09em" fill="rgba(148,163,184,0.62)" fontWeight="600">
        {label}
      </text>
      <text y={H / 2 + 21} textAnchor="middle" fontSize="6"
        fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
        letterSpacing="0.07em" fill="rgba(100,116,139,0.52)" fontWeight="500">
        {sublabel}
      </text>
    </g>
  );
}

/* ── Status indicator — HTML element rendered above the SVG ── */
function StatusIndicatorHtml({ uid }: { uid: string }) {
  // Shared dot style helper — renders the pulsing halo + solid dot as stacked divs
  const dotStyle = (color: string): CSSProperties => ({
    width: 8,
    height: 8,
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

  const textStyle = (color: string): CSSProperties => ({
    fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace",
    fontSize: '0.60rem',
    fontWeight: 600,
    letterSpacing: '0.08em',
    color,
  });

  const rowStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    height: 18,
    // Stacked absolutely so only the animated-in one is visible
    position: 'absolute',
    inset: 0,
  };

  return (
    <div
      style={{
        position: 'relative',
        height: 18,
        marginBottom: 8,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* Normal — green */}
      <div className={`${uid}-status-normal`} style={rowStyle}>
        <div style={{ position: 'relative', width: 8, height: 8 }}>
          <div style={haloStyle('rgba(34,197,94,0.18)')} />
          <div style={dotStyle('rgba(34,197,94,0.90)')} />
        </div>
        <span style={textStyle('rgba(134,239,172,0.80)')}>All Systems Operational</span>
      </div>

      {/* Failover: SBC-2 Granite Central — amber */}
      <div className={`${uid}-status-sbc2c`} style={{ ...rowStyle, opacity: 0 }}>
        <div style={{ position: 'relative', width: 8, height: 8 }}>
          <div style={haloStyle('rgba(251,191,36,0.20)')} />
          <div style={dotStyle('rgba(251,191,36,0.90)')} />
        </div>
        <span style={textStyle('rgba(251,191,36,0.88)')}>Failover: SBC-2 Granite Central</span>
      </div>

      {/* Failover: Granite West Zone — amber */}
      <div className={`${uid}-status-west`} style={{ ...rowStyle, opacity: 0 }}>
        <div style={{ position: 'relative', width: 8, height: 8 }}>
          <div style={haloStyle('rgba(251,191,36,0.20)')} />
          <div style={dotStyle('rgba(251,191,36,0.90)')} />
        </div>
        <span style={textStyle('rgba(251,191,36,0.88)')}>Failover: Granite West Zone</span>
      </div>

      {/* Failover: Dallas PoP — amber */}
      <div className={`${uid}-status-dallas`} style={{ ...rowStyle, opacity: 0 }}>
        <div style={{ position: 'relative', width: 8, height: 8 }}>
          <div style={haloStyle('rgba(251,191,36,0.20)')} />
          <div style={dotStyle('rgba(251,191,36,0.90)')} />
        </div>
        <span style={textStyle('rgba(251,191,36,0.88)')}>Failover: Dallas PoP</span>
      </div>

      {/* Failover: SBC-1 Granite East — amber */}
      <div className={`${uid}-status-sbc1e`} style={{ ...rowStyle, opacity: 0 }}>
        <div style={{ position: 'relative', width: 8, height: 8 }}>
          <div style={haloStyle('rgba(251,191,36,0.20)')} />
          <div style={dotStyle('rgba(251,191,36,0.90)')} />
        </div>
        <span style={textStyle('rgba(251,191,36,0.88)')}>Failover: SBC-1 Granite East</span>
      </div>
    </div>
  );
}

export default HaArchitectureViz;
