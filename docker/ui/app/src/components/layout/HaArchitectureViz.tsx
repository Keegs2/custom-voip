import { useMemo } from 'react';

/**
 * HaArchitectureViz
 *
 * SVG-based animated diagram that visualises the Granite Keystone HA
 * call-routing architecture:
 *
 *   Inbound callers  →  Network Load Balancer
 *                           ↙          ↘
 *                       SBC-1          SBC-2   (Kamailio session border)
 *                           ↘          ↙
 *                         Routing Engine       (call processing + fraud)
 *                        ↙     ↓       ↘
 *                    US-East  US-Central  US-West   (GCP availability zones)
 *
 * Animated "packet" dots ride CSS offset-path along each SVG path segment.
 * Multiple staggered copies of each dot keep the diagram feeling like live
 * traffic rather than a one-shot animation.
 *
 * Every ~20 s the SBC-2 node dims briefly and the packets on its upstream/
 * downstream paths fade out — illustrating automatic failover.
 *
 * Pure SVG + CSS. No canvas, no WebGL, no extra npm packages.
 */

/* ─── Geometry constants ─────────────────────────────────────────────── */

const VB_W = 800;
const VB_H = 580;

// Node centre coordinates (in SVG viewBox units)
const NODES = {
  caller0: { x: 170, y: 62 },
  caller1: { x: 300, y: 48 },
  caller2: { x: 500, y: 48 },
  caller3: { x: 630, y: 62 },
  lb:      { x: 400, y: 155 },
  sbc1:    { x: 265, y: 270 },
  sbc2:    { x: 535, y: 270 },
  re:      { x: 400, y: 385 },
  zoneE:   { x: 220, y: 498 },
  zoneC:   { x: 400, y: 498 },
  zoneW:   { x: 580, y: 498 },
} as const;

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

/* ─── Path definitions ───────────────────────────────────────────────── */

type PathGroup = 'caller-lb' | 'lb-sbc1' | 'lb-sbc2' | 'sbc1-re' | 'sbc2-re' | 'zone';

interface PathDef {
  id: string;
  d: string;
  group: PathGroup;
}

const PATHS: PathDef[] = [
  // Callers → LB
  { id: 'c0-lb',   group: 'caller-lb', d: linePath(NODES.caller0.x, NODES.caller0.y, NODES.lb.x, NODES.lb.y) },
  { id: 'c1-lb',   group: 'caller-lb', d: quadPath(NODES.caller1.x, NODES.caller1.y, 360, 100, NODES.lb.x, NODES.lb.y) },
  { id: 'c2-lb',   group: 'caller-lb', d: quadPath(NODES.caller2.x, NODES.caller2.y, 440, 100, NODES.lb.x, NODES.lb.y) },
  { id: 'c3-lb',   group: 'caller-lb', d: linePath(NODES.caller3.x, NODES.caller3.y, NODES.lb.x, NODES.lb.y) },
  // LB → SBCs
  { id: 'lb-sbc1', group: 'lb-sbc1',   d: quadPath(NODES.lb.x, NODES.lb.y, 320, 210, NODES.sbc1.x, NODES.sbc1.y) },
  { id: 'lb-sbc2', group: 'lb-sbc2',   d: quadPath(NODES.lb.x, NODES.lb.y, 480, 210, NODES.sbc2.x, NODES.sbc2.y) },
  // SBCs → Routing Engine
  { id: 'sbc1-re', group: 'sbc1-re',   d: quadPath(NODES.sbc1.x, NODES.sbc1.y, 310, 330, NODES.re.x, NODES.re.y) },
  { id: 'sbc2-re', group: 'sbc2-re',   d: quadPath(NODES.sbc2.x, NODES.sbc2.y, 490, 330, NODES.re.x, NODES.re.y) },
  // RE → Zones
  { id: 're-zE',   group: 'zone',      d: quadPath(NODES.re.x, NODES.re.y, 290, 445, NODES.zoneE.x, NODES.zoneE.y) },
  { id: 're-zC',   group: 'zone',      d: linePath(NODES.re.x, NODES.re.y, NODES.zoneC.x, NODES.zoneC.y) },
  { id: 're-zW',   group: 'zone',      d: quadPath(NODES.re.x, NODES.re.y, 510, 445, NODES.zoneW.x, NODES.zoneW.y) },
];

