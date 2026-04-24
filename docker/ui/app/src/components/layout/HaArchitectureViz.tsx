import { useMemo } from 'react';

/**
 * HaArchitectureViz
 *
 * SVG-based animated diagram that visualises the Granite Keystone HA
 * call-routing architecture in a horizontal left-to-right flow:
 *
 *                                ┌─ [US-East:  2×SBC → Media] ──┐
 *  [Inbound] → [Geo Router] ────┼─ [US-Central: 2×SBC → Media] ─┼→ [Dallas]
 *    Trunk                      └─ [US-West:  2×SBC → Media] ──┤→ [LA]
 *                                                                └→ [Backup]
 *
 * A single inbound SIP trunk from Bandwidth delivers calls to the Network
 * Load Balancer (Geo Router), which selects one of three geographic locations
 * based on health and proximity. Each location has a redundant SBC pair and a
 * FreeSWITCH media server. All locations terminate via the same three Bandwidth
 * PoP trunks on the right.
 *
 * Animated "packet" dots ride CSS offset-path along each SVG path segment.
 * Multiple staggered copies of each dot keep the diagram feeling like live
 * traffic rather than a one-shot animation.
 *
 * Every ~20 s the US-West location dims and packets on its paths fade out —
 * illustrating automatic geographic failover with traffic redistributed to
 * US-East and US-Central.
 *
 * Pure SVG + CSS. No canvas, no WebGL, no extra npm packages.
 */

/* ─── Geometry constants ─────────────────────────────────────────────── */

const VB_W = 1000;
const VB_H = 290;

// ── Column x-positions ────────────────────────────────────────────────
const COL = {
  inbound: 72,    // Stage 1: single inbound trunk node (centre)
  nlb:     228,   // Stage 2: NLB / geo-router (centre)
  locIn:   340,   // left edge of location containers
  locOut:  650,   // right edge of location containers
  sbcX:    420,   // SBC pair node centre (within location)
  fsX:     568,   // FreeSWITCH node centre (within location)
  termX:   870,   // Stage 4: termination trunk nodes (centre)
} as const;

// ── Row y-centres for each geographic location ─────────────────────────
// VB_H=290, header at y=22, bottom margin ~10px.
// Usable: ~255px in [35, 290]. Three rows evenly: 35+28=63, 63+91=154…
// Chosen for visual balance with NLB centred at y=145:
const LOC_Y = [62, 145, 228] as const;   // US-East, US-Central, US-West
const LOC_HALF_H = 28;                    // half-height of each location container
const LOC_W = COL.locOut - COL.locIn;    // 310px

// ── Termination trunk y-positions ─────────────────────────────────────
const TERM_Y = [75, 145, 215] as const;  // Dallas, LA, Backup

/* ─── SVG path helpers ───────────────────────────────────────────────── */

function linePath(x1: number, y1: number, x2: number, y2: number): string {
  return `M ${x1} ${y1} L ${x2} ${y2}`;
}

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

/* ─── Path definitions ───────────────────────────────────────────────── */

/**
 * Path groups control which packets participate in the failover animation.
 * All 'west' groups fade when US-West fails over.
 */
type PathGroup =
  | 'inbound-nlb'
  | 'nlb-east' | 'nlb-central' | 'nlb-west'
  | 'sbc-fs-east' | 'sbc-fs-central' | 'sbc-fs-west'
  | 'east-term' | 'central-term' | 'west-term';

interface PathDef {
  id: string;
  d: string;
  group: PathGroup;
  isWest: boolean;
}

// ── Stage 1→2: Inbound → NLB ─────────────────────────────────────────
const PATH_INBOUND_NLB: PathDef = {
  id: 'in-nlb',
  group: 'inbound-nlb',
  isWest: false,
  d: linePath(COL.inbound + 18, 145, COL.nlb - 24, 145),
};

