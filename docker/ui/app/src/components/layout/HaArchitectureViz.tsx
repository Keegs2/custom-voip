import { type CSSProperties, useId, useMemo } from 'react';

/**
 * HaArchitectureViz
 *
 * SVG-based animated diagram of the Granite CRAG **SIP Trunking inbound**
 * architecture: many customer trunks, ONE hostname, health-checked DNS
 * steering across three self-contained zones.
 *
 *  [Customer   ]                        ┌ Granite East:   [SK-1][SK-2] → [CRAG] ┐
 *  [Customer   ]                        │                                       │
 *  [Customer   ] → crag.granitevoip.com ┼ Granite Central:[SK-1][SK-2] → [CRAG] ┼→ Dallas / LA / Backup
 *  [Customer   ]   (Infoblox DTC —      │                                       │
 *  [Customer   ]    health-checked DNS) └ Granite West:   [SK-1][SK-2] → [CRAG] ┘
 *
 * Every customer targets the same hostname. The DNS layer resolves each
 * call to a healthy zone VIP (round-robin) and continuously health-checks
 * each zone with SIP OPTIONS on :5060 — a zone answers 200 while its media
 * core is up, 503 when it is down, and a failing zone is pulled from the
 * pool (TTL 30s). Inside a zone, an NLB spreads calls across the Signal
 * Key (SBC) pair, so a single-SBC failure never surfaces to DNS.
 *
 * Failover simulation — a 50-second CSS keyframe cycle, four scenarios:
 *   0–6s    (0–12%)   Normal — round-robin across all three zones
 *   6–12s   (12–24%)  Signal Key 2 Central fails → zone NLB shifts to
 *                     Signal Key 1 (zone STAYS in the DNS pool)
 *   12–18s  (24–36%)  Normal
 *   18–27s  (36–54%)  Granite West media core fails → its SBCs answer
 *                     OPTIONS 503 → DNS pulls West from rotation and the
 *                     customer streams redistribute to East + Central
 *   27–33s  (54–66%)  Normal (West restored, back in rotation)
 *   33–39s  (66–78%)  Dallas PoP fails → egress reroutes to LA + Backup
 *   39–44s  (78–88%)  Normal
 *   44–49s  (88–98%)  Signal Key 1 East fails → zone NLB shifts to SK-2
 *   49–50s  (98–100%) Normal
 *
 * Status chip at top-right narrates each state. All timing windows are
 * declared once (W_* constants) and every keyframe block is generated
 * from them. Pure SVG + CSS animations — no JS timers, no rAF.
 * Reduced-motion: packets/probes hidden, static diagram remains.
 */

/* ─── Geometry constants ─────────────────────────────────────────────── */

const VB_W = 1280;
const VB_H = 560;

// Column x-positions
const COL = {
  cust:  84,    // Stage 1: customer trunk nodes (five, stacked)
  dns:   320,   // Stage 2: DNS steering node (crag.granitevoip.com)
  locIn: 500,   // left edge of zone containers
  locOut: 876,  // right edge of zone containers
  sbcX:  590,   // Signal Key node centre (both SBCs stacked at same X)
  ksX:   800,   // CRAG engine node centre
  termX: 1190,  // Stage 4: termination PoP nodes
} as const;

// Zone rows
const LOC_Y = [134, 298, 462] as const;   // Granite East, Central, West
const LOC_HALF_H = 76;                     // half-height of each zone container
const LOC_W = COL.locOut - COL.locIn;      // 376px
const LOC_TITLE_H = 26;                    // zone title-bar height
const SBC_OFFSET = 30;                     // SK-1 at cy-30, SK-2 at cy+30

// Termination PoP y-positions
const TERM_Y = [150, 298, 446] as const;   // Dallas, LA, Backup

// Customer trunk y-centres — five, spanning the full zone column height.
const CUST_Y = [110, 204, 298, 392, 486] as const;

// DNS steering node — one rect centred on the middle zone row.
const DNS_W = 172;
const DNS_H = 64;
// Where the five customer streams land on the DNS node's left edge:
const DNS_IN_Y = [270, 284, 298, 312, 326] as const;
// Where the three zone fans leave the DNS node's right edge (E/C/W):
const DNS_OUT_Y = [282, 298, 314] as const;
// Where the three health-check probes leave the DNS node (E/C/W):
const PROBE_OUT_Y = [278, 298, 318] as const;
// Probe targets: the vertical centre of each zone's title bar.
const ZONE_TITLE_CY = [71, 235, 399] as const;

/* ─── Failover timing windows (percent of the 50s master cycle) ──────── */
/* 1s = 2%. Declared once; every keyframe below is generated from these. */

type Win = readonly [number, number];

const W_SBC2C: Win  = [12, 24];  //  6–12s  Signal Key 2 Central fails
const W_WEST: Win   = [36, 54];  // 18–27s  Granite West pulled from DNS
const W_DALLAS: Win = [66, 78];  // 33–39s  Dallas PoP fails
const W_SBC1E: Win  = [88, 98];  // 44–49s  Signal Key 1 East fails

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

/** Rectangle with only the top two corners rounded — zone title bars. */
function topRoundedRect(
  x: number, y: number,
  w: number, h: number,
  r: number,
): string {
  return `M ${x} ${y + h} V ${y + r} Q ${x} ${y} ${x + r} ${y} H ${x + w - r} Q ${x + w} ${y} ${x + w} ${y + r} V ${y + h} Z`;
}

/* ─── Failover group taxonomy ────────────────────────────────────────── */
/**
 * Each path/packet belongs to one failover group. During a failure window
 * the group's packets hide (opacity 0) via generated keyframes; the paired
 * reroute group's extra packets appear only inside that window.
 *
 *   'normal'          — always flowing (customer streams NEVER stop)
 *   'sbc2-central'    — via Signal Key 2 Central (hides during W_SBC2C)
 *   'west-zone'       — via Granite West         (hides during W_WEST)
 *   'term-dallas'     — via Dallas PoP           (hides during W_DALLAS)
 *   'west-or-dallas'  — West→Dallas leg          (hides during BOTH)
 *   'sbc1-east'       — via Signal Key 1 East    (hides during W_SBC1E)
 */