/* ─── Packet animation config ────────────────────────────────────────── */

interface PacketConfig {
  pathId: string;
  delay: number;
  duration: number;
  /** Whether this packet belongs to the SBC-2 failover group */
  isSbc2Path: boolean;
}

function makePackets(
  pathId: string,
  count: number,
  duration: number,
  isSbc2Path: boolean,
  startDelay = 0,
): PacketConfig[] {
  return Array.from({ length: count }, (_, i) => ({
    pathId,
    delay: startDelay + (duration / count) * i,
    duration,
    isSbc2Path,
  }));
}

const ALL_PACKETS: PacketConfig[] = [
  // Callers → LB
  ...makePackets('c0-lb',   2, 3.8, false, 0.0),
  ...makePackets('c1-lb',   2, 3.8, false, 0.9),
  ...makePackets('c2-lb',   2, 3.8, false, 1.8),
  ...makePackets('c3-lb',   2, 3.8, false, 2.7),
  // LB → SBC1
  ...makePackets('lb-sbc1', 3, 3.2, false, 0.0),
  // LB → SBC2 (dims during failover)
  ...makePackets('lb-sbc2', 3, 3.2, true,  0.6),
  // SBC1 → RE
  ...makePackets('sbc1-re', 2, 2.8, false, 0.3),
  // SBC2 → RE (dims during failover)
  ...makePackets('sbc2-re', 2, 2.8, true,  0.9),
  // RE → Zones
  ...makePackets('re-zE',   2, 3.0, false, 0.0),
  ...makePackets('re-zC',   2, 3.0, false, 1.0),
  ...makePackets('re-zW',   2, 3.0, false, 2.0),
];

/* ─── Component ──────────────────────────────────────────────────────── */