// ── Stage 2→3: NLB → each location ────────────────────────────────────
// Packets enter the left edge of the container (locIn + 8 to clear the border)
const PATH_NLB_EAST: PathDef = {
  id: 'nlb-east',
  group: 'nlb-east',
  isWest: false,
  d: quadPath(COL.nlb + 24, 145, 284, LOC_Y[0], COL.locIn + 8, LOC_Y[0]),
};
const PATH_NLB_CENTRAL: PathDef = {
  id: 'nlb-central',
  group: 'nlb-central',
  isWest: false,
  d: linePath(COL.nlb + 24, 145, COL.locIn + 8, LOC_Y[1]),
};
const PATH_NLB_WEST: PathDef = {
  id: 'nlb-west',
  group: 'nlb-west',
  isWest: true,
  d: quadPath(COL.nlb + 24, 145, 284, LOC_Y[2], COL.locIn + 8, LOC_Y[2]),
};

// ── Stage 3 internal: SBC → FS (within each location) ─────────────────
const PATH_SBC_FS_EAST: PathDef = {
  id: 'sbc-fs-east',
  group: 'sbc-fs-east',
  isWest: false,
  d: linePath(COL.sbcX + 26, LOC_Y[0], COL.fsX - 18, LOC_Y[0]),
};
const PATH_SBC_FS_CENTRAL: PathDef = {
  id: 'sbc-fs-central',
  group: 'sbc-fs-central',
  isWest: false,
  d: linePath(COL.sbcX + 26, LOC_Y[1], COL.fsX - 18, LOC_Y[1]),
};
const PATH_SBC_FS_WEST: PathDef = {
  id: 'sbc-fs-west',
  group: 'sbc-fs-west',
  isWest: true,
  d: linePath(COL.sbcX + 26, LOC_Y[2], COL.fsX - 18, LOC_Y[2]),
};

// ── Stage 3→4: each location → each termination trunk (9 paths) ────────
// Paths exit the right edge of each container and converge at the trunks.
function makeTermPath(
  locIdx: number,
  termIdx: number,
  group: PathGroup,
  id: string,
  isWest: boolean,
): PathDef {
  const x1 = COL.locOut - 8;
  const y1 = LOC_Y[locIdx];
  const x2 = COL.termX - 20;
  const y2 = TERM_Y[termIdx];
  // Cubic bezier produces smooth S-curves for the convergence fan
  const cp1X = x1 + (x2 - x1) * 0.40;
  const cp2X = x1 + (x2 - x1) * 0.60;
  return {
    id,
    group,
    isWest,
    d: cubicPath(x1, y1, cp1X, y1, cp2X, y2, x2, y2),
  };
}

const PATHS_EAST_TERM: PathDef[] = [
  makeTermPath(0, 0, 'east-term', 'e-t0', false),
  makeTermPath(0, 1, 'east-term', 'e-t1', false),
  makeTermPath(0, 2, 'east-term', 'e-t2', false),
];
const PATHS_CENTRAL_TERM: PathDef[] = [
  makeTermPath(1, 0, 'central-term', 'c-t0', false),
  makeTermPath(1, 1, 'central-term', 'c-t1', false),
  makeTermPath(1, 2, 'central-term', 'c-t2', false),
];
const PATHS_WEST_TERM: PathDef[] = [
  makeTermPath(2, 0, 'west-term', 'w-t0', true),
  makeTermPath(2, 1, 'west-term', 'w-t1', true),
  makeTermPath(2, 2, 'west-term', 'w-t2', true),
];

const PATHS: PathDef[] = [
  PATH_INBOUND_NLB,
  PATH_NLB_EAST,
  PATH_NLB_CENTRAL,
  PATH_NLB_WEST,
  PATH_SBC_FS_EAST,
  PATH_SBC_FS_CENTRAL,
  PATH_SBC_FS_WEST,
  ...PATHS_EAST_TERM,
  ...PATHS_CENTRAL_TERM,
  ...PATHS_WEST_TERM,
];

/* ─── Packet animation config ────────────────────────────────────────── */

interface PacketConfig {
  pathId: string;
  delay: number;
  duration: number;
  /** Packet belongs to the US-West failover group — fades on failover */
  isWest: boolean;
  /** Termination-leg packet — rendered with a green tint */
  isTerm: boolean;
}