type FailoverGroup =
  | 'normal'
  | 'sbc2-central'
  | 'west-zone'
  | 'term-dallas'
  | 'west-or-dallas'
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

// Stage 1→2: five customer trunks converge on the DNS steering node.
// These streams never stop — failures re-aim them downstream of DNS.
const PATHS_CUST_DNS: PathDef[] = CUST_Y.map((y, i) => ({
  id: `cu${i}`,
  group: 'normal' as FailoverGroup,
  d: cubicPath(
    COL.cust + 36, y,
    COL.cust + 86, y,
    184, DNS_IN_Y[i],
    COL.dns - DNS_W / 2 - 4, DNS_IN_Y[i],
  ),
}));

// Stage 2→3: DNS resolves to a zone VIP; the zone NLB spreads across the
// Signal Key pair — drawn as DNS → each SK directly.
function makeDnsToSbc(
  locIdx: number,
  sbcNum: 1 | 2,
  group: FailoverGroup,
  id: string,
): PathDef {
  const y1 = DNS_OUT_Y[locIdx];
  const y2 = LOC_Y[locIdx] + (sbcNum === 1 ? -SBC_OFFSET : SBC_OFFSET);
  const x1 = COL.dns + DNS_W / 2 + 4;
  const x2 = COL.sbcX - 26;
  return { id, group, d: quadPath(x1, y1, (x1 + x2) / 2, y2, x2, y2) };
}

const PATH_DNS_E1 = makeDnsToSbc(0, 1, 'sbc1-east',    'dns-e1');
const PATH_DNS_E2 = makeDnsToSbc(0, 2, 'normal',       'dns-e2');
const PATH_DNS_C1 = makeDnsToSbc(1, 1, 'normal',       'dns-c1');
const PATH_DNS_C2 = makeDnsToSbc(1, 2, 'sbc2-central', 'dns-c2');
const PATH_DNS_W1 = makeDnsToSbc(2, 1, 'west-zone',    'dns-w1');
const PATH_DNS_W2 = makeDnsToSbc(2, 2, 'west-zone',    'dns-w2');

// Stage 3 internal: Signal Key → CRAG engine (within each zone)
function makeSbcToKs(
  locIdx: number,
  sbcNum: 1 | 2,
  group: FailoverGroup,
  id: string,
): PathDef {
  const y1 = LOC_Y[locIdx] + (sbcNum === 1 ? -SBC_OFFSET : SBC_OFFSET);
  const y2 = LOC_Y[locIdx];
  const x1 = COL.sbcX + 24;
  const x2 = COL.ksX - 30;
  const cp1X = x1 + (x2 - x1) * 0.35;
  const cp2X = x1 + (x2 - x1) * 0.65;
  return { id, group, d: cubicPath(x1, y1, cp1X, y1, cp2X, y2, x2, y2) };
}

const PATH_S1KS_E = makeSbcToKs(0, 1, 'sbc1-east',    's1ks-e');
const PATH_S2KS_E = makeSbcToKs(0, 2, 'normal',       's2ks-e');
const PATH_S1KS_C = makeSbcToKs(1, 1, 'normal',       's1ks-c');
const PATH_S2KS_C = makeSbcToKs(1, 2, 'sbc2-central', 's2ks-c');
const PATH_S1KS_W = makeSbcToKs(2, 1, 'west-zone',    's1ks-w');
const PATH_S2KS_W = makeSbcToKs(2, 2, 'west-zone',    's2ks-w');

// Stage 3→4: each zone's CRAG engine → each termination PoP (9 paths)
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
  return { id, group, d: cubicPath(x1, y1, cp1X, y1, cp2X, y2, x2, y2) };
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
  makeTermPath(2, 0, 'west-or-dallas', 'w-t0'),
  makeTermPath(2, 1, 'west-zone',      'w-t1'),
  makeTermPath(2, 2, 'west-zone',      'w-t2'),
];

const PATHS: PathDef[] = [
  ...PATHS_CUST_DNS,
  PATH_DNS_E1, PATH_DNS_E2,
  PATH_DNS_C1, PATH_DNS_C2,
  PATH_DNS_W1, PATH_DNS_W2,
  PATH_S1KS_E, PATH_S2KS_E,
  PATH_S1KS_C, PATH_S2KS_C,
  PATH_S1KS_W, PATH_S2KS_W,
  ...PATHS_EAST_TERM,
  ...PATHS_CENTRAL_TERM,
  ...PATHS_WEST_TERM,
];

