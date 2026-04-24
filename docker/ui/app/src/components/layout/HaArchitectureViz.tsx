import { useMemo } from 'react';

/**
 * HaArchitectureViz
 *
 * SVG-based animated diagram that visualises the Granite Keystone HA
 * call-routing architecture in a horizontal left-to-right flow:
 *
 *   [Phone 1] ─┐
 *   [Phone 2] ─┤→  [NLB]  →  [SBC-1] ─┐                      ┌→ [US-East]
 *   [Phone 3] ─┘              [SBC-2] ─┤→  [Route Engine]  ─┤→ [US-Central]
 *                                        └                    └→ [US-West]
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

const VB_W = 1000;
const VB_H = 280;

// Node centre coordinates — horizontal left-to-right flow
const NODES = {
  caller0: { x: 72,  y: 62  },
  caller1: { x: 72,  y: 117 },
  caller2: { x: 72,  y: 172 },
  lb:      { x: 248, y: 117 },
  sbc1:    { x: 440, y: 72  },
  sbc2:    { x: 440, y: 195 },
  re:      { x: 630, y: 117 },
  zoneE:   { x: 850, y: 55  },
  zoneC:   { x: 850, y: 117 },
  zoneW:   { x: 850, y: 179 },
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
  { id: 'c0-lb',   group: 'caller-lb', d: quadPath(NODES.caller0.x + 13, NODES.caller0.y, 165, 72,  NODES.lb.x - 23, NODES.lb.y) },
  { id: 'c1-lb',   group: 'caller-lb', d: linePath(NODES.caller1.x + 13, NODES.caller1.y, NODES.lb.x - 23, NODES.lb.y) },
  { id: 'c2-lb',   group: 'caller-lb', d: quadPath(NODES.caller2.x + 13, NODES.caller2.y, 165, 162, NODES.lb.x - 23, NODES.lb.y) },
  // LB → SBCs
  { id: 'lb-sbc1', group: 'lb-sbc1',   d: quadPath(NODES.lb.x + 23, NODES.lb.y, 345, 72,  NODES.sbc1.x - 28, NODES.sbc1.y) },
  { id: 'lb-sbc2', group: 'lb-sbc2',   d: quadPath(NODES.lb.x + 23, NODES.lb.y, 345, 195, NODES.sbc2.x - 28, NODES.sbc2.y) },
  // SBCs → Routing Engine
  { id: 'sbc1-re', group: 'sbc1-re',   d: quadPath(NODES.sbc1.x + 28, NODES.sbc1.y, 535, 72,  NODES.re.x - 27, NODES.re.y) },
  { id: 'sbc2-re', group: 'sbc2-re',   d: quadPath(NODES.sbc2.x + 28, NODES.sbc2.y, 535, 195, NODES.re.x - 27, NODES.re.y) },
  // RE → Zones
  { id: 're-zE',   group: 'zone',      d: quadPath(NODES.re.x + 27, NODES.re.y, 740, 55,  NODES.zoneE.x - 15, NODES.zoneE.y) },
  { id: 're-zC',   group: 'zone',      d: linePath(NODES.re.x + 27, NODES.re.y, NODES.zoneC.x - 15, NODES.zoneC.y) },
  { id: 're-zW',   group: 'zone',      d: quadPath(NODES.re.x + 27, NODES.re.y, 740, 179, NODES.zoneW.x - 15, NODES.zoneW.y) },
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
  ...makePackets('c0-lb',   2, 3.2, false, 0.0),
  ...makePackets('c1-lb',   2, 3.2, false, 1.0),
  ...makePackets('c2-lb',   2, 3.2, false, 2.0),
  // LB → SBC1
  ...makePackets('lb-sbc1', 3, 2.8, false, 0.0),
  // LB → SBC2 (dims during failover)
  ...makePackets('lb-sbc2', 3, 2.8, true,  0.5),
  // SBC1 → RE
  ...makePackets('sbc1-re', 2, 2.4, false, 0.3),
  // SBC2 → RE (dims during failover)
  ...makePackets('sbc2-re', 2, 2.4, true,  0.8),
  // RE → Zones
  ...makePackets('re-zE',   2, 2.6, false, 0.0),
  ...makePackets('re-zC',   2, 2.6, false, 0.9),
  ...makePackets('re-zW',   2, 2.6, false, 1.8),
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
        aria-label="HA architecture diagram showing left-to-right call flow"
      >
        <defs>
          {/* Repeating grid lines */}
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

          {/* Node ambient glow */}
          <radialGradient id={`${uid}-ng`} cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="#3b82f6" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
          </radialGradient>

          {/* LB / RE stronger glow */}
          <radialGradient id={`${uid}-lg`} cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="#60a5fa" stopOpacity="0.30" />
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
            <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="b" />
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

        {/* ── Soft radial glow centred on the middle ───────────── */}
        <ellipse
          cx={VB_W / 2} cy={VB_H / 2}
          rx={VB_W * 0.48} ry={VB_H * 0.60}
          fill="rgba(59,130,246,0.03)"
        />

        {/* ── Connection lines ─────────────────────────────────────── */}
        <g stroke="rgba(59,130,246,0.15)" strokeWidth="1" fill="none" clipPath={`url(#${uid}-clip)`}>
          {PATHS.map((p) => <path key={p.id} d={p.d} />)}
        </g>

        {/* ── Animated packets ─────────────────────────────────────── */}
        <g clipPath={`url(#${uid}-clip)`}>
          {ALL_PACKETS.map((_, i) => (
            <circle
              key={i}
              r={3.5}
              cx="0"
              cy="0"
              fill={`url(#${uid}-pg)`}
              filter={`url(#${uid}-pf)`}
              className={`${uid}-p${i}`}
            />
          ))}
        </g>

        {/* ── Nodes ────────────────────────────────────────────────── */}
        <CallerColumn uid={uid} />
        <LbNode uid={uid} />
        <SbcGroup uid={uid} />
        <ReNode uid={uid} />
        <ZoneColumn uid={uid} />

        {/* ── Column header labels ──────────────────────────────────── */}
        <ColumnLabel text="INBOUND CALLS" x={NODES.caller1.x} y={22} />
        <ColumnLabel text="LOAD BALANCER" x={NODES.lb.x}      y={22} />
        <ColumnLabel text="SESSION BORDER" x={NODES.sbc1.x}    y={22} />
        <ColumnLabel text="ROUTING ENGINE" x={NODES.re.x}      y={22} />
        <ColumnLabel text="ZONES"           x={NODES.zoneC.x}  y={22} />

        {/* ── Watermark ────────────────────────────────────────────── */}
        <text
          x={VB_W - 8} y={VB_H - 6}
          textAnchor="end"
          fontSize="6"
          fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
          letterSpacing="0.12em"
          fill="rgba(59,130,246,0.20)"
          fontWeight="600"
        >
          LIVE INFRASTRUCTURE
        </text>
      </svg>
    </div>
  );
}