function makePackets(
  pathId: string,
  count: number,
  duration: number,
  isWest: boolean,
  isTerm = false,
  startDelay = 0,
): PacketConfig[] {
  return Array.from({ length: count }, (_, i) => ({
    pathId,
    delay: startDelay + (duration / count) * i,
    duration,
    isWest,
    isTerm,
  }));
}

const ALL_PACKETS: PacketConfig[] = [
  // Inbound → NLB
  ...makePackets('in-nlb',       3, 2.6, false, false, 0.0),

  // NLB → locations (geo-router splits traffic staggered so it looks dynamic)
  ...makePackets('nlb-east',     2, 3.4, false, false, 0.0),
  ...makePackets('nlb-central',  2, 3.4, false, false, 1.1),
  ...makePackets('nlb-west',     2, 3.4, true,  false, 2.2),

  // SBC → FS (within each location)
  ...makePackets('sbc-fs-east',    2, 1.9, false, false, 0.2),
  ...makePackets('sbc-fs-central', 2, 1.9, false, false, 1.3),
  ...makePackets('sbc-fs-west',    2, 1.9, true,  false, 2.4),

  // East → termination trunks
  ...makePackets('e-t0', 1, 3.8, false, true, 0.0),
  ...makePackets('e-t1', 1, 3.8, false, true, 0.5),
  ...makePackets('e-t2', 1, 3.8, false, true, 1.0),

  // Central → termination trunks
  ...makePackets('c-t0', 1, 3.8, false, true, 1.3),
  ...makePackets('c-t1', 1, 3.8, false, true, 1.8),
  ...makePackets('c-t2', 1, 3.8, false, true, 2.3),

  // West → termination trunks (failover group)
  ...makePackets('w-t0', 1, 3.8, true, true, 0.7),
  ...makePackets('w-t1', 1, 3.8, true, true, 1.2),
  ...makePackets('w-t2', 1, 3.8, true, true, 1.7),
];

/* ─── Component ──────────────────────────────────────────────────────── */

