import { useId, useMemo } from 'react';

/**
 * HaArchitectureViz
 *
 * SVG-based animated model of the Granite CRAG **inbound call path** as it
 * is actually deployed (RCF-V1, active/standby since 2026-08-27):
 *
 *            ┌ East:    LB → [SBC 1 active ][SBC 2 standby] → [FS-1 active][FS-2 standby] ┐
 *            │                                                                         ├→ Route A
 *  [PSTN] ───┼ Central: LB → …                                                         │
 *            │                                                                         ├→ Route B
 *            └ West:    LB → …                                                         ┘
 *
 * Inbound calls reach all three regions directly (there is no DNS layer in
 * front). Inside a region the load balancer sends everything to the
 * ACTIVE SBC; the standby SBC and the hot-standby media server (FS-2)
 * carry nothing until a failover. Each region leaves through its primary
 * termination route (East + Central → A, West → B) and retries the other
 * on failure.
 *
 * Public-page rules (owner, 2026-10): no cloud provider, no carrier names,
 * no PoP cities, no NLB/ILB jargon — generic "PSTN", "load balancer",
 * "Route A/B" only.
 *
 * Failover simulation — a 50-second CSS keyframe cycle, four scenarios:
 *   6–12s   (12–24%)  Central STANDBY SBC lost → no traffic moves; alarm
 *   18–27s  (36–54%)  West media down → West fails its health check
 *                     (answers 503) and new calls land in East + Central
 *   33–39s  (66–78%)  Route A lost → East + Central retry on Route B
 *   44–49s  (88–98%)  East ACTIVE SBC lost → standby takes over (~10 s in
 *                     reality: health check 5 s × 2); calls in progress
 *                     are designed to continue
 * Everything else is steady state. All windows are declared once (W_*)
 * and every keyframe block is generated from them. Pure SVG + CSS
 * animation — no JS timers, no rAF. Reduced motion: packets hidden, the
 * static diagram + scenario legend remain.
 *
 * Frame, header, status chip and timeline are styled by `.ha-*` rules in
 * styles/landing.css (this component is only used on the landing page).
 */

/* ─── Geometry constants ─────────────────────────────────────────────── */

const VB_W = 1280;
const VB_H = 560;

// Column x-positions
const COL = {
  pstn: 104,    // inbound PSTN node
  locIn: 300,   // left edge of region containers
  locOut: 936,  // right edge of region containers
  lbX: 350,     // regional load-balancer pill centre
  sbcX: 522,    // SBC pair centre (active above, standby below)
  fsX: 762,     // media pair centre (FS-1 above, FS-2 below)
  termX: 1150,  // termination route nodes
} as const;

// Region rows (East, Central, West)
const LOC_Y = [134, 298, 462] as const;
const LOC_HALF_H = 76;
const LOC_W = COL.locOut - COL.locIn;
const LOC_TITLE_H = 26;
// Within a region: the active member sits above, the standby below.
const ACTIVE_DY = -16;
const STANDBY_DY = 42;
const LB_DY = 13;

// Inbound node (centred on the middle region) and termination routes A/B
const PSTN_Y = LOC_Y[1];
const TERM_Y = [216, 380] as const;
const NODE_W = 132;
const NODE_H = 54;
const TERM_W = 120;
const LB_W = 52;
const LB_H = 26;

/* ─── Failover timing windows (percent of the 50s master cycle) ──────── */
/* 1s = 2%. Declared once; every keyframe below is generated from these. */

type Win = readonly [number, number];

const W_SBC2C: Win = [12, 24];  //  6–12s  Central standby SBC lost
const W_WEST: Win = [36, 54];   // 18–27s  West drained (media down → 503)
const W_ROUTEA: Win = [66, 78]; // 33–39s  Route A lost
const W_SBC1E: Win = [88, 98];  // 44–49s  East active SBC lost
// The standby picks up a beat after the active dies (the real flip is the
// load balancer's 5 s × 2 health check, ~10 s — compressed here).
const W_SBC1E_FLIP: Win = [W_SBC1E[0] + 2, W_SBC1E[1]];

/* ─── SVG path helpers ───────────────────────────────────────────────── */

function cubicPath(
  x1: number, y1: number,
  cp1X: number, cp1Y: number,
  cp2X: number, cp2Y: number,
  x2: number, y2: number,
): string {
  return `M ${x1} ${y1} C ${cp1X} ${cp1Y} ${cp2X} ${cp2Y} ${x2} ${y2}`;
}