// SIP OPTIONS health-check probes: DNS → each zone's title bar and back.
// One tiny round-trip pulse per zone (staggered) — the authentic DTC
// monitor mechanism, kept deliberately quiet next to the call streams.
const PROBE_PATHS = [
  { id: 'pr-e', d: quadPath(COL.dns + DNS_W / 2 + 2, PROBE_OUT_Y[0], 452, ZONE_TITLE_CY[0], COL.locIn - 6, ZONE_TITLE_CY[0]) },
  { id: 'pr-c', d: quadPath(COL.dns + DNS_W / 2 + 2, PROBE_OUT_Y[1], 452, ZONE_TITLE_CY[1], COL.locIn - 6, ZONE_TITLE_CY[1]) },
  { id: 'pr-w', d: quadPath(COL.dns + DNS_W / 2 + 2, PROBE_OUT_Y[2], 452, ZONE_TITLE_CY[2], COL.locIn - 6, ZONE_TITLE_CY[2]) },
] as const;

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
  // ── Stage 1: customer trunks → DNS — five always-on streams ──────────
  ...makePackets('cu0', 3, 0.75, 'normal', false, 0.00, 11),
  ...makePackets('cu1', 3, 0.75, 'normal', false, 0.28, 11),
  ...makePackets('cu2', 3, 0.75, 'normal', false, 0.12, 11),
  ...makePackets('cu3', 3, 0.75, 'normal', false, 0.40, 11),
  ...makePackets('cu4', 3, 0.75, 'normal', false, 0.19, 11),

  // ── Stage 2: DNS → Signal Keys (round-robin fan) ─────────────────────
  ...makePackets('dns-e1', 3, 0.5, 'sbc1-east',    false, 0.00, 13),
  ...makePackets('dns-e2', 2, 0.5, 'normal',       false, 0.20, 13),
  ...makePackets('dns-c1', 2, 0.5, 'normal',       false, 0.10, 13),
  ...makePackets('dns-c2', 3, 0.5, 'sbc2-central', false, 0.30, 13),
  ...makePackets('dns-w1', 3, 0.5, 'west-zone',    false, 0.15, 13),
  ...makePackets('dns-w2', 2, 0.5, 'west-zone',    false, 0.35, 13),

  // ── Stage 3: Signal Key → CRAG engine ────────────────────────────────
  ...makePackets('s1ks-e', 3, 0.35, 'sbc1-east',    false, 0.05, 14, true),
  ...makePackets('s2ks-e', 2, 0.35, 'normal',       false, 0.10, 14, true),
  ...makePackets('s1ks-c', 2, 0.35, 'normal',       false, 0.08, 14, true),
  ...makePackets('s2ks-c', 3, 0.35, 'sbc2-central', false, 0.18, 14, true),
  ...makePackets('s1ks-w', 3, 0.35, 'west-zone',    false, 0.03, 14, true),
  ...makePackets('s2ks-w', 2, 0.35, 'west-zone',    false, 0.13, 14, true),

  // ── Stage 4: CRAG engine → termination PoPs ──────────────────────────
  ...makePackets('e-t0', 2, 0.5, 'term-dallas', true, 0.00, 14, true),
  ...makePackets('e-t1', 2, 0.5, 'normal',      true, 0.08, 14, true),
  ...makePackets('e-t2', 2, 0.5, 'normal',      true, 0.20, 14, true),
  ...makePackets('c-t0', 2, 0.5, 'term-dallas', true, 0.10, 14, true),
  ...makePackets('c-t1', 2, 0.5, 'normal',      true, 0.05, 14, true),
  ...makePackets('c-t2', 2, 0.5, 'normal',      true, 0.15, 14, true),
  ...makePackets('w-t0', 2, 0.5, 'west-or-dallas', true, 0.05, 14, true),
  ...makePackets('w-t1', 2, 0.5, 'west-zone',      true, 0.15, 14, true),
  ...makePackets('w-t2', 2, 0.5, 'west-zone',      true, 0.25, 14, true),

  // ── Reroute packets — appear only inside their failure window ────────

  // Signal Key 2 Central fails → zone NLB shifts everything to SK-1
  ...makePackets('dns-c1', 3, 0.5,  'reroute-sbc2central', false, 0.30, 13),
  ...makePackets('s1ks-c', 3, 0.35, 'reroute-sbc2central', false, 0.10, 14, true),

  // Granite West pulled from DNS → East + Central absorb the streams
  ...makePackets('dns-e1', 2, 0.5,  'reroute-west', false, 0.10, 13),
  ...makePackets('dns-e2', 2, 0.5,  'reroute-west', false, 0.35, 13),
  ...makePackets('dns-c1', 2, 0.5,  'reroute-west', false, 0.22, 13),
  ...makePackets('dns-c2', 2, 0.5,  'reroute-west', false, 0.45, 13),
  ...makePackets('s1ks-e', 2, 0.35, 'reroute-west', false, 0.15, 14, true),
  ...makePackets('s2ks-e', 2, 0.35, 'reroute-west', false, 0.28, 14, true),
  ...makePackets('s1ks-c', 2, 0.35, 'reroute-west', false, 0.08, 14, true),
  ...makePackets('s2ks-c', 2, 0.35, 'reroute-west', false, 0.22, 14, true),
  ...makePackets('e-t1',   2, 0.5,  'reroute-west', true,  0.10, 14, true),
  ...makePackets('c-t1',   2, 0.5,  'reroute-west', true,  0.30, 14, true),

  // Dallas PoP fails → all zones' egress reroutes to LA + Backup
  ...makePackets('e-t1', 2, 0.5, 'reroute-dallas', true, 0.05, 14, true),
  ...makePackets('e-t2', 2, 0.5, 'reroute-dallas', true, 0.20, 14, true),
  ...makePackets('c-t1', 2, 0.5, 'reroute-dallas', true, 0.10, 14, true),
  ...makePackets('c-t2', 2, 0.5, 'reroute-dallas', true, 0.25, 14, true),
  ...makePackets('w-t1', 2, 0.5, 'reroute-dallas', true, 0.15, 14, true),
  ...makePackets('w-t2', 2, 0.5, 'reroute-dallas', true, 0.30, 14, true),

  // Signal Key 1 East fails → zone NLB shifts everything to SK-2
  ...makePackets('dns-e2', 3, 0.5,  'reroute-sbc1east', false, 0.30, 13),
  ...makePackets('s2ks-e', 3, 0.35, 'reroute-sbc1east', false, 0.10, 14, true),
];

/* ─── Generated keyframe helpers ─────────────────────────────────────── */

/** Visible everywhere EXCEPT inside the given windows. */
function kfHide(name: string, wins: readonly Win[]): string {
  const segs = wins
    .map(([a, b]) =>
      `  ${a - 0.1}% { opacity: 1; }\n  ${a}% { opacity: 0; }\n  ${b - 0.1}% { opacity: 0; }\n  ${b}% { opacity: 1; }`)
    .join('\n');
  return `@keyframes ${name} {\n  0% { opacity: 1; }\n${segs}\n  100% { opacity: 1; }\n}`;
}