/* ─── Node sub-components ────────────────────────────────────────────── */

function ColumnLabel({ text, x, y }: { text: string; x: number; y: number }) {
  return (
    <text
      x={x} y={y}
      textAnchor="middle"
      fontSize="7"
      fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
      letterSpacing="0.13em"
      fill="rgba(148,163,184,0.30)"
      fontWeight="600"
    >
      {text}
    </text>
  );
}

function NodeLabel({ text, y }: { text: string; y: number }) {
  return (
    <text
      y={y}
      textAnchor="middle"
      fontSize="7.5"
      fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
      letterSpacing="0.09em"
      fill="rgba(148,163,184,0.55)"
      fontWeight="600"
    >
      {text}
    </text>
  );
}

/* ── Caller nodes (left column, stacked vertically) ── */
function CallerColumn({ uid }: { uid: string }) {
  const callers = [NODES.caller0, NODES.caller1, NODES.caller2] as const;

  return (
    <g>
      {callers.map((c, i) => (
        <g key={i} transform={`translate(${c.x}, ${c.y})`}>
          {/* Ambient glow disc */}
          <circle r="22" fill={`url(#${uid}-ng)`} />
          {/* Node circle */}
          <circle
            r="13"
            fill="rgba(15,17,23,0.65)"
            stroke="rgba(59,130,246,0.24)"
            strokeWidth="1"
          />
          {/* Phone icon */}
          <PhoneIcon />
        </g>
      ))}
    </g>
  );
}