/** Horizontal S-curve between two points. */
function sCurve(x1: number, y1: number, x2: number, y2: number, k = 0.45): string {
  const dx = x2 - x1;
  return cubicPath(x1, y1, x1 + dx * k, y1, x2 - dx * k, y2, x2, y2);
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
 * Each packet belongs to one group. During a failure window the group's
 * packets hide; the paired reroute group's packets appear only inside it.
 */
type FailoverGroup =
  | 'normal'
  | 'west-zone'        // via West                  (hides during W_WEST)
  | 'route-a'          // East/Central → Route A    (hides during W_ROUTEA)
  | 'sbc1-east'        // via East's active SBC     (hides during W_SBC1E)
  | 'reroute-west'     // extra load on East/Central (only during W_WEST)
  | 'reroute-a'        // East/Central → Route B    (only during W_ROUTEA)
  | 'flip-east';       // via East's standby SBC    (only during the flip)

interface PathDef {
  id: string;
  d: string;
}

/* ─── Path definitions ───────────────────────────────────────────────── */

const ZONES = ['e', 'c', 'w'] as const;
type Zone = (typeof ZONES)[number];
const ZONE_IDX: Record<Zone, number> = { e: 0, c: 1, w: 2 };

const lbY = (z: Zone) => LOC_Y[ZONE_IDX[z]] + LB_DY;
const activeY = (z: Zone) => LOC_Y[ZONE_IDX[z]] + ACTIVE_DY;
const standbyY = (z: Zone) => LOC_Y[ZONE_IDX[z]] + STANDBY_DY;

// PSTN → each regional load balancer
const ingressPath = (z: Zone): PathDef => ({
  id: `in-${z}`,
  d: sCurve(COL.pstn + NODE_W / 2 + 2, PSTN_Y + (ZONE_IDX[z] - 1) * 8, COL.lbX - LB_W / 2 - 3, lbY(z), 0.5),
});

// Load balancer → active SBC (live) / standby SBC (idle until a flip)
const lbToActive = (z: Zone): PathDef => ({
  id: `v1-${z}`,
  d: sCurve(COL.lbX + LB_W / 2 + 2, lbY(z), COL.sbcX - 22, activeY(z)),
});
const lbToStandby = (z: Zone): PathDef => ({
  id: `v2-${z}`,
  d: sCurve(COL.lbX + LB_W / 2 + 2, lbY(z), COL.sbcX - 22, standbyY(z)),
});

// SBC → active media server (FS-1)
const activeToFs = (z: Zone): PathDef => ({
  id: `s1f-${z}`,
  d: sCurve(COL.sbcX + 22, activeY(z), COL.fsX - 22, activeY(z)),
});
const standbyToFs = (z: Zone): PathDef => ({
  id: `s2f-${z}`,
  d: sCurve(COL.sbcX + 22, standbyY(z), COL.fsX - 22, activeY(z)),
});

// FS-1 → termination route (t: 0 = Route A, 1 = Route B)
const egressPath = (z: Zone, t: 0 | 1): PathDef => ({
  id: `${z}-r${t === 0 ? 'a' : 'b'}`,
  d: sCurve(COL.fsX + 22, activeY(z), COL.termX - TERM_W / 2 - 3, TERM_Y[t], 0.42),
});

// Primary route per region: East + Central → A, West → B.
const PRIMARY_TERM: Record<Zone, 0 | 1> = { e: 0, c: 0, w: 1 };

const PATHS: PathDef[] = [
  ...ZONES.map(ingressPath),
  ...ZONES.map(lbToActive),
  ...ZONES.map(lbToStandby),
  ...ZONES.map(activeToFs),
  ...ZONES.map(standbyToFs),
  ...ZONES.flatMap((z) => [egressPath(z, 0), egressPath(z, 1)]),
];
const PATH_BY_ID = new Map(PATHS.map((p) => [p.id, p]));

/* ─── Packet animation config ────────────────────────────────────────── */

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
  // ── Inbound: PSTN → all three regions ────────────────────────────────
  ...makePackets('in-e', 3, 0.9, 'normal', false, 0.0),
  ...makePackets('in-c', 3, 0.9, 'normal', false, 0.21),
  ...makePackets('in-w', 3, 0.9, 'west-zone', false, 0.42),
  // West drained → its share lands on East + Central
  ...makePackets('in-e', 2, 0.9, 'reroute-west', false, 0.33),
  ...makePackets('in-c', 2, 0.9, 'reroute-west', false, 0.6),

  // ── Inside each region: LB → ACTIVE SBC → FS-1 ───────────────────────
  ...makePackets('v1-e', 3, 0.5, 'sbc1-east', false, 0.05),
  ...makePackets('v1-c', 3, 0.5, 'normal', false, 0.15),
  ...makePackets('v1-w', 3, 0.5, 'west-zone', false, 0.1),
  ...makePackets('s1f-e', 3, 0.45, 'sbc1-east', false, 0.08),
  ...makePackets('s1f-c', 3, 0.45, 'normal', false, 0.2),
  ...makePackets('s1f-w', 3, 0.45, 'west-zone', false, 0.12),
  // Extra load inside East + Central while West is drained
  ...makePackets('v1-c', 2, 0.5, 'reroute-west', false, 0.3),
  ...makePackets('s1f-c', 2, 0.45, 'reroute-west', false, 0.25),

  // East active SBC lost → the standby carries the region
  ...makePackets('v2-e', 3, 0.5, 'flip-east', false, 0.1),
  ...makePackets('s2f-e', 3, 0.5, 'flip-east', false, 0.18),

  // ── Egress: FS-1 → primary route (East + Central A, West B) ──────────
  ...makePackets('e-ra', 3, 0.6, 'route-a', true, 0.0),
  ...makePackets('c-ra', 3, 0.6, 'route-a', true, 0.2),
  ...makePackets('w-rb', 3, 0.6, 'west-zone', true, 0.1),
  // Route A lost → East + Central retry on Route B
  ...makePackets('e-rb', 3, 0.6, 'reroute-a', true, 0.05),
  ...makePackets('c-rb', 3, 0.6, 'reroute-a', true, 0.25),
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

/** Standby → active: dim except inside the window. */
function kfPromote(name: string, [a, b]: Win, dim: number): string {
  return `@keyframes ${name} {
  0%, ${a - 0.1}% { opacity: ${dim}; }
  ${a}% { opacity: 1; }
  ${b - 0.1}% { opacity: 1; }
  ${b}%, 100% { opacity: ${dim}; }
}`;
}

// Red failure glow — clean drop-shadows only, no hue distortion.
const F_DIM = 'drop-shadow(0 0 6px rgba(220,38,38,0.35)) drop-shadow(0 0 18px rgba(220,38,38,0.15))';
const F_PEAK = 'drop-shadow(0 0 10px rgba(220,38,38,0.6)) drop-shadow(0 0 28px rgba(220,38,38,0.28))';

/** Three smooth red pulses across a failure window. */
function kfFailPulse(name: string, [a, b]: Win, base: number, dimOp: number, peakOp: number): string {
  const at = (f: number) => +(a + (b - a) * f).toFixed(2);
  return `@keyframes ${name} {
  0%, ${a - 0.1}% { opacity: ${base}; filter: none; }
  ${at(0.05)}% { opacity: ${dimOp};  filter: ${F_DIM};  }
  ${at(0.22)}% { opacity: ${peakOp}; filter: ${F_PEAK}; }
  ${at(0.40)}% { opacity: ${dimOp};  filter: ${F_DIM};  }
  ${at(0.58)}% { opacity: ${peakOp}; filter: ${F_PEAK}; }
  ${at(0.78)}% { opacity: ${dimOp};  filter: ${F_DIM};  }
  ${at(0.94)}% { opacity: ${peakOp}; filter: ${F_PEAK}; }
  ${Math.min(b + 0.4, 99.9)}% { opacity: ${base}; filter: none; }
  100% { opacity: ${base}; filter: none; }
}`;
}

const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';
const DISPLAY = '"Archivo", "IBM Plex Sans", sans-serif';
const STANDBY_OPACITY = 0.5;

/* ─── Failover scenarios — ONE list drives the header status rows and the
   timeline legend. ── */
interface Scene {
  key: 'sbc2c' | 'west' | 'routea' | 'sbc1e';
  win: Win;
  title: string;
  /** Short line for the header status chip. */
  status: string;
  /** Full line for the legend. */
  text: string;
}

const SCENES: Scene[] = [
  {
    key: 'sbc2c',
    win: W_SBC2C,
    title: 'Standby SBC lost',
    status: 'Central standby SBC down — no traffic impact',
    text: 'Central standby SBC down — no traffic impact; a redundancy alarm is raised.',
  },
  {
    key: 'west',
    win: W_WEST,
    title: 'Region drained',
    status: 'West media down — drained; calls land in East + Central',
    text: 'West media down — West fails its health check (answers 503), so new calls land in East and Central.',
  },
  {
    key: 'routea',
    win: W_ROUTEA,
    title: 'Termination route lost',
    status: 'Route A down — calls retry on Route B',
    text: 'Route A down — calls retry on the next route, B.',
  },
  {
    key: 'sbc1e',
    win: W_SBC1E,
    title: 'Active SBC lost',
    status: 'East active SBC down — standby takes over in ~10 s',
    text: 'East active SBC down — the standby takes over in about 10 s; calls in progress are designed to continue.',
  },
];

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
      kfHide(`${uid}-hide-west`, [W_WEST]),
      kfHide(`${uid}-hide-routea`, [W_ROUTEA]),
      kfHide(`${uid}-hide-sbc1e`, [W_SBC1E]),
      kfHide(`${uid}-hide-all`, [W_SBC2C, W_WEST, W_ROUTEA, W_SBC1E]),
      kfShow(`${uid}-show-sbc2c`, W_SBC2C),
      kfShow(`${uid}-show-west`, W_WEST),
      kfShow(`${uid}-show-routea`, W_ROUTEA),
      kfShow(`${uid}-show-sbc1e`, W_SBC1E),
      kfShow(`${uid}-show-flip`, W_SBC1E_FLIP),
    ].join('\n');

    function pktVisAnim(group: FailoverGroup): string | null {
      switch (group) {
        case 'normal':       return null;
        case 'west-zone':    return `${uid}-hide-west`;
        case 'route-a':      return `${uid}-hide-routea`;
        case 'sbc1-east':    return `${uid}-hide-sbc1e`;
        case 'reroute-west': return `${uid}-show-west`;
        case 'reroute-a':    return `${uid}-show-routea`;
        case 'flip-east':    return `${uid}-show-flip`;
      }
    }

    const packetRules = ALL_PACKETS.map((pkt, i) => {
      const path = PATH_BY_ID.get(pkt.pathId);
      if (!path) return '';
      const visAnim = pktVisAnim(pkt.group);
      const names = visAnim ? `${uid}-pkt-${path.id}, ${visAnim}` : `${uid}-pkt-${path.id}`;
      const durs = visAnim ? `${pkt.duration}s, 50s` : `${pkt.duration}s`;
      const dels = visAnim ? `${pkt.delay}s, 0s` : `${pkt.delay}s`;
      const iters = visAnim ? 'infinite, infinite' : 'infinite';
      const fills = visAnim ? 'both, both' : 'both';
      const tfs = visAnim ? 'cubic-bezier(0.4,0,0.6,1), step-start' : 'cubic-bezier(0.4,0,0.6,1)';
      const hiddenAtRest =
        pkt.group === 'reroute-west' || pkt.group === 'reroute-a' || pkt.group === 'flip-east';
      return `.${uid}-p${i} {
  offset-path: path('${path.d}');
  offset-rotate: auto;
  animation-name: ${names};
  animation-duration: ${durs};
  animation-delay: ${dels};
  animation-timing-function: ${tfs};
  animation-iteration-count: ${iters};
  animation-fill-mode: ${fills};${hiddenAtRest ? '\n  opacity: 0;' : ''}
}`;
    }).join('\n');

    // 3. Node state animations — red pulses + the standby promotion.
    const nodeKf = [
      kfFailPulse(`${uid}-nkf-sbc2c`, W_SBC2C, STANDBY_OPACITY, 0.55, 0.75),
      kfFailPulse(`${uid}-nkf-sbc1e`, W_SBC1E, 1, 0.5, 0.62),
      kfFailPulse(`${uid}-nkf-routea`, W_ROUTEA, 1, 0.5, 0.62),
      // West FS-1 sits inside the dimmed region — pulse it brighter.
      kfFailPulse(`${uid}-nkf-westfs`, W_WEST, 1, 0.74, 0.95),
      kfPromote(`${uid}-nkf-promote`, W_SBC1E_FLIP, STANDBY_OPACITY),
      `@keyframes ${uid}-zone-west-dim {
  0%, ${W_WEST[0] - 0.1}% { opacity: 1; }
  ${W_WEST[0] + 0.8}% { opacity: 0.5; }
  ${W_WEST[1] - 0.8}% { opacity: 0.5; }
  ${W_WEST[1]}% { opacity: 1; }
  100% { opacity: 1; }
}`,
    ].join('\n');

    const nodeRules = `
.${uid}-node-sbc2central { animation: ${uid}-nkf-sbc2c    50s linear infinite; }
.${uid}-node-sbc1east    { animation: ${uid}-nkf-sbc1e    50s linear infinite; }
.${uid}-node-sbc2east    { animation: ${uid}-nkf-promote  50s step-start infinite; }
.${uid}-node-routea      { animation: ${uid}-nkf-routea   50s linear infinite; }
.${uid}-node-westfs      { animation: ${uid}-nkf-westfs   50s linear infinite; }
.${uid}-zone-west        { animation: ${uid}-zone-west-dim 50s linear infinite; }
.${uid}-line-west        { animation: ${uid}-hide-west     50s step-start infinite; }
.${uid}-fail-503         { animation: ${uid}-show-west     50s step-start infinite; opacity: 0; }
.${uid}-lb-ok-w          { animation: ${uid}-hide-west     50s step-start infinite; }
.${uid}-lb-bad-w         { animation: ${uid}-show-west     50s step-start infinite; opacity: 0; }`;

    // 4. Status chip rows + legend highlights.
    const statusRules = `
.${uid}-status-normal { animation: ${uid}-hide-all   50s step-start infinite; }
${SCENES.map((sc) => `.${uid}-status-${sc.key} { animation: ${uid}-show-${sc.key} 50s step-start infinite; opacity: 0; }
.${uid}-scene-${sc.key} { animation: ${uid}-show-${sc.key} 50s step-start infinite; }`).join('\n')}
.${uid}-alert-halo { animation: ${uid}-alert-halo-pulse 0.75s ease-out infinite; }`;

    const alertHaloKf = `
@keyframes ${uid}-alert-halo-pulse {
  0%   { transform: scale(1);   opacity: 0.70; }
  60%  { transform: scale(2.4); opacity: 0;    }
  100% { transform: scale(2.4); opacity: 0;    }
}`;

    // 5. Reduced motion — freeze the story to its steady-state frame:
    //    no animations, no packets; the static architecture stays.
    const reducedMotion = `
@media (prefers-reduced-motion: reduce) {
  [class*="${uid}"] { animation: none !important; }
  .${uid}-packets { display: none !important; }
}`;

    return [
      pathKf, groupKf, packetRules,
      nodeKf, nodeRules,
      alertHaloKf, statusRules,
      reducedMotion,
    ].join('\n');
  }, [uid]);

  return (
    <figure className="ha-frame" aria-labelledby={`${uid}-title`}>
      <style dangerouslySetInnerHTML={{ __html: css }} />

      {/* Header — title + one-line description, status chip right */}
      <div className="ha-head">
        <div className="ha-head-text">
          <h3 className="ha-title" id={`${uid}-title`}>
            High Availability Simulation
          </h3>
          <p className="ha-desc">
            How calls ride three independent regions — and what happens when a
            border controller, a media layer or a termination route fails.
          </p>
        </div>

        <StatusIndicatorHtml uid={uid} />
      </div>

      {/* Diagram body — scrolls sideways (never the page) below 760px */}
      <div className="ha-body">
        <div
          className="ha-scroll"
          tabIndex={0}
          role="region"
          aria-label="High availability diagram"
        >
          <svg
            className="ha-svg"
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label="Inbound call path: calls from the PSTN reach three independent Granite regions — East, Central and West — each behind its own health-checked load balancer. Each region has an active/standby SBC pair and an active/hot-standby media server pair, FS-1 and FS-2, and calls leave over termination routes A and B. A 50-second animation loops four failure scenarios: a standby SBC lost with no traffic impact; a region whose media fails its health check and is drained while new calls land in the other regions; Route A lost with calls retrying on Route B; and an active SBC lost with the standby taking over in about 10 seconds."
          >
            <defs>
              <pattern id={`${uid}-grid`} width="48" height="48" patternUnits="userSpaceOnUse">
                <path d="M 48 0 L 0 0 0 48" fill="none" stroke="rgba(99,130,180,0.06)" strokeWidth="1" />
              </pattern>

              {/* Node glows */}
              <radialGradient id={`${uid}-ng`} cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#2f7df6" stopOpacity="0.22" />
                <stop offset="100%" stopColor="#2f7df6" stopOpacity="0" />
              </radialGradient>
              <radialGradient id={`${uid}-tg`} cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#34d399" stopOpacity="0.2" />
                <stop offset="100%" stopColor="#059669" stopOpacity="0" />
              </radialGradient>

              {/* Fiber-optic beams — azure inside Granite, green on egress */}
              <linearGradient id={`${uid}-beam-blue`} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#2f7df6" stopOpacity="0" />
                <stop offset="25%" stopColor="#8fb6ff" stopOpacity="0.9" />
                <stop offset="50%" stopColor="#eef4ff" stopOpacity="1" />
                <stop offset="75%" stopColor="#8fb6ff" stopOpacity="0.9" />
                <stop offset="100%" stopColor="#2f7df6" stopOpacity="0" />
              </linearGradient>
              <linearGradient id={`${uid}-beam-green`} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#059669" stopOpacity="0" />
                <stop offset="25%" stopColor="#6ee7b7" stopOpacity="0.9" />
                <stop offset="50%" stopColor="#ecfdf5" stopOpacity="1" />
                <stop offset="75%" stopColor="#6ee7b7" stopOpacity="0.9" />
                <stop offset="100%" stopColor="#059669" stopOpacity="0" />
              </linearGradient>

              <clipPath id={`${uid}-clip`}>
                <rect x="0" y="0" width={VB_W} height={VB_H} />
              </clipPath>

              <filter id={`${uid}-pf`} x="-200%" y="-400%" width="500%" height="900%">
                <feGaussianBlur in="SourceGraphic" stdDeviation="2.4" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>

              <filter id={`${uid}-imgf`} x="-60%" y="-60%" width="220%" height="220%">
                <feGaussianBlur in="SourceGraphic" stdDeviation="2.8" result="blur" />
                <feColorMatrix
                  in="blur"
                  type="matrix"
                  values="0 0 0 0 0.18   0 0 0 0 0.49   0 0 0 0 0.96   0 0 0 0.55 0"
                  result="coloredBlur"
                />
                <feMerge>
                  <feMergeNode in="coloredBlur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            <rect x="0" y="0" width={VB_W} height={VB_H} fill={`url(#${uid}-grid)`} />

            {/* ── Static rails ───────────────────────────────────── */}
            <g fill="none" clipPath={`url(#${uid}-clip)`}>
              {/* Inbound: PSTN → every region. West's rail vanishes while
                  West is drained. */}
              {ZONES.map((z) => {
                const p = ingressPath(z);
                const rail = (
                  <path key={p.id} d={p.d} stroke="rgba(79,146,255,0.28)" strokeWidth="1.3" />
                );
                return z === 'w' ? (
                  <g key={p.id} className={`${uid}-line-west`}>{rail}</g>
                ) : (
                  rail
                );
              })}

              {/* Live path inside each region: LB → active SBC → FS-1 */}
              {ZONES.flatMap((z) => [lbToActive(z), activeToFs(z)]).map((p) => (
                <path key={p.id} d={p.d} stroke="rgba(79,146,255,0.3)" strokeWidth="1.1" />
              ))}

              {/* Standby paths — dashed, idle until a flip */}
              {ZONES.flatMap((z) => [lbToStandby(z), standbyToFs(z)]).map((p) => (
                <path
                  key={p.id}
                  d={p.d}
                  stroke="rgba(143,182,255,0.2)"
                  strokeWidth="1"
                  strokeDasharray="3 4"
                />
              ))}

              {/* Egress: primary route solid green, alternate dashed */}
              {ZONES.flatMap((z) =>
                ([0, 1] as const).map((t) => {
                  const p = egressPath(z, t);
                  const primary = PRIMARY_TERM[z] === t;
                  return (
                    <path
                      key={p.id}
                      d={p.d}
                      stroke={primary ? 'rgba(52,211,153,0.26)' : 'rgba(52,211,153,0.16)'}
                      strokeWidth={primary ? 1.1 : 1}
                      strokeDasharray={primary ? undefined : '3 4'}
                    />
                  );
                }),
              )}
            </g>

            {/* ── Animated beams ─────────────────────────────────── */}
            <g clipPath={`url(#${uid}-clip)`} className={`${uid}-packets`}>
              {ALL_PACKETS.map((pkt, i) => (
                <rect
                  key={i}
                  x={-13}
                  y="-1.5"
                  width={26}
                  height="3"
                  rx="1.5"
                  fill={`url(#${uid}-beam-${pkt.isTerm ? 'green' : 'blue'})`}
                  filter={`url(#${uid}-pf)`}
                  className={`${uid}-p${i}`}
                />
              ))}
            </g>

            {/* ── Nodes ──────────────────────────────────────────── */}
            <PstnNode uid={uid} />

            <RegionGroup
              uid={uid}
              zone="e"
              label="East"
              sbc1Class={`${uid}-node-sbc1east`}
              sbc2Class={`${uid}-node-sbc2east`}
            />
            <RegionGroup
              uid={uid}
              zone="c"
              label="Central"
              sbc2Class={`${uid}-node-sbc2central`}
            />
            <RegionGroup
              uid={uid}
              zone="w"
              label="West"
              regionClass={`${uid}-zone-west`}
              fs1Class={`${uid}-node-westfs`}
            />

            <TermNode uid={uid} termIdx={0} label="Route A" nodeClass={`${uid}-node-routea`} />
            <TermNode uid={uid} termIdx={1} label="Route B" />

            {/* Health-check callout — in the corridor the West stream
                vacates while the region is drained */}
            <g className={`${uid}-fail-503`}>
              <text
                x={232} y={506}
                textAnchor="middle"
                fontSize="12.5"
                fontFamily={MONO}
                fontWeight="700"
                letterSpacing="0.04em"
                fill="#fca5a5"
                stroke="rgba(8,14,26,0.9)"
                strokeWidth="3.5"
                paintOrder="stroke"
              >
                HEALTH CHECK → 503
              </text>
              <text
                x={232} y={523}
                textAnchor="middle"
                fontSize="9.5"
                fontFamily={MONO}
                fontWeight="600"
                letterSpacing="0.12em"
                fill="rgba(252,165,165,0.8)"
                stroke="rgba(8,14,26,0.9)"
                strokeWidth="3"
                paintOrder="stroke"
              >
                REGION DRAINED
              </text>
            </g>

            {/* ── Column headers ─────────────────────────────────── */}
            <ColumnLabel text="INBOUND" x={COL.pstn} y={26} />
            <ColumnLabel text="LOAD BALANCER" x={COL.lbX} y={26} />
            <ColumnLabel text="SBC PAIR" x={COL.sbcX} y={26} />
            <ColumnLabel text="MEDIA PAIR" x={COL.fsX} y={26} />
            <ColumnLabel text="TERMINATION" x={COL.termX} y={26} />
          </svg>
        </div>
        <p className="ha-hint">Swipe sideways to follow a call end to end.</p>
      </div>

      <ScenarioTimeline uid={uid} />
    </figure>
  );
}