export function HaArchitectureViz() {
  // Stable, unique ID prefix for CSS names — prevents class collisions if the
  // component is ever mounted more than once in the same document.
  const uid = useMemo(
    () => `ha-${Math.random().toString(36).substring(2, 8)}`,
    [],
  );

  /**
   * Build the full CSS block:
   *  1. Per-path @keyframes (offset-distance 0%→100%)
   *  2. Per-packet animation rules (class → path + timing)
   *  3. US-West failover keyframes: location dims to amber, packets fade
   */
  const css = useMemo(() => {
    // 1. Path traversal keyframes — one per unique path id
    const pathKf = PATHS.map(
      (p) => `@keyframes ${uid}-pkt-${p.id} {
  0%   { offset-distance:   0%; opacity: 0; }
  8%   { opacity: 1; }
  88%  { opacity: 1; }
  100% { offset-distance: 100%; opacity: 0; }
}`,
    ).join('\n');

    // 2. Per-packet CSS class rules
    const packetRules = ALL_PACKETS.map((pkt, i) => {
      const path = PATHS.find((p) => p.id === pkt.pathId)!;

      // West packets carry a second animation layer for the failover fade
      const animName = pkt.isWest
        ? `${uid}-pkt-${path.id}, ${uid}-west-pkt-fault`
        : `${uid}-pkt-${path.id}`;
      const animDur  = pkt.isWest ? `${pkt.duration}s, 20s`           : `${pkt.duration}s`;
      const animDel  = pkt.isWest ? `${pkt.delay}s, 0s`               : `${pkt.delay}s`;
      const animIter = pkt.isWest ? 'infinite, infinite'               : 'infinite';
      const animFill = pkt.isWest ? 'both, both'                       : 'both';
      const animTf   = pkt.isWest
        ? 'cubic-bezier(0.4, 0, 0.6, 1), ease-in-out'
        : 'cubic-bezier(0.4, 0, 0.6, 1)';

      return `.${uid}-p${i} {
  offset-path: path('${path.d}');
  animation-name: ${animName};
  animation-duration: ${animDur};
  animation-delay: ${animDel};
  animation-timing-function: ${animTf};
  animation-iteration-count: ${animIter};
  animation-fill-mode: ${animFill};
}`;
    }).join('\n');

    // 3. Failover animations
    // US-West location box dims at 65% of the 20s cycle, recovers at 82%.
    const failoverKf = `
@keyframes ${uid}-west-loc-fault {
  0%,  62%  { opacity: 1;    filter: none; }
  66%        { opacity: 0.20; filter: sepia(1) hue-rotate(20deg) brightness(2.0); }
  79%        { opacity: 0.20; filter: sepia(1) hue-rotate(20deg) brightness(2.0); }
  85%, 100%  { opacity: 1;   filter: none; }
}
@keyframes ${uid}-west-pkt-fault {
  0%,  62%  { opacity: 1; }
  66%, 79%  { opacity: 0; }
  85%, 100% { opacity: 1; }
}`;

    const failoverRules = `.${uid}-west-loc {
  animation: ${uid}-west-loc-fault 20s ease-in-out infinite;
}`;

    return [pathKf, packetRules, failoverKf, failoverRules].join('\n');
  }, [uid]);

  return (
    <div
      style={{
        width: '100%',
        maxWidth: 1060,
        margin: '0 auto',
        marginTop: 40,
        marginBottom: 48,
        background: 'rgba(19, 21, 29, 0.70)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        border: '1px solid rgba(59,130,246,0.12)',
        borderRadius: 20,
        padding: '20px 24px 16px',
        boxShadow: '0 4px 24px -8px rgba(0,0,0,0.50)',
        overflow: 'hidden',
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
          marginBottom: 12,
          opacity: 0.75,
        }}
      >
        Live Infrastructure Topology
      </div>

      <style dangerouslySetInnerHTML={{ __html: css }} />

      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        width="100%"
        height="auto"
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block' }}
        aria-label="Granite Keystone HA: single inbound trunk routes through geo-router NLB to three geographic locations (each with 2× SBC + FreeSWITCH), terminating via Dallas, LA, and Backup Bandwidth PoP trunks"
      >
        <defs>
          {/* ── Grid lines ────────────────────────────────────────── */}
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

          {/* ── Node glow gradients ───────────────────────────────── */}
          {/* Standard blue ambient glow */}
          <radialGradient id={`${uid}-ng`} cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="#3b82f6" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
          </radialGradient>

          {/* NLB / key node brighter glow */}
          <radialGradient id={`${uid}-lg`} cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="#60a5fa" stopOpacity="0.32" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
          </radialGradient>

          {/* Termination trunk green glow */}
          <radialGradient id={`${uid}-tg`} cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="#34d399" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#059669" stopOpacity="0" />
          </radialGradient>

          {/* ── Packet dot fills ──────────────────────────────────── */}
          {/* Blue packet (inbound / processing legs) */}
          <radialGradient id={`${uid}-pg`} cx="40%" cy="35%" r="60%">
            <stop offset="0%"   stopColor="#bfdbfe" stopOpacity="1" />
            <stop offset="100%" stopColor="#3b82f6"  stopOpacity="0.75" />
          </radialGradient>

          {/* Green-tinted packet (termination legs) */}
          <radialGradient id={`${uid}-ptg`} cx="40%" cy="35%" r="60%">
            <stop offset="0%"   stopColor="#a7f3d0" stopOpacity="1" />
            <stop offset="100%" stopColor="#10b981"  stopOpacity="0.75" />
          </radialGradient>

          {/* ── Utility ───────────────────────────────────────────── */}
          <clipPath id={`${uid}-clip`}>
            <rect x="0" y="0" width={VB_W} height={VB_H} />
          </clipPath>

          {/* Packet glow (soft halo around each dot) */}
          <filter id={`${uid}-pf`} x="-140%" y="-140%" width="380%" height="380%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="1.6" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Node inner glow */}
          <filter id={`${uid}-nf`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>

          {/* Keystone logo image glow — blue halo for the image nodes */}
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

        {/* ── Grid background ─────────────────────────────────────── */}
        <rect x="0" y="0" width={VB_W} height={VB_H} fill={`url(#${uid}-grid)`} />

        {/* ── Central ambient glow ─────────────────────────────────── */}
        <ellipse
          cx={VB_W / 2} cy={VB_H / 2}
          rx={VB_W * 0.46} ry={VB_H * 0.58}
          fill="rgba(59,130,246,0.025)"
        />

        {/* ── Connection lines ─────────────────────────────────────── */}
        <g fill="none" clipPath={`url(#${uid}-clip)`}>
          {/* Stage 1→2 */}
          <path d={PATH_INBOUND_NLB.d} stroke="rgba(59,130,246,0.22)" strokeWidth="1.1" />

          {/* Stage 2→3 fan */}
          <path d={PATH_NLB_EAST.d}    stroke="rgba(59,130,246,0.18)" strokeWidth="1" />
          <path d={PATH_NLB_CENTRAL.d} stroke="rgba(59,130,246,0.18)" strokeWidth="1" />
          <path d={PATH_NLB_WEST.d}    stroke="rgba(59,130,246,0.18)" strokeWidth="1" />

          {/* Stage 3 internal SBC→FS (dashed to distinguish) */}
          <path d={PATH_SBC_FS_EAST.d}    stroke="rgba(59,130,246,0.16)" strokeWidth="0.8" strokeDasharray="3 2.5" />
          <path d={PATH_SBC_FS_CENTRAL.d} stroke="rgba(59,130,246,0.16)" strokeWidth="0.8" strokeDasharray="3 2.5" />
          <path d={PATH_SBC_FS_WEST.d}    stroke="rgba(59,130,246,0.16)" strokeWidth="0.8" strokeDasharray="3 2.5" />

          {/* Stage 3→4 convergence (green-tinted) */}
          {[...PATHS_EAST_TERM, ...PATHS_CENTRAL_TERM, ...PATHS_WEST_TERM].map((p) => (
            <path key={p.id} d={p.d} stroke="rgba(52,211,153,0.13)" strokeWidth="0.85" />
          ))}
        </g>

        {/* ── Animated packet dots ─────────────────────────────────── */}
        <g clipPath={`url(#${uid}-clip)`}>
          {ALL_PACKETS.map((pkt, i) => (
            <circle
              key={i}
              r={3}
              cx="0"
              cy="0"
              fill={pkt.isTerm ? `url(#${uid}-ptg)` : `url(#${uid}-pg)`}
              filter={`url(#${uid}-pf)`}
              className={`${uid}-p${i}`}
            />
          ))}
        </g>

        {/* ── Stage nodes ──────────────────────────────────────────── */}
        <InboundNode uid={uid} />
        <NlbNode uid={uid} />

        {/* Three geographic location containers */}
        <LocationGroup uid={uid} locIdx={0} label="US-East"    isWest={false} />
        <LocationGroup uid={uid} locIdx={1} label="US-Central" isWest={false} />
        <LocationGroup uid={uid} locIdx={2} label="US-West"    isWest={true} />

        {/* Three Bandwidth termination trunk nodes */}
        <TermNode uid={uid} termIdx={0} label="Dallas" sublabel="PoP" />
        <TermNode uid={uid} termIdx={1} label="LA"     sublabel="PoP" />
        <TermNode uid={uid} termIdx={2} label="Backup" sublabel="Trunk" />

        {/* ── Column header labels ──────────────────────────────────── */}
        <ColumnLabel text="ORIGINATION"  x={COL.inbound}                      y={22} />
        <ColumnLabel text="DISTRIBUTION" x={COL.nlb}                          y={22} />
        <ColumnLabel text="PROCESSING"   x={(COL.locIn + COL.locOut) / 2}     y={22} />
        <ColumnLabel text="TERMINATION"  x={COL.termX}                        y={22} />

        {/* ── Watermark ────────────────────────────────────────────── */}
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

/* ── Inbound Trunk — rounded rectangle with signal-bars icon ── */
function InboundNode({ uid }: { uid: string }) {
  const cx = COL.inbound;
  const cy = 145;
  const W = 62;
  const H = 40;
  const R = 8;

  return (
    <g transform={`translate(${cx}, ${cy})`}>
      <circle r="46" fill={`url(#${uid}-ng)`} />
      <rect
        x={-W / 2} y={-H / 2}
        width={W} height={H}
        rx={R}
        fill="rgba(15,17,23,0.72)"
        stroke="rgba(59,130,246,0.30)"
        strokeWidth="1"
      />
      {/* Top highlight strip */}
      <rect
        x={-W / 2 + 1} y={-H / 2 + 1}
        width={W - 2} height={H * 0.28}
        rx={R - 1}
        fill="rgba(96,165,250,0.07)"
      />
      {/* Signal-bars icon centred in the rect */}
      <BandwidthIcon />
      {/* Labels below */}
      <text y={H / 2 + 12} textAnchor="middle" fontSize="7.5"
        fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
        letterSpacing="0.09em" fill="rgba(148,163,184,0.62)" fontWeight="600">
        Inbound
      </text>
      <text y={H / 2 + 21} textAnchor="middle" fontSize="6"
        fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
        letterSpacing="0.07em" fill="rgba(100,116,139,0.55)" fontWeight="500">
        Trunk
      </text>
    </g>
  );
}

/* ── NLB / Geo Router — diamond ── */
function NlbNode({ uid }: { uid: string }) {
  const cx = COL.nlb;
  const cy = 145;
  const s = 24; // half-diagonal of diamond

  return (
    <g transform={`translate(${cx}, ${cy})`}>
      <circle r="54" fill={`url(#${uid}-lg)`} />
      {/* Outer diamond */}
      <polygon
        points={`0,${-s} ${s},0 0,${s} ${-s},0`}
        fill="rgba(15,17,23,0.72)"
        stroke="rgba(59,130,246,0.34)"
        strokeWidth="1"
      />
      {/* Inner diamond accent */}
      <polygon
        points={`0,${-s * 0.42} ${s * 0.42},0 0,${s * 0.42} ${-s * 0.42},0`}
        fill="rgba(59,130,246,0.15)"
        stroke="rgba(96,165,250,0.28)"
        strokeWidth="0.75"
      />
      {/* Distribution cross */}
      <line x1="-9" y1="0" x2="9"  y2="0" stroke="rgba(96,165,250,0.40)" strokeWidth="0.9" />
      <line x1="0" y1="-9" x2="0" y2="9"  stroke="rgba(96,165,250,0.40)" strokeWidth="0.9" />
      {/* Labels */}
      <text y={s + 13} textAnchor="middle" fontSize="7.5"
        fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
        letterSpacing="0.09em" fill="rgba(148,163,184,0.62)" fontWeight="600">
        Geo Router
      </text>
      <text y={s + 22} textAnchor="middle" fontSize="6"
        fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
        letterSpacing="0.07em" fill="rgba(100,116,139,0.52)" fontWeight="500">
        NLB
      </text>
    </g>
  );
}

/* ── Geographic Location Container ── */
function LocationGroup({
  uid,
  locIdx,
  label,
  isWest,
}: {
  uid: string;
  locIdx: number;
  label: string;
  isWest: boolean;
}) {
  const cy = LOC_Y[locIdx];
  const x  = COL.locIn;
  const h  = LOC_HALF_H * 2;  // 56px total height
  const R  = 9;

  return (
    <g className={isWest ? `${uid}-west-loc` : undefined}>
      {/* Container background */}
      <rect
        x={x}
        y={cy - LOC_HALF_H}
        width={LOC_W}
        height={h}
        rx={R}
        fill="rgba(15,17,23,0.52)"
        stroke="rgba(59,130,246,0.20)"
        strokeWidth="0.75"
      />
      {/* Top shimmer */}
      <rect
        x={x + 1}
        y={cy - LOC_HALF_H + 1}
        width={LOC_W - 2}
        height={h * 0.24}
        rx={R - 1}
        fill="rgba(96,165,250,0.05)"
      />
      {/* Location name — top-left */}
      <text
        x={x + 10}
        y={cy - LOC_HALF_H + 12}
        fontSize="6.5"
        fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
        letterSpacing="0.10em"
        fill="rgba(148,163,184,0.48)"
        fontWeight="700"
      >
        {label}
      </text>

      {/* SBC pair node */}
      <SbcPairNode uid={uid} cx={COL.sbcX} cy={cy} />

      {/* FreeSWITCH media server node */}
      <FsNode uid={uid} cx={COL.fsX} cy={cy} />
    </g>
  );
}

/* ── SBC Pair — labelled pill ── */
function SbcPairNode({ uid, cx, cy }: { uid: string; cx: number; cy: number }) {
  // Sized to comfortably sit within the LOC_HALF_H=28 container
  const W = 54;
  const H = 30;
  const R = 7;

  return (
    <g transform={`translate(${cx}, ${cy})`}>
      <circle r="34" fill={`url(#${uid}-ng)`} />
      <rect
        x={-W / 2} y={-H / 2}
        width={W} height={H}
        rx={R}
        fill="rgba(15,17,23,0.74)"
        stroke="rgba(59,130,246,0.28)"
        strokeWidth="0.85"
      />
      {/* Top highlight */}
      <rect
        x={-W / 2 + 1} y={-H / 2 + 1}
        width={W - 2} height={H * 0.30}
        rx={R - 1}
        fill="rgba(96,165,250,0.07)"
      />
      {/* Layer lines */}
      <line x1="-14" y1="-5" x2="14" y2="-5" stroke="rgba(59,130,246,0.28)" strokeWidth="0.7" />
      <line x1="-10" y1=" 0" x2="10" y2=" 0" stroke="rgba(59,130,246,0.18)" strokeWidth="0.7" />
      <line x1="-6"  y1=" 5" x2="6"  y2=" 5" stroke="rgba(59,130,246,0.11)" strokeWidth="0.7" />
      {/* Label inside pill */}
      <text y={H / 2 + 10} textAnchor="middle" fontSize="6.5"
        fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
        letterSpacing="0.07em" fill="rgba(148,163,184,0.55)" fontWeight="600">
        2× SBC
      </text>
    </g>
  );
}

/* ── Keystone Media Engine — logo image node ── */
function FsNode({ uid, cx, cy }: { uid: string; cx: number; cy: number }) {
  // 30px image, centered; ambient glow radius matches neighbour SBC node
  const S = 30; // image width & height in SVG units

  return (
    <g transform={`translate(${cx}, ${cy})`}>
      {/* Ambient blue glow halo behind the image */}
      <circle r="30" fill={`url(#${uid}-ng)`} />
      {/* Keystone logo — transparent PNG, blue glow filter applied */}
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
}: {
  uid: string;
  termIdx: number;
  label: string;
  sublabel: string;
}) {
  const cx = COL.termX;
  const cy = TERM_Y[termIdx];
  const W  = 58;
  const H  = 32;
  const R  = 8;

  return (
    <g transform={`translate(${cx}, ${cy})`}>
      <circle r="40" fill={`url(#${uid}-tg)`} />
      <rect
        x={-W / 2} y={-H / 2}
        width={W} height={H}
        rx={R}
        fill="rgba(15,17,23,0.72)"
        stroke="rgba(52,211,153,0.28)"
        strokeWidth="0.9"
      />
      {/* Top highlight */}
      <rect
        x={-W / 2 + 1} y={-H / 2 + 1}
        width={W - 2} height={H * 0.28}
        rx={R - 1}
        fill="rgba(52,211,153,0.06)"
      />
      {/* Active status dot */}
      <circle r="3"   cx="0" cy="0" fill="rgba(52,211,153,0.40)" />
      <circle r="1.5" cx="0" cy="0" fill="rgba(167,243,208,0.92)" />
      {/* Labels */}
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

/* ─── Signal bars / bandwidth icon ───────────────────────────────────── */

function BandwidthIcon() {
  return (
    <g transform="translate(-8, -9)" opacity="0.54">
      {/* Three ascending bars */}
      <rect x="0.5" y="9"  width="4" height="5"  rx="1" fill="rgba(96,165,250,0.58)" />
      <rect x="6"   y="6"  width="4" height="8"  rx="1" fill="rgba(96,165,250,0.58)" />
      <rect x="11.5" y="3" width="4" height="11" rx="1" fill="rgba(96,165,250,0.58)" />
    </g>
  );
}

export default HaArchitectureViz;