/** Visible ONLY inside the given window. */
function kfShow(name: string, [a, b]: Win): string {
  return `@keyframes ${name} {
  0%, ${a - 0.1}% { opacity: 0; }
  ${a}% { opacity: 1; }
  ${b - 0.1}% { opacity: 1; }
  ${b}%, 100% { opacity: 0; }
}`;
}

// Red failure glow — clean drop-shadows only, no hue distortion.
const F_DIM  = 'drop-shadow(0 0 6px rgba(220,38,38,0.35)) drop-shadow(0 0 18px rgba(220,38,38,0.15))';
const F_PEAK = 'drop-shadow(0 0 10px rgba(220,38,38,0.55)) drop-shadow(0 0 28px rgba(220,38,38,0.25))';

/** Three smooth red pulses across a failure window. */
function kfFailPulse(name: string, [a, b]: Win, dimOp = 0.5, peakOp = 0.62): string {
  const at = (f: number) => +(a + (b - a) * f).toFixed(2);
  return `@keyframes ${name} {
  0%, ${a - 0.1}% { opacity: 1; filter: none; }
  ${at(0.05)}% { opacity: ${dimOp};  filter: ${F_DIM};  }
  ${at(0.22)}% { opacity: ${peakOp}; filter: ${F_PEAK}; }
  ${at(0.40)}% { opacity: ${dimOp};  filter: ${F_DIM};  }
  ${at(0.58)}% { opacity: ${peakOp}; filter: ${F_PEAK}; }
  ${at(0.78)}% { opacity: ${dimOp};  filter: ${F_DIM};  }
  ${at(0.94)}% { opacity: ${peakOp}; filter: ${F_PEAK}; }
  ${Math.min(b + 0.4, 99.9)}% { opacity: 1; filter: none; }
  100% { opacity: 1; filter: none; }
}`;
}