/* ─── Sub-components ─────────────────────────────────────────────────── */

function ColumnLabel({ text, x, y }: { text: string; x: number; y: number }) {
  return (
    <g>
      <text
        x={x} y={y}
        textAnchor="middle"
        fontSize="12.5"
        fontFamily={DISPLAY}
        letterSpacing="0.16em"
        fill="rgba(168,193,232,0.82)"
        fontWeight="700"
      >
        {text}
      </text>
      <rect x={x - 11} y={y + 7} width={22} height={2.5} fill="rgba(47,125,246,0.6)" />
    </g>
  );
}

/** Inbound calls from the PSTN — they reach all three regions. */
function PstnNode({ uid }: { uid: string }) {
  return (
    <g transform={`translate(${COL.pstn}, ${PSTN_Y})`}>
      <circle r="66" fill={`url(#${uid}-ng)`} />
      <rect
        x={-NODE_W / 2} y={-NODE_H / 2}
        width={NODE_W} height={NODE_H} rx={12}
        fill="rgba(12,18,32,0.9)"
        stroke="rgba(79,146,255,0.45)"
        strokeWidth="1.2"
      />
      <rect
        x={-NODE_W / 2 + 1} y={-NODE_H / 2 + 1}
        width={NODE_W - 2} height={NODE_H * 0.26} rx={11}
        fill="rgba(79,146,255,0.07)"
      />
      <text y={0} textAnchor="middle" fontSize="16" fontFamily={DISPLAY} fontWeight="800" letterSpacing="0.06em" fill="#eef4ff">
        PSTN
      </text>
      <text y={17} textAnchor="middle" fontSize="10" fontFamily={MONO} fontWeight="600" letterSpacing="0.06em" fill="rgba(143,182,255,0.78)">
        inbound calls
      </text>
    </g>
  );
}