export function HaArchitectureViz() {
  // Stable, unique ID prefix for CSS names (avoids class collisions)
  const uid = useMemo(
    () => `ha-${Math.random().toString(36).substring(2, 8)}`,
    [],
  );

  /**
   * Build the full CSS block:
   *  1. Per-path @keyframes using offset-distance 0%→100%
   *  2. Per-packet animation rules (class → path + timing)
   *  3. Failover keyframes: SBC-2 node dims to amber, its packets fade
   */
  const css = useMemo(() => {
    // 1. Path traversal keyframes (one per path, shared by all packets on it)
    const pathKf = PATHS.map(
      (p) => `@keyframes ${uid}-pkt-${p.id} {
  0%   { offset-distance:   0%; opacity: 0; }
  7%   { opacity: 1; }
  88%  { opacity: 1; }
  100% { offset-distance: 100%; opacity: 0; }
}`,
    ).join('\n');

    // 2. Per-packet CSS class rules
    const packetRules = ALL_PACKETS.map((pkt, i) => {
      const path = PATHS.find((p) => p.id === pkt.pathId)!;
      // sbc2 packets carry a second animation for the failover fade
      const animName = pkt.isSbc2Path
        ? `${uid}-pkt-${path.id}, ${uid}-sbc2-pkt-fault`
        : `${uid}-pkt-${path.id}`;
      const animDur = pkt.isSbc2Path
        ? `${pkt.duration}s, 20s`
        : `${pkt.duration}s`;
      const animDelay = pkt.isSbc2Path
        ? `${pkt.delay}s, 0s`
        : `${pkt.delay}s`;
      const animIter = pkt.isSbc2Path
        ? 'infinite, infinite'
        : 'infinite';
      const animFill = pkt.isSbc2Path
        ? 'both, both'
        : 'both';

      return `.${uid}-p${i} {
  offset-path: path('${path.d}');
  animation-name: ${animName};
  animation-duration: ${animDur};
  animation-delay: ${animDelay};
  animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1), ease-in-out;
  animation-iteration-count: ${animIter};
  animation-fill-mode: ${animFill};
}`;
    }).join('\n');

    // 3. Failover animations
    // SBC-2 node: dims at 65%, recovers at 80% of the 20s cycle
    // SBC-2 packet: fully disappears during the same window
    const failoverKf = `
@keyframes ${uid}-sbc2-node-fault {
  0%,  62%  { opacity: 1;    filter: none; }
  66%        { opacity: 0.28; filter: sepia(1) hue-rotate(20deg) brightness(1.6); }
  76%        { opacity: 0.28; filter: sepia(1) hue-rotate(20deg) brightness(1.6); }
  82%, 100%  { opacity: 1;   filter: none; }
}
@keyframes ${uid}-sbc2-pkt-fault {
  0%,  62%  { opacity: 1; }
  66%, 76%  { opacity: 0; }
  82%, 100% { opacity: 1; }
}`;

    const failoverRules = `.${uid}-sbc2-node {
  animation: ${uid}-sbc2-node-fault 20s ease-in-out infinite;
}`;

    return [pathKf, packetRules, failoverKf, failoverRules].join('\n');
  }, [uid]);

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 620,
        pointerEvents: 'none',
        zIndex: 0,
        opacity: 0.55,
        overflow: 'hidden',
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: css }} />

      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMin meet"
        style={{ display: 'block' }}
      >
        <defs>
          {/* Repeating grid lines — matches AnimatedGridBackground's aesthetic */}
          <pattern
            id={`${uid}-grid`}
            width="56"
            height="56"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M 56 0 L 0 0 0 56"
              fill="none"
              stroke="rgba(99,130,180,0.07)"
              strokeWidth="1"
            />
          </pattern>

          {/* Node ambient glow */}
          <radialGradient id={`${uid}-ng`} cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="#3b82f6" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
          </radialGradient>

          {/* LB / RE stronger glow */}
          <radialGradient id={`${uid}-lg`} cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="#60a5fa" stopOpacity="0.32" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
          </radialGradient>

          {/* Packet dot fill */}
          <radialGradient id={`${uid}-pg`} cx="40%" cy="35%" r="60%">
            <stop offset="0%"   stopColor="#bfdbfe" stopOpacity="1" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0.7" />
          </radialGradient>

          {/* Clip packets to viewBox */}
          <clipPath id={`${uid}-clip`}>
            <rect x="0" y="0" width={VB_W} height={VB_H} />
          </clipPath>

          {/* Packet glow filter */}
          <filter id={`${uid}-pf`} x="-120%" y="-120%" width="340%" height="340%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="2.2" result="b" />
            <feMerge>
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
        </defs>

        {/* ── Grid background ─────────────────────────────────────── */}
        <rect x="0" y="0" width={VB_W} height={VB_H} fill={`url(#${uid}-grid)`} />

        {/* ── Soft blue radial glow centred on the upper portion ──── */}
        <ellipse
          cx={VB_W / 2} cy={VB_H * 0.28}
          rx={VB_W * 0.50} ry={VB_H * 0.38}
          fill="rgba(59,130,246,0.04)"
        />

        {/* ── Connection lines ─────────────────────────────────────── */}
        <g stroke="rgba(59,130,246,0.13)" strokeWidth="1" fill="none" clipPath={`url(#${uid}-clip)`}>
          {PATHS.map((p) => <path key={p.id} d={p.d} />)}
        </g>

        {/* ── Animated packets ─────────────────────────────────────── */}
        <g clipPath={`url(#${uid}-clip)`}>
          {ALL_PACKETS.map((_, i) => (
            <circle
              key={i}
              r={3.8}
              cx="0"
              cy="0"
              fill={`url(#${uid}-pg)`}
              filter={`url(#${uid}-pf)`}
              className={`${uid}-p${i}`}
            />
          ))}
        </g>

        {/* ── Nodes (drawn on top of lines and packets) ────────────── */}
        <CallerRow uid={uid} />
        <LbNode uid={uid} />
        <SbcGroup uid={uid} />
        <ReNode uid={uid} />
        <ZoneRow uid={uid} />

        {/* ── Watermark ────────────────────────────────────────────── */}
        <text
          x={VB_W - 10} y={VB_H - 8}
          textAnchor="end"
          fontSize="6.5"
          fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
          letterSpacing="0.13em"
          fill="rgba(59,130,246,0.22)"
          fontWeight="600"
        >
          LIVE INFRASTRUCTURE
        </text>
      </svg>
    </div>
  );
}

/* ─── Node sub-components ────────────────────────────────────────────── */

function Label({
  text, y, anchor = 'middle', opacity = 0.38,
}: {
  text: string;
  y: number;
  anchor?: 'middle' | 'start' | 'end';
  opacity?: number;
}) {
  return (
    <text
      y={y}
      textAnchor={anchor}
      fontSize="8"
      fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
      letterSpacing="0.10em"
      fill={`rgba(148,163,184,${opacity})`}
      fontWeight="600"
    >
      {text}
    </text>
  );
}