/* ── Load Balancer — diamond shape ── */
function LbNode({ uid }: { uid: string }) {
  const { x, y } = NODES.lb;
  const s = 22; // half-diagonal of the diamond

  return (
    <g transform={`translate(${x}, ${y})`}>
      {/* Glow */}
      <circle r="46" fill={`url(#${uid}-lg)`} />
      {/* Outer diamond */}
      <polygon
        points={`0,${-s} ${s},0 0,${s} ${-s},0`}
        fill="rgba(15,17,23,0.68)"
        stroke="rgba(59,130,246,0.30)"
        strokeWidth="1"
      />
      {/* Inner diamond accent */}
      <polygon
        points={`0,${-s * 0.46} ${s * 0.46},0 0,${s * 0.46} ${-s * 0.46},0`}
        fill="rgba(59,130,246,0.15)"
        stroke="rgba(96,165,250,0.30)"
        strokeWidth="0.75"
      />
      {/* Four-way distribution marker */}
      <line x1="-8" y1="0" x2="8"  y2="0"  stroke="rgba(96,165,250,0.40)" strokeWidth="0.8" />
      <line x1="0"  y1="-8" x2="0" y2="8"  stroke="rgba(96,165,250,0.40)" strokeWidth="0.8" />
      <NodeLabel text="NLB" y={s + 13} />
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
  const H = 30;
  const R = 7;

  return (
    <g
      transform={`translate(${x}, ${y})`}
      className={faults ? `${uid}-sbc2-node` : undefined}
    >
      {/* Glow */}
      <circle r="40" fill={`url(#${uid}-ng)`} />
      {/* Body */}
      <rect
        x={-W / 2} y={-H / 2}
        width={W} height={H}
        rx={R}
        fill="rgba(15,17,23,0.70)"
        stroke="rgba(59,130,246,0.26)"
        strokeWidth="1"
      />
      {/* Inner highlight */}
      <rect
        x={-W / 2 + 1} y={-H / 2 + 1}
        width={W - 2} height={H * 0.35}
        rx={R - 1}
        fill="rgba(96,165,250,0.05)"
      />
      {/* Layer lines */}
      <line x1="-14" y1="-5" x2="14" y2="-5" stroke="rgba(59,130,246,0.28)" strokeWidth="0.7" />
      <line x1="-10" y1="0"  x2="10" y2="0"  stroke="rgba(59,130,246,0.18)" strokeWidth="0.7" />
      <line x1="-6"  y1="5"  x2="6"  y2="5"  stroke="rgba(59,130,246,0.12)" strokeWidth="0.7" />
      <NodeLabel text={label} y={H / 2 + 12} />
    </g>
  );
}

/* ── Routing Engine — hexagon ── */
function ReNode({ uid }: { uid: string }) {
  const { x, y } = NODES.re;
  const R = 26;

  // Flat-top hexagon points
  const hexPoints = (radius: number) =>
    Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 3) * i - Math.PI / 6;
      return `${(radius * Math.cos(a)).toFixed(2)},${(radius * Math.sin(a)).toFixed(2)}`;
    }).join(' ');

  return (
    <g transform={`translate(${x}, ${y})`}>
      {/* Glow */}
      <circle r="50" fill={`url(#${uid}-lg)`} />
      {/* Outer hexagon */}
      <polygon
        points={hexPoints(R)}
        fill="rgba(15,17,23,0.72)"
        stroke="rgba(59,130,246,0.28)"
        strokeWidth="1"
      />
      {/* Inner hexagon */}
      <polygon
        points={hexPoints(R * 0.52)}
        fill="rgba(59,130,246,0.13)"
        stroke="rgba(96,165,250,0.26)"
        strokeWidth="0.75"
      />
      {/* Cross-hatch */}
      <line x1="-18" y1="0"  x2="18" y2="0"  stroke="rgba(59,130,246,0.22)" strokeWidth="0.75" />
      <line x1="0"   y1="-18" x2="0" y2="18" stroke="rgba(59,130,246,0.22)" strokeWidth="0.75" />
      <line x1="-12" y1="-12" x2="12" y2="12" stroke="rgba(59,130,246,0.10)" strokeWidth="0.6" />
      <line x1="12"  y1="-12" x2="-12" y2="12" stroke="rgba(59,130,246,0.10)" strokeWidth="0.6" />
      <NodeLabel text="ROUTE" y={R + 12} />
    </g>
  );
}

/* ── Zone nodes (right column, stacked vertically) ── */
function ZoneColumn({ uid }: { uid: string }) {
  const zones = [
    { ...NODES.zoneE, label: 'US-E' },
    { ...NODES.zoneC, label: 'US-C' },
    { ...NODES.zoneW, label: 'US-W' },
  ] as const;

  return (
    <g>
      {zones.map((z, i) => (
        <g key={i} transform={`translate(${z.x}, ${z.y})`}>
          {/* Glow */}
          <circle r="28" fill={`url(#${uid}-ng)`} />
          {/* Node */}
          <circle
            r="15"
            fill="rgba(15,17,23,0.65)"
            stroke="rgba(59,130,246,0.22)"
            strokeWidth="1"
          />
          {/* Status dot — indicates active zone */}
          <circle r="4"   fill="rgba(59,130,246,0.55)" />
          <circle r="2"   fill="rgba(147,197,253,0.90)" />
          <NodeLabel text={z.label} y={24} />
        </g>
      ))}
    </g>
  );
}

/* ─── Phone icon ─────────────────────────────────────────────────────── */

function PhoneIcon() {
  return (
    <g transform="translate(-6, -6)" opacity="0.55">
      <rect
        x="1" y="1"
        width="10" height="10"
        rx="2"
        fill="none"
        stroke="rgba(96,165,250,0.55)"
        strokeWidth="0.85"
      />
      <line x1="3.5" y1="3.5" x2="8.5" y2="3.5" stroke="rgba(96,165,250,0.45)" strokeWidth="0.7" strokeLinecap="round" />
      <line x1="3.5" y1="5.5" x2="8.5" y2="5.5" stroke="rgba(96,165,250,0.30)" strokeWidth="0.7" strokeLinecap="round" />
      <circle cx="6" cy="8.5" r="1" fill="rgba(96,165,250,0.40)" />
    </g>
  );
}

export default HaArchitectureViz;