/** Text label under a node, with a dark halo so it reads over rails. */
function NodeLabel({ y, text, dim }: { y: number; text: string; dim?: boolean }) {
  return (
    <text
      y={y}
      textAnchor="middle"
      fontSize="11"
      fontFamily={MONO}
      fontWeight="600"
      letterSpacing="0.04em"
      fill={dim ? 'rgba(170,186,210,0.7)' : 'rgba(208,222,244,0.92)'}
      stroke="rgba(8,14,26,0.85)"
      strokeWidth="3"
      paintOrder="stroke"
    >
      {text}
    </text>
  );
}

/** SBC (border controller) — active member full strength, standby dimmed. */
function SbcNode({
  uid, cy, label, standby, nodeClass,
}: {
  uid: string; cy: number; label: string; standby?: boolean; nodeClass?: string;
}) {
  const S = 32;
  return (
    <g
      transform={`translate(${COL.sbcX}, ${cy})`}
      className={nodeClass}
      opacity={standby ? STANDBY_OPACITY : 1}
    >
      <circle r="28" fill={`url(#${uid}-ng)`} />
      <image
        href="/signal_key.png"
        x={-S / 2} y={-S / 2}
        width={S} height={S}
        filter={`url(#${uid}-imgf)`}
        preserveAspectRatio="xMidYMid meet"
      />
      <NodeLabel y={S / 2 + 13} text={label} dim={standby} />
    </g>
  );
}