const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';

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

    // 2. Window visibility keyframes — all generated from W_* constants.
    const groupKf = [
      kfHide(`${uid}-hide-sbc2c`,      [W_SBC2C]),
      kfHide(`${uid}-hide-west`,       [W_WEST]),
      kfHide(`${uid}-hide-dallas`,     [W_DALLAS]),
      kfHide(`${uid}-hide-westdallas`, [W_WEST, W_DALLAS]),
      kfHide(`${uid}-hide-sbc1e`,      [W_SBC1E]),
      kfHide(`${uid}-hide-all`,        [W_SBC2C, W_WEST, W_DALLAS, W_SBC1E]),
      kfShow(`${uid}-show-sbc2c`,  W_SBC2C),
      kfShow(`${uid}-show-west`,   W_WEST),
      kfShow(`${uid}-show-dallas`, W_DALLAS),
      kfShow(`${uid}-show-sbc1e`,  W_SBC1E),
    ].join('\n');

    // Map group → window visibility animation name
    function pktVisAnim(group: FailoverGroup): string | null {
      switch (group) {
        case 'normal':              return null;
        case 'sbc2-central':        return `${uid}-hide-sbc2c`;
        case 'west-zone':           return `${uid}-hide-west`;
        case 'term-dallas':         return `${uid}-hide-dallas`;
        case 'west-or-dallas':      return `${uid}-hide-westdallas`;
        case 'sbc1-east':           return `${uid}-hide-sbc1e`;
        case 'reroute-sbc2central': return `${uid}-show-sbc2c`;
        case 'reroute-west':        return `${uid}-show-west`;
        case 'reroute-dallas':      return `${uid}-show-dallas`;
        case 'reroute-sbc1east':    return `${uid}-show-sbc1e`;
      }
    }

    const packetRules = ALL_PACKETS.map((pkt, i) => {
      const path = PATHS.find((p) => p.id === pkt.pathId);
      if (!path) return '';

      const visAnim = pktVisAnim(pkt.group);

      const animNames = visAnim
        ? `${uid}-pkt-${path.id}, ${visAnim}`
        : `${uid}-pkt-${path.id}`;
      const animDurs  = visAnim ? `${pkt.duration}s, 50s` : `${pkt.duration}s`;
      const animDels  = visAnim ? `${pkt.delay}s, 0s`     : `${pkt.delay}s`;
      const animIters = visAnim ? 'infinite, infinite'    : 'infinite';
      const animFills = visAnim ? 'both, both'            : 'both';
      const animTfs   = visAnim
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

    // 3. Node failure animations — red pulses generated per window.
    const nodeKf = [
      kfFailPulse(`${uid}-nkf-sbc2c`,    W_SBC2C),
      kfFailPulse(`${uid}-nkf-dallas`,   W_DALLAS),
      kfFailPulse(`${uid}-nkf-sbc1e`,    W_SBC1E),
      // West CRAG engine sits inside the dimmed zone group — pulse it
      // brighter so the failure source stays legible through the dim.
      kfFailPulse(`${uid}-nkf-westcrag`, W_WEST, 0.74, 0.95),
      // Whole West zone dims (its SBCs are up and answering 503 — they do
      // NOT go red; only the media core and the container state change).
      `@keyframes ${uid}-zone-west-dim {
  0%, ${W_WEST[0] - 0.1}% { opacity: 1; }
  ${W_WEST[0] + 0.8}% { opacity: 0.52; }
  ${W_WEST[1] - 0.8}% { opacity: 0.52; }
  ${W_WEST[1]}% { opacity: 1; }
  100% { opacity: 1; }
}`,
    ].join('\n');

    const nodeRules = `
.${uid}-node-sbc2central { animation: ${uid}-nkf-sbc2c    50s linear infinite; }
.${uid}-node-termdallas  { animation: ${uid}-nkf-dallas   50s linear infinite; }
.${uid}-node-sbc1east    { animation: ${uid}-nkf-sbc1e    50s linear infinite; }
.${uid}-node-westcrag    { animation: ${uid}-nkf-westcrag 50s linear infinite; }
.${uid}-zone-west        { animation: ${uid}-zone-west-dim 50s linear infinite; }
.${uid}-line-westfan     { animation: ${uid}-hide-west     50s step-start infinite; }`;

    // 4. DNS pool chips + "OPTIONS → 503" callout (West window only)
    const dnsRules = `
.${uid}-chip-ok-w  { animation: ${uid}-hide-west 50s step-start infinite; }
.${uid}-chip-bad-w { animation: ${uid}-show-west 50s step-start infinite; opacity: 0; }
.${uid}-fail-503   { animation: ${uid}-show-west 50s step-start infinite; opacity: 0; }`;

    // Round-robin sweep on the pool chip dots — one soft highlight
    // rotating E → C → W, narrating "next resolution goes here".
    const rrKf = `
@keyframes ${uid}-rr {
  0%        { opacity: 0.35; }
  12%       { opacity: 1; }
  33%       { opacity: 1; }
  45%, 100% { opacity: 0.35; }
}`;
    const rrRules = `
.${uid}-rr0 { animation: ${uid}-rr 4.5s ease-in-out infinite;      animation-fill-mode: both; }
.${uid}-rr1 { animation: ${uid}-rr 4.5s ease-in-out infinite 1.5s; animation-fill-mode: both; }
.${uid}-rr2 { animation: ${uid}-rr 4.5s ease-in-out infinite 3s;   animation-fill-mode: both; }`;

    // 5. SIP OPTIONS probe pulses — round trip DNS → zone → DNS on a 6s
    //    cycle, staggered per zone. The West probe swaps to a red pulse
    //    during the zone-failure window (503 coming back instead of 200).
    const probeKf = `
@keyframes ${uid}-probe {
  0%   { offset-distance: 0%;   opacity: 0; }
  3%   { offset-distance: 6%;   opacity: 0.9; }
  20%  { offset-distance: 100%; opacity: 0.9; }
  24%  { offset-distance: 100%; opacity: 0.9; }
  41%  { offset-distance: 6%;   opacity: 0.9; }
  44%  { offset-distance: 0%;   opacity: 0; }
  100% { offset-distance: 0%;   opacity: 0; }
}`;
    const probeRules = `
.${uid}-probe-e {
  offset-path: path('${PROBE_PATHS[0].d}');
  animation: ${uid}-probe 6s linear infinite;
  animation-fill-mode: both;
  opacity: 0;
}
.${uid}-probe-c {
  offset-path: path('${PROBE_PATHS[1].d}');
  animation: ${uid}-probe 6s linear infinite 2s;
  animation-fill-mode: both;
  opacity: 0;
}
.${uid}-probe-w {
  offset-path: path('${PROBE_PATHS[2].d}');
  animation: ${uid}-probe 6s linear infinite 4s;
  animation-fill-mode: both;
  opacity: 0;
}
.${uid}-probevis-w-ok  { animation: ${uid}-hide-west 50s step-start infinite; }
.${uid}-probevis-w-bad { animation: ${uid}-show-west 50s step-start infinite; opacity: 0; }`;

    // 6. Status chip rows — one green steady-state row + four alert rows.
    const statusRules = `
.${uid}-status-normal { animation: ${uid}-hide-all   50s step-start infinite; }
.${uid}-status-sbc2c  { animation: ${uid}-show-sbc2c 50s step-start infinite; opacity: 0; }
.${uid}-status-west   { animation: ${uid}-show-west  50s step-start infinite; opacity: 0; }
.${uid}-status-dallas { animation: ${uid}-show-dallas 50s step-start infinite; opacity: 0; }
.${uid}-status-sbc1e  { animation: ${uid}-show-sbc1e 50s step-start infinite; opacity: 0; }
.${uid}-alert-halo    { animation: ${uid}-alert-halo-pulse 0.75s ease-out infinite; }`;

    const alertHaloKf = `
@keyframes ${uid}-alert-halo-pulse {
  0%   { transform: scale(1);   opacity: 0.70; }
  60%  { transform: scale(2.4); opacity: 0;    }
  100% { transform: scale(2.4); opacity: 0;    }
}`;

    // 7. Reduced motion — freeze the story to its steady-state frame:
    //    no animations, no packets/probes; the static architecture stays.
    const reducedMotion = `
@media (prefers-reduced-motion: reduce) {
  [class*="${uid}"] { animation: none !important; }
  .${uid}-packets { display: none !important; }
}`;

    return [
      pathKf, groupKf, packetRules,
      nodeKf, nodeRules,
      dnsRules, rrKf, rrRules,
      probeKf, probeRules,
      alertHaloKf, statusRules,
      reducedMotion,
    ].join('\n');
  }, [uid]);

  return (
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
            How SIP Trunking inbound rides three zones behind one
            health-checked hostname — the same reroutes the live network runs.
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
        aria-label="SIP Trunking inbound architecture: five customer trunks all send calls to one hostname, crag.granitevoip.com, where health-checked DNS (Infoblox DTC) steers each call round-robin to a healthy Granite zone — East, Central, or West — each an independent zone with a redundant Signal Key pair and a CRAG engine, terminating via Dallas, LA, and Backup PoPs. A 50-second animation cycles through failure scenarios: a Signal Key failure absorbed inside its zone, a whole zone answering SIP OPTIONS with 503 and being pulled from DNS rotation while its streams redistribute, and a termination PoP reroute."
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

          {/* Fiber-optic beam gradients — blue processing, green termination */}
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

          {/* Logo glow — blue halo for image nodes */}
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

        {/* ── Static connection lines ─────────────────────────────── */}
        <g fill="none" clipPath={`url(#${uid}-clip)`}>
          {/* Stage 1→2: customer trunks → DNS (always on) */}
          {PATHS_CUST_DNS.map((p) => (
            <path key={p.id} d={p.d} stroke="rgba(59,130,246,0.30)" strokeWidth="1.2" />
          ))}

          {/* Stage 2→3 fan — DNS → Signal Keys. The West pair's rails
              vanish while West is out of DNS rotation. */}
          <path d={PATH_DNS_E1.d} stroke="rgba(59,130,246,0.24)" strokeWidth="1.1" />
          <path d={PATH_DNS_E2.d} stroke="rgba(59,130,246,0.24)" strokeWidth="1.1" />
          <path d={PATH_DNS_C1.d} stroke="rgba(59,130,246,0.24)" strokeWidth="1.1" />
          <path d={PATH_DNS_C2.d} stroke="rgba(59,130,246,0.24)" strokeWidth="1.1" />
          <g className={`${uid}-line-westfan`}>
            <path d={PATH_DNS_W1.d} stroke="rgba(59,130,246,0.24)" strokeWidth="1.1" />
            <path d={PATH_DNS_W2.d} stroke="rgba(59,130,246,0.24)" strokeWidth="1.1" />
          </g>

          {/* Health-check probe rails — dotted, always present (DNS keeps
              probing a pulled zone to detect recovery) */}
          {PROBE_PATHS.map((p) => (
            <path
              key={p.id}
              d={p.d}
              stroke="rgba(103,232,249,0.22)"
              strokeWidth="1"
              strokeDasharray="1.5 4"
            />
          ))}

          {/* Stage 3 internal — Signal Key → CRAG (dashed) */}
          {[PATH_S1KS_E, PATH_S2KS_E, PATH_S1KS_C, PATH_S2KS_C, PATH_S1KS_W, PATH_S2KS_W].map((p) => (
            <path key={p.id} d={p.d} stroke="rgba(59,130,246,0.20)" strokeWidth="0.9" strokeDasharray="4 3" />
          ))}

          {/* Stage 3→4 convergence fan — green-tinted */}
          {[...PATHS_EAST_TERM, ...PATHS_CENTRAL_TERM, ...PATHS_WEST_TERM].map((p) => (
            <path key={p.id} d={p.d} stroke="rgba(52,211,153,0.18)" strokeWidth="1.0" />
          ))}
        </g>

        {/* ── Animated fiber-optic light beams ─────────────────────── */}
        <g clipPath={`url(#${uid}-clip)`} className={`${uid}-packets`}>
          {ALL_PACKETS.map((pkt, i) => {
            const halfLen = pkt.beamLen;
            const gradId = pkt.isTerm
              ? (pkt.bright ? `${uid}-beam-green-bright` : `${uid}-beam-green`)
              : (pkt.bright ? `${uid}-beam-blue-bright`  : `${uid}-beam-blue`);
            return (
              <rect
                key={i}
                x={-halfLen}
                y="-1.5"
                width={halfLen * 2}
                height="3"
                rx="1.5"
                fill={`url(#${gradId})`}
                filter={`url(#${uid}-pf)`}
                className={`${uid}-p${i}`}
              />
            );
          })}
        </g>

        {/* ── SIP OPTIONS probe pulses (round trip DNS ↔ zone) ─────── */}
        <g className={`${uid}-packets`}>
          <circle r="2.8" fill="#a5f3fc" filter={`url(#${uid}-pf)`} className={`${uid}-probe-e`} />
          <circle r="2.8" fill="#a5f3fc" filter={`url(#${uid}-pf)`} className={`${uid}-probe-c`} />
          {/* West probe: cyan 200 OK pulse normally, red 503 pulse while
              the zone's media core is down. Visibility lives on wrapper
              groups so it cannot fight the motion keyframes' opacity. */}
          <g className={`${uid}-probevis-w-ok`}>
            <circle r="2.8" fill="#a5f3fc" filter={`url(#${uid}-pf)`} className={`${uid}-probe-w`} />
          </g>
          <g className={`${uid}-probevis-w-bad`}>
            <circle r="3.1" fill="#fca5a5" filter={`url(#${uid}-pf)`} className={`${uid}-probe-w`} />
          </g>
        </g>

        {/* ── Stage nodes ──────────────────────────────────────────── */}
        {/* Five customer trunks — all pointed at the same hostname */}
        <CustomerNode uid={uid} cy={CUST_Y[0]} label="PBX — Boston" />
        <CustomerNode uid={uid} cy={CUST_Y[1]} label="Contact Center — NYC" />
        <CustomerNode uid={uid} cy={CUST_Y[2]} label="SBC — Dallas" />
        <CustomerNode uid={uid} cy={CUST_Y[3]} label="PBX — Chicago" />
        <CustomerNode uid={uid} cy={CUST_Y[4]} label="IP-PBX — Seattle" />

        {/* DNS steering layer — one hostname, health-checked pool */}
        <DnsNode uid={uid} />

        {/* Three independent zones */}
        <LocationGroup uid={uid} locIdx={0} label="Granite East"    sbc1Class={`${uid}-node-sbc1east`} />
        <LocationGroup uid={uid} locIdx={1} label="Granite Central" sbc2Class={`${uid}-node-sbc2central`} />
        <LocationGroup uid={uid} locIdx={2} label="Granite West"    locClass={`${uid}-zone-west`} ksClass={`${uid}-node-westcrag`} />

        {/* Termination PoPs */}
        <TermNode uid={uid} termIdx={0} label="Dallas" sublabel="PoP"   nodeClass={`${uid}-node-termdallas`} />
        <TermNode uid={uid} termIdx={1} label="LA"     sublabel="PoP"   nodeClass={undefined} />
        <TermNode uid={uid} termIdx={2} label="Backup" sublabel="Trunk" nodeClass={undefined} />

        {/* Failed-health-check callout — sits in the corridor the West
            streams vacate while the zone is out of rotation */}
        <g className={`${uid}-fail-503`}>
          <text
            x={452} y={427}
            textAnchor="middle"
            fontSize="12"
            fontFamily={MONO}
            fontWeight="700"
            letterSpacing="0.06em"
            fill="#fca5a5"
            stroke="rgba(8,14,26,0.9)"
            strokeWidth="3.5"
            paintOrder="stroke"
          >
            SIP OPTIONS → 503
          </text>
          <text
            x={452} y={443}
            textAnchor="middle"
            fontSize="8"
            fontFamily={MONO}
            fontWeight="600"
            letterSpacing="0.10em"
            fill="rgba(252,165,165,0.75)"
            stroke="rgba(8,14,26,0.9)"
            strokeWidth="3"
            paintOrder="stroke"
          >
            REMOVED FROM ROTATION
          </text>
        </g>

        {/* ── Column header labels ─────────────────────────────────── */}
        <ColumnLabel text="CUSTOMER TRUNKS" x={COL.cust + 12}                y={24} />
        <ColumnLabel text="DNS STEERING"    x={COL.dns}                      y={24} />
        <ColumnLabel text="PROCESSING"      x={(COL.locIn + COL.locOut) / 2} y={24} />
        <ColumnLabel text="TERMINATION"     x={COL.termX}                    y={24} />
      </svg>
      </div>
    </div>
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
 * CustomerNode — one of five customer trunks, each targeting the same
 * hostname. Deliberately generic gear: PBXs, SBCs, contact centers.
 */
function CustomerNode({
  uid,
  cy,
  label,
}: {
  uid: string;
  cy: number;
  label: string;
}) {
  const cx = COL.cust;
  const W  = 68;
  const H  = 34;
  const R  = 8;

  return (
    <g transform={`translate(${cx}, ${cy})`}>
      <circle r="42" fill={`url(#${uid}-ng)`} />
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
      {/* Signal bars */}
      <g transform="translate(-8, -8)" opacity="0.62">
        <rect x="0"    y="8.5" width="3.8" height="5.5"  rx="1" fill="rgba(96,165,250,0.70)" />
        <rect x="5.6"  y="6"   width="3.8" height="8"    rx="1" fill="rgba(96,165,250,0.70)" />
        <rect x="11.2" y="2.5" width="3.8" height="11.5" rx="1" fill="rgba(96,165,250,0.70)" />
      </g>
      <text y={H / 2 + 14} textAnchor="middle" fontSize="9" stroke="rgba(8,14,26,0.85)" strokeWidth="3" paintOrder="stroke"
        fontFamily={MONO}
        letterSpacing="0.06em" fill="rgba(196,212,236,0.85)" fontWeight="600">
        {label}
      </text>
    </g>
  );
}

/** One health-checked pool chip inside the DNS node (E / C / W). */
function PoolChip({
  uid,
  x,
  letter,
  rrIdx,
  okClass,
  badClass,
}: {
  uid: string;
  x: number;
  letter: string;
  rrIdx: 0 | 1 | 2;
  okClass?: string;
  badClass?: string;
}) {
  return (
    <g transform={`translate(${x}, 17)`}>
      <g className={okClass}>
        <rect
          x={-17} y={-8} width={34} height={16} rx={4}
          fill="rgba(52,211,153,0.07)"
          stroke="rgba(52,211,153,0.35)"
          strokeWidth="0.9"
        />
        <circle cx={-8} cy={0} r={2.3} fill="#34d399" className={`${uid}-rr${rrIdx}`} />
        <text x={5} y={3.2} textAnchor="middle" fontSize="8.5" fontFamily={MONO}
          fontWeight="700" letterSpacing="0.08em" fill="rgba(196,222,210,0.92)">
          {letter}
        </text>
      </g>
      {badClass ? (
        <g className={badClass}>
          <rect
            x={-17} y={-8} width={34} height={16} rx={4}
            fill="rgba(11,13,19,0.92)"
            stroke="rgba(239,68,68,0.55)"
            strokeWidth="1"
          />
          <circle cx={-8} cy={0} r={2.3} fill="#f87171" />
          <text x={5} y={3.2} textAnchor="middle" fontSize="8.5" fontFamily={MONO}
            fontWeight="700" letterSpacing="0.08em" fill="rgba(254,202,202,0.92)">
            {letter}
          </text>
        </g>
      ) : null}
    </g>
  );
}

/**
 * DnsNode — the single hostname every customer targets.
 * Infoblox DTC health-checked DNS: shows the live zone pool (E/C/W chips)
 * with a round-robin sweep; the West chip flips red while that zone is
 * out of rotation.
 */
function DnsNode({ uid }: { uid: string }) {
  const cx = COL.dns;
  const cy = LOC_Y[1];

  return (
    <g transform={`translate(${cx}, ${cy})`}>
      <circle r="80" fill={`url(#${uid}-lg)`} />
      <rect
        x={-DNS_W / 2} y={-DNS_H / 2}
        width={DNS_W} height={DNS_H} rx={11}
        fill="rgba(15,17,23,0.82)"
        stroke="rgba(96,165,250,0.45)"
        strokeWidth="1.2"
      />
      {/* Top shimmer */}
      <rect
        x={-DNS_W / 2 + 1} y={-DNS_H / 2 + 1}
        width={DNS_W - 2} height={DNS_H * 0.22} rx={10}
        fill="rgba(96,165,250,0.07)"
      />
      {/* Hostname */}
      <text y={-13} textAnchor="middle" fontSize="12.5" fontFamily={MONO}
        fontWeight="700" letterSpacing="0.01em" fill="#dbeafe"
        stroke="rgba(8,14,26,0.85)" strokeWidth="3" paintOrder="stroke">
        crag.granitevoip.com
      </text>
      {/* Mechanism sub-label */}
      <text y={0} textAnchor="middle" fontSize="6.8" fontFamily={MONO}
        fontWeight="600" letterSpacing="0.09em" fill="rgba(147,197,253,0.72)">
        INFOBLOX DTC · HEALTH-CHECKED DNS
      </text>
      {/* Zone pool — E / C / W */}
      <PoolChip uid={uid} x={-52} letter="E" rrIdx={0} />
      <PoolChip uid={uid} x={0}   letter="C" rrIdx={1} />
      <PoolChip
        uid={uid}
        x={52}
        letter="W"
        rrIdx={2}
        okClass={`${uid}-chip-ok-w`}
        badClass={`${uid}-chip-bad-w`}
      />
      {/* Caption */}
      <text y={DNS_H / 2 + 15} textAnchor="middle" fontSize="7.5" fontFamily={MONO}
        fontWeight="600" letterSpacing="0.08em" fill="rgba(170,186,210,0.62)"
        stroke="rgba(8,14,26,0.85)" strokeWidth="3" paintOrder="stroke">
        per-call resolution · TTL 30s
      </text>
    </g>
  );
}

/* ── Geographic zone container ── */
function LocationGroup({
  uid,
  locIdx,
  label,
  locClass,
  sbc1Class,
  sbc2Class,
  ksClass,
}: {
  uid: string;
  locIdx: number;
  label: string;
  locClass?: string;
  sbc1Class?: string;
  sbc2Class?: string;
  ksClass?: string;
}) {
  const cy  = LOC_Y[locIdx];
  const x   = COL.locIn;
  const h   = LOC_HALF_H * 2;
  const R   = 10;
  const top = cy - LOC_HALF_H;

  return (
    <g className={locClass}>
      {/* Container background — a self-contained availability zone */}
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
        fontFamily={MONO}
        letterSpacing="0.12em"
        fill="rgba(143,176,232,0.55)"
        fontWeight="600"
      >
        INDEPENDENT ZONE
      </text>

      {/* Signal Key pair */}
      <SbcNode uid={uid} cx={COL.sbcX} cy={cy - SBC_OFFSET} label="Signal Key 1" nodeClass={sbc1Class} />
      <SbcNode uid={uid} cx={COL.sbcX} cy={cy + SBC_OFFSET} label="Signal Key 2" nodeClass={sbc2Class} />

      {/* CRAG engine — the zone's media core */}
      <KsNode uid={uid} cx={COL.ksX} cy={cy} nodeClass={ksClass} />
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
        fontFamily={MONO}
        letterSpacing="0.06em" fill="rgba(196,212,236,0.82)" fontWeight="600">
        {label}
      </text>
    </g>
  );
}

/* ── CRAG Media Engine — logo image node ── */
function KsNode({
  uid,
  cx,
  cy,
  nodeClass,
}: {
  uid: string;
  cx: number;
  cy: number;
  nodeClass?: string;
}) {
  const S = 44;
  return (
    <g transform={`translate(${cx}, ${cy})`} className={nodeClass}>
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
        fontFamily={MONO}
        letterSpacing="0.06em" fill="rgba(147,197,253,0.80)" fontWeight="600">
        CRAG Engine
      </text>
    </g>
  );
}

/* ── Termination PoP — green-accented pill ── */
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
        fontFamily={MONO}
        letterSpacing="0.08em" fill="rgba(196,222,210,0.88)" fontWeight="600">
        {label}
      </text>
      <text y={H / 2 + 26} textAnchor="middle" fontSize="7.5" stroke="rgba(8,14,26,0.85)" strokeWidth="3" paintOrder="stroke"
        fontFamily={MONO}
        letterSpacing="0.07em" fill="rgba(134,158,150,0.62)" fontWeight="500">
        {sublabel}
      </text>
    </g>
  );
}