/* ── Caller nodes (top row) ── */
function CallerRow({ uid }: { uid: string }) {
  const callers = [NODES.caller0, NODES.caller1, NODES.caller2, NODES.caller3] as const;

  return (
    <g>
      {/* Row section label */}
      <text
        x={VB_W / 2} y={15}
        textAnchor="middle"
        fontSize="7.5"
        fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
        letterSpacing="0.14em"
        fill="rgba(148,163,184,0.28)"
        fontWeight="600"
      >
        INBOUND CALLS
      </text>

      {callers.map((c, i) => (
        <g key={i} transform={`translate(${c.x}, ${c.y})`}>
          {/* Ambient glow disc */}
          <circle r="26" fill={`url(#${uid}-ng)`} />
          {/* Node circle */}
          <circle
            r="13"
            fill="rgba(15,17,23,0.60)"
            stroke="rgba(59,130,246,0.22)"
            strokeWidth="1"
          />
          {/* Handset icon — drawn in local coords centred at 0,0 */}
          <PhoneIcon />
        </g>
      ))}
    </g>
  );
}

/* ── Load Balancer — diamond shape ── */
function LbNode({ uid }: { uid: string }) {
  const { x, y } = NODES.lb;
  const s = 23; // half-diagonal of the diamond

  return (
    <g transform={`translate(${x}, ${y})`}>
      {/* Glow */}
      <circle r="50" fill={`url(#${uid}-lg)`} />
      {/* Outer diamond */}
      <polygon
        points={`0,${-s} ${s},0 0,${s} ${-s},0`}
        fill="rgba(15,17,23,0.65)"
        stroke="rgba(59,130,246,0.28)"
        strokeWidth="1"
      />
      {/* Inner diamond accent */}
      <polygon
        points={`0,${-s * 0.46} ${s * 0.46},0 0,${s * 0.46} ${-s * 0.46},0`}
        fill="rgba(59,130,246,0.16)"
        stroke="rgba(96,165,250,0.32)"
        strokeWidth="0.75"
      />
      {/* Four-way distribution marker */}
      <line x1="-9" y1="0" x2="9"  y2="0"  stroke="rgba(96,165,250,0.40)" strokeWidth="0.8" />
      <line x1="0"  y1="-9" x2="0" y2="9"  stroke="rgba(96,165,250,0.40)" strokeWidth="0.8" />
      <Label text="LOAD BALANCER" y={s + 14} />
    </g>
  );
}

/* ── SBC pair ── */
function SbcGroup({ uid }: { uid: string }) {
  return (
    <g>
      <SbcNode uid={uid} label="SBC — 1" x={NODES.sbc1.x} y={NODES.sbc1.y} faults={false} />
      <SbcNode uid={uid} label="SBC — 2" x={NODES.sbc2.x} y={NODES.sbc2.y} faults={true}  />
    </g>
  );
}

function SbcNode({
  uid, label, x, y, faults,
}: {
  uid: string;
  label: string;
  x: number;
  y: number;
  faults: boolean;
}) {
  const W = 56;
  const H = 32;
  const R = 7;

  return (
    <g
      transform={`translate(${x}, ${y})`}
      className={faults ? `${uid}-sbc2-node` : undefined}
    >
      {/* Glow */}
      <circle r="44" fill={`url(#${uid}-ng)`} />
      {/* Body */}
      <rect
        x={-W / 2} y={-H / 2}
        width={W} height={H}
        rx={R}
        fill="rgba(15,17,23,0.68)"
        stroke="rgba(59,130,246,0.24)"
        strokeWidth="1"
      />
      {/* Inner highlight */}
      <rect
        x={-W / 2 + 1} y={-H / 2 + 1}
        width={W - 2} height={H * 0.35}
        rx={R - 1}
        fill="rgba(96,165,250,0.05)"
      />
      {/* Layer lines — suggests stacked proxy */}
      <line x1="-15" y1="-5" x2="15" y2="-5" stroke="rgba(59,130,246,0.28)" strokeWidth="0.7" />
      <line x1="-11" y1="0"  x2="11" y2="0"  stroke="rgba(59,130,246,0.18)" strokeWidth="0.7" />
      <line x1="-7"  y1="5"  x2="7"  y2="5"  stroke="rgba(59,130,246,0.12)" strokeWidth="0.7" />
      <Label text={label} y={H / 2 + 13} />
    </g>
  );
}