/** Media server — the CRAG engine; FS-1 active, FS-2 hot standby. */
function FsNode({
  uid, cy, label, standby, nodeClass,
}: {
  uid: string; cy: number; label: string; standby?: boolean; nodeClass?: string;
}) {
  const S = 34;
  return (
    <g
      transform={`translate(${COL.fsX}, ${cy})`}
      className={nodeClass}
      opacity={standby ? STANDBY_OPACITY : 1}
    >
      <circle r="30" fill={`url(#${uid}-ng)`} />
      <image
        href="/crag-mark.webp"
        x={-S / 2} y={-S / 2}
        width={S} height={S}
        filter={`url(#${uid}-imgf)`}
        preserveAspectRatio="xMidYMid meet"
      />
      <NodeLabel y={S / 2 + 12} text={label} dim={standby} />
    </g>
  );
}

/** The region's health-checked load balancer. West's flips to a red 503
    state while that region is drained. */
function LbNode({ uid, zone }: { uid: string; zone: Zone }) {
  const pill = (stroke: string, fill: string, text: string, color: string) => (
    <>
      <rect
        x={-LB_W / 2} y={-LB_H / 2}
        width={LB_W} height={LB_H} rx={LB_H / 2}
        fill={fill}
        stroke={stroke}
        strokeWidth="1.2"
      />
      <text y={4} textAnchor="middle" fontSize="11" fontFamily={MONO} fontWeight="700" letterSpacing="0.1em" fill={color}>
        {text}
      </text>
    </>
  );
  return (
    <g transform={`translate(${COL.lbX}, ${lbY(zone)})`}>
      <g className={zone === 'w' ? `${uid}-lb-ok-w` : undefined}>
        {pill('rgba(79,146,255,0.55)', 'rgba(16,30,56,0.95)', 'LB', '#cfe0ff')}
      </g>
      {zone === 'w' && (
        <g className={`${uid}-lb-bad-w`}>
          {pill('rgba(239,68,68,0.7)', 'rgba(40,12,16,0.95)', '503', '#fecaca')}
        </g>
      )}
    </g>
  );
}