/* ── Status indicator — colour-keyed chip in the card header ── */
/*
 * Five state rows are absolutely stacked inside a fixed-height chip and
 * toggled by the 50s step-start window animations. Each row narrates the
 * current scenario honestly — including the DNS-level zone pull.
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
    padding: '0 14px',
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
    fontFamily: MONO,
    fontSize: '0.72rem',
    fontWeight: 600,
    letterSpacing: '0.04em',
    color: 'rgba(167,243,208,0.95)',
    whiteSpace: 'nowrap',
  };

  const alertText: CSSProperties = {
    fontFamily: MONO,
    fontSize: '0.72rem',
    fontWeight: 700,
    letterSpacing: '0.02em',
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
    <div style={{ position: 'relative', height: 40, width: 480, maxWidth: '100%' }}>
      {/* Steady state — round-robin */}
      <div className={`${uid}-status-normal`} style={okRow}>
        <div style={{ position: 'relative', width: 9, height: 9, flexShrink: 0 }}>
          <div style={haloStyle('rgba(34,197,94,0.18)')} />
          <div style={dotStyle('rgba(34,197,94,0.90)')} />
        </div>
        <span style={okText}>All zones in DNS rotation — round-robin steering</span>
      </div>

      {/* Signal Key 2 Central down — absorbed inside the zone */}
      <div className={`${uid}-status-sbc2c`} style={alertRow}>
        {alertDot}
        <span style={alertText}>Signal Key 2 Central down — zone NLB shifts to Key 1</span>
      </div>

      {/* Granite West pulled from DNS rotation */}
      <div className={`${uid}-status-west`} style={alertRow}>
        {alertDot}
        <span style={alertText}>DNS check failed — Granite West out of rotation · TTL 30s</span>
      </div>

      {/* Dallas PoP down */}
      <div className={`${uid}-status-dallas`} style={alertRow}>
        {alertDot}
        <span style={alertText}>Dallas PoP down — egress reroutes to LA + Backup</span>
      </div>

      {/* Signal Key 1 East down — absorbed inside the zone */}
      <div className={`${uid}-status-sbc1e`} style={alertRow}>
        {alertDot}
        <span style={alertText}>Signal Key 1 East down — zone NLB shifts to Key 2</span>
      </div>
    </div>
  );
}

export default HaArchitectureViz;