/* ── Routing Engine — hexagon ── */
function ReNode({ uid }: { uid: string }) {
  const { x, y } = NODES.re;
  const R = 27;

  // Flat-top hexagon points
  const hexPoints = (radius: number) =>
    Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 3) * i - Math.PI / 6;
      return `${(radius * Math.cos(a)).toFixed(2)},${(radius * Math.sin(a)).toFixed(2)}`;
    }).join(' ');

  return (
    <g transform={`translate(${x}, ${y})`}>
      {/* Glow */}
      <circle r="54" fill={`url(#${uid}-lg)`} />
      {/* Outer hexagon */}
      <polygon
        points={hexPoints(R)}
        fill="rgba(15,17,23,0.70)"
        stroke="rgba(59,130,246,0.26)"
        strokeWidth="1"
      />
      {/* Inner hexagon */}
      <polygon
        points={hexPoints(R * 0.54)}
        fill="rgba(59,130,246,0.13)"
        stroke="rgba(96,165,250,0.28)"
        strokeWidth="0.75"
      />
      {/* Cross-hatch — suggests computational grid */}
      <line x1="-19" y1="0"  x2="19" y2="0"  stroke="rgba(59,130,246,0.22)" strokeWidth="0.75" />
      <line x1="0"   y1="-19" x2="0" y2="19" stroke="rgba(59,130,246,0.22)" strokeWidth="0.75" />
      <line x1="-13" y1="-13" x2="13" y2="13" stroke="rgba(59,130,246,0.10)" strokeWidth="0.6" />
      <line x1="13"  y1="-13" x2="-13" y2="13" stroke="rgba(59,130,246,0.10)" strokeWidth="0.6" />
      <Label text="ROUTING ENGINE" y={R + 14} />
    </g>
  );
}

/* ── Zone nodes (bottom row) ── */
function ZoneRow({ uid }: { uid: string }) {
  const zones = [
    { ...NODES.zoneE, label: 'US-EAST' },
    { ...NODES.zoneC, label: 'US-CENTRAL' },
    { ...NODES.zoneW, label: 'US-WEST' },
  ] as const;

  return (
    <g>
      {/* Section label */}
      <text
        x={VB_W / 2} y={VB_H - 6}
        textAnchor="middle"
        fontSize="7"
        fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
        letterSpacing="0.14em"
        fill="rgba(148,163,184,0.22)"
        fontWeight="600"
      >
        AVAILABILITY ZONES
      </text>

      {zones.map((z, i) => (
        <g key={i} transform={`translate(${z.x}, ${z.y})`}>
          {/* Glow */}
          <circle r="30" fill={`url(#${uid}-ng)`} />
          {/* Node */}
          <circle
            r="15"
            fill="rgba(15,17,23,0.65)"
            stroke="rgba(59,130,246,0.20)"
            strokeWidth="1"
          />
          {/* Status dot — indicates active zone */}
          <circle r="4" fill="rgba(59,130,246,0.55)" />
          <circle r="2" fill="rgba(147,197,253,0.90)" />
          <Label text={z.label} y={26} />
        </g>
      ))}
    </g>
  );
}

/* ─── Phone icon ─────────────────────────────────────────────────────── */

/**
 * Simple phone handset drawn in a 12×12 local coordinate space,
 * centred at origin (translate -6,-6 applied via the group).
 */
function PhoneIcon() {
  return (
    <g transform="translate(-6, -6)" opacity="0.50">
      {/* Handset outline */}
      <rect
        x="1" y="1"
        width="10" height="10"
        rx="2"
        fill="none"
        stroke="rgba(96,165,250,0.55)"
        strokeWidth="0.85"
      />
      {/* Speaker grille lines */}
      <line x1="3.5" y1="3.5" x2="8.5" y2="3.5" stroke="rgba(96,165,250,0.45)" strokeWidth="0.7" strokeLinecap="round" />
      <line x1="3.5" y1="5.5" x2="8.5" y2="5.5" stroke="rgba(96,165,250,0.30)" strokeWidth="0.7" strokeLinecap="round" />
      {/* Mic dot */}
      <circle cx="6" cy="8.5" r="1" fill="rgba(96,165,250,0.40)" />
    </g>
  );
}

export default HaArchitectureViz;