/* ── Region container ── */
function RegionGroup({
  uid, zone, label, regionClass, sbc1Class, sbc2Class, fs1Class,
}: {
  uid: string;
  zone: Zone;
  label: string;
  regionClass?: string;
  sbc1Class?: string;
  sbc2Class?: string;
  fs1Class?: string;
}) {
  const cy = LOC_Y[ZONE_IDX[zone]];
  const x = COL.locIn;
  const h = LOC_HALF_H * 2;
  const R = 10;
  const top = cy - LOC_HALF_H;

  return (
    <g className={regionClass}>
      <rect
        x={x} y={top}
        width={LOC_W} height={h} rx={R}
        fill="rgba(16,26,45,0.55)"
        stroke="rgba(79,146,255,0.32)"
        strokeWidth="1.1"
      />
      <path
        d={topRoundedRect(x + 0.6, top + 0.6, LOC_W - 1.2, LOC_TITLE_H, R - 1)}
        fill="rgba(47,125,246,0.1)"
      />
      <line
        x1={x} y1={top + LOC_TITLE_H}
        x2={x + LOC_W} y2={top + LOC_TITLE_H}
        stroke="rgba(79,146,255,0.24)"
        strokeWidth="1"
      />
      <rect x={x + 14} y={top + 10.5} width={9} height={5} fill="rgba(47,125,246,0.85)" />
      <text
        x={x + 31} y={top + 18}
        fontSize="13"
        fontFamily={DISPLAY}
        letterSpacing="0.14em"
        fill="#d3e2fb"
        fontWeight="700"
      >
        {label.toUpperCase()}
      </text>
      <text
        x={x + LOC_W - 14} y={top + 17.5}
        textAnchor="end"
        fontSize="9"
        fontFamily={MONO}
        letterSpacing="0.12em"
        fill="rgba(143,176,232,0.6)"
        fontWeight="600"
      >
        INDEPENDENT REGION
      </text>

      <LbNode uid={uid} zone={zone} />
      <SbcNode uid={uid} cy={activeY(zone)} label="SBC 1 · active" nodeClass={sbc1Class} />
      <SbcNode uid={uid} cy={standbyY(zone)} label="SBC 2 · standby" standby nodeClass={sbc2Class} />
      <FsNode uid={uid} cy={activeY(zone)} label="FS-1 · active" nodeClass={fs1Class} />
      <FsNode uid={uid} cy={standbyY(zone)} label="FS-2 · hot standby" standby />
    </g>
  );
}

/* ── Termination route — green-accented node ── */
function TermNode({
  uid, termIdx, label, nodeClass,
}: {
  uid: string; termIdx: 0 | 1; label: string; nodeClass?: string;
}) {
  return (
    <g transform={`translate(${COL.termX}, ${TERM_Y[termIdx]})`} className={nodeClass}>
      <circle r="60" fill={`url(#${uid}-tg)`} />
      <rect
        x={-TERM_W / 2} y={-NODE_H / 2}
        width={TERM_W} height={NODE_H} rx={12}
        fill="rgba(10,20,22,0.9)"
        stroke="rgba(52,211,153,0.42)"
        strokeWidth="1.2"
      />
      <rect
        x={-TERM_W / 2 + 1} y={-NODE_H / 2 + 1}
        width={TERM_W - 2} height={NODE_H * 0.26} rx={11}
        fill="rgba(52,211,153,0.06)"
      />
      <text y={0} textAnchor="middle" fontSize="15" fontFamily={DISPLAY} fontWeight="800" fill="#e7fbf2">
        {label}
      </text>
      <text y={17} textAnchor="middle" fontSize="10" fontFamily={MONO} fontWeight="600" letterSpacing="0.06em" fill="rgba(134,239,172,0.72)">
        to the PSTN
      </text>
    </g>
  );
}

/* ── Status indicator — colour-keyed chip in the card header ── */
/*
 * Five state rows are absolutely stacked inside a fixed-height chip and
 * toggled by the 50s step-start window animations. Hidden from assistive
 * tech: all five rows are always in the DOM, so the timeline legend below
 * is the readable version.
 */
function StatusIndicatorHtml({ uid }: { uid: string }) {
  return (
    <div className="ha-status" aria-hidden="true">
      <div className={`ha-status-row ha-status-ok ${uid}-status-normal`}>
        <span className="ha-status-dot" />
        <span className="ha-status-text">All regions taking calls</span>
      </div>

      {SCENES.map((sc) => (
        <div
          key={sc.key}
          className={`ha-status-row ha-status-alert ${uid}-status-${sc.key}`}
        >
          <span className="ha-status-dot">
            <span className={`ha-status-halo ${uid}-alert-halo`} />
          </span>
          <span className="ha-status-text">{sc.status}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Scenario timeline — the 50s cycle as a track (failure windows drawn
   at their real positions, a running playhead) plus a numbered legend
   whose active entry lights up in sync with the diagram. ── */
function ScenarioTimeline({ uid }: { uid: string }) {
  return (
    <div className="ha-timeline">
      <div className="ha-track" aria-hidden="true">
        {SCENES.map((sc, i) => (
          <span
            key={sc.key}
            className="ha-seg"
            style={{ left: `${sc.win[0]}%`, width: `${sc.win[1] - sc.win[0]}%` }}
          >
            <span className="ha-seg-num">{i + 1}</span>
          </span>
        ))}
        <span className="ha-playhead" />
      </div>

      <ol className="ha-scenes" aria-label="Failover scenarios in the 50-second loop">
        {SCENES.map((sc, i) => (
          <li key={sc.key} className="ha-scene">
            <span className={`ha-scene-glow ${uid}-scene-${sc.key}`} aria-hidden="true" />
            <span className="ha-scene-num" aria-hidden="true">
              {i + 1}
            </span>
            <span className="ha-scene-title">{sc.title}</span>
            <span className="ha-scene-text">{sc.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default HaArchitectureViz;
