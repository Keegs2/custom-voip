import { useCallback } from 'react';
import type { LadderMessage, LadderNode } from './sipLadderTypes';
import { formatTimeDelta, LADDER_COLORS } from './sipLadderUtils';

// ─── Arrow rendering ────────────────────────────────────────────────────────
//
// Arrows are rendered as CSS horizontal lines spanning the cells between source
// and destination columns. The arrowhead is a CSS triangle at the destination end.
//
// For right-pointing arrows (sourceCol < destCol):
//   Source cell gets the line start, destination cell gets the arrowhead pointing right.
//
// For left-pointing arrows (sourceCol > destCol):
//   Source cell gets the line start, destination cell gets the arrowhead pointing left.
//
// The label text is positioned on the arrow line using absolute positioning.
// ─────────────────────────────────────────────────────────────────────────────

/** Width of the timestamp column. Sized for the WIDEST stamp the gutter can
 *  render — a causality-corrected absolute time like `~14:23:45.123` (13 mono
 *  chars at 0.7rem ≈ 88px) plus cell padding — so the nowrap stamp never
 *  overflows into the first node column at laptop widths. */
const TIMESTAMP_COL_WIDTH = 112;

// ─── Arrowhead SVG component ────────────────────────────────────────────────

function ArrowHead({ direction, color }: { direction: 'right' | 'left'; color: string }) {
  if (direction === 'right') {
    return (
      <svg
        width={8}
        height={10}
        viewBox="0 0 8 10"
        style={{ display: 'block', flexShrink: 0 }}
      >
        <polygon points="0,0 8,5 0,10" fill={color} />
      </svg>
    );
  }
  return (
    <svg
      width={8}
      height={10}
      viewBox="0 0 8 10"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <polygon points="8,0 0,5 8,10" fill={color} />
    </svg>
  );
}

// ─── Cell styles ────────────────────────────────────────────────────────────

const timestampCellStyle: React.CSSProperties = {
  width: TIMESTAMP_COL_WIDTH,
  minWidth: TIMESTAMP_COL_WIDTH,
  maxWidth: TIMESTAMP_COL_WIDTH,
  padding: '6px 8px 6px 12px',
  fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
  fontSize: '0.7rem',
  color: LADDER_COLORS.textFaint,
  whiteSpace: 'nowrap',
  verticalAlign: 'middle',
  textAlign: 'right',
  boxSizing: 'border-box',
};

const nodeCellStyle: React.CSSProperties = {
  padding: 0,
  verticalAlign: 'middle',
  position: 'relative',
  height: 32,
  boxSizing: 'border-box',
};

// ─── Component ──────────────────────────────────────────────────────────────

interface SipMessageRowProps {
  message: LadderMessage;
  nodes: ReadonlyArray<LadderNode>;
  isExpanded: boolean;
  onToggleExpand: (messageId: string) => void;
  /** Whether retransmissions are hidden — if true, this row should not render */
  hideRetransmissions: boolean;
  /** Whether 100 Trying is hidden */
  hide100Trying: boolean;
  /** Whether SBC internal hops (hairpins) are hidden — hidden by default */
  hideHairpins: boolean;
}

export function SipMessageRow({
  message,
  nodes,
  isExpanded,
  onToggleExpand,
  hideRetransmissions,
  hide100Trying,
  hideHairpins,
}: SipMessageRowProps) {
  // ALL hooks unconditionally at the top (React rules of hooks)
  const handleClick = useCallback(() => {
    onToggleExpand(message.id);
  }, [message.id, onToggleExpand]);

  // Early returns AFTER all hooks.
  // The "SBC internal hops" filter hides ONLY the src==dst hairpin self-loops.
  // The synthetic VIP↔SBC loopback connector always renders — it's the continuity
  // aid that makes the call path read end-to-end, so it must survive the clean view.
  if (hideRetransmissions && message.isRetransmission) return null;
  if (hide100Trying && message.original.status === 100) return null;
  if (hideHairpins && message.isHairpin) return null;

  const {
    sourceCol,
    destCol,
    color,
    label,
    isRetransmission: isRetrans,
    isHairpin,
    internalHandoff,
    tsCorrected,
    direction,
    timeDeltaMs,
    directionInferred,
  } = message;
  const numCols = nodes.length;

  // Determine the column range the arrow spans
  const minCol = Math.min(sourceCol, destCol);
  const maxCol = Math.max(sourceCol, destCol);

  // Build the timestamp display. Causally-corrected rows (and negative deltas,
  // which only appear around corrected rows) get a tilde so engineers know the
  // displayed position is derived, not the raw capture timestamp.
  let timestampDisplay: string;
  if (timeDeltaMs === null) {
    // First message — show absolute time
    try {
      const d = new Date(message.original.timestamp);
      const h = d.getHours().toString().padStart(2, '0');
      const m = d.getMinutes().toString().padStart(2, '0');
      const s = d.getSeconds().toString().padStart(2, '0');
      // Extract fractional seconds from the ISO string for precision
      const fracMatch = message.original.timestamp.match(/\.(\d+)/);
      const frac = fracMatch ? fracMatch[1].substring(0, 3) : '000';
      timestampDisplay = `${h}:${m}:${s}.${frac}`;
    } catch {
      timestampDisplay = '';
    }
  } else if (timeDeltaMs < 0) {
    timestampDisplay = `~${formatTimeDelta(timeDeltaMs)}`;
  } else {
    timestampDisplay = `+${formatTimeDelta(timeDeltaMs)}`;
  }
  if (tsCorrected && !timestampDisplay.startsWith('~')) {
    timestampDisplay = `~${timestampDisplay}`;
  }

  // Row opacity. Retransmissions dim to 0.55 — a deliberate sub-AA ghost
  // treatment for duplicate wire noise (the full-contrast original renders
  // adjacent, and the filter can hide retransmissions outright). The synthetic
  // loopback connector is a deliberate "show-off" affordance, so it stays
  // clearly legible (0.9) — a touch below a real captured hop, but never a
  // barely-there hairline.
  const rowOpacity = isRetrans ? 0.55 : internalHandoff ? 0.9 : 1;

  // Row hover background
  const rowBg = isExpanded ? 'rgba(47,125,246,0.07)' : 'transparent';

  // The connector is not a captured packet — no packet panel to open. Explain it
  // on hover rather than inviting a click.
  const rowTitle = internalHandoff
    ? 'Internal loopback — the VIP and this SBC are the same Kamailio process (NLB is pass-through). No wire packet crosses this boundary.'
    : message.original.raw_msg
      ? 'Click to view packet details'
      : undefined;

  return (
    <tr
      onClick={handleClick}
      style={{
        cursor: message.original.raw_msg ? 'pointer' : 'default',
        opacity: rowOpacity,
        background: rowBg,
        transition: 'background 0.12s',
      }}
      onMouseEnter={(e) => {
        if (!isExpanded) {
          e.currentTarget.style.background = LADDER_COLORS.surfaceHover;
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = isExpanded ? 'rgba(47,125,246,0.07)' : 'transparent';
      }}
      title={rowTitle}
    >
      {/* Timestamp cell */}
      <td
        style={timestampCellStyle}
        title={tsCorrected ? 'Timestamp corrected for SIP causality' : undefined}
      >
        {timestampDisplay}
      </td>

      {/* Node columns */}
      {Array.from({ length: numCols }, (_, colIdx) => {
        const isSource = colIdx === sourceCol;
        const isDest = colIdx === destCol;
        const isInArrowPath = colIdx > minCol && colIdx < maxCol;
        const isSelfMessage = sourceCol === destCol;

        return (
          <td
            key={colIdx}
            style={{
              ...nodeCellStyle,
              // Show the vertical column line through each cell
              borderLeft: colIdx === 0 ? 'none' : undefined,
            }}
          >
            {/* Vertical column line (always visible) */}
            <div
              style={{
                position: 'absolute',
                left: '50%',
                top: 0,
                bottom: 0,
                width: 1,
                background: LADDER_COLORS.columnLine,
                zIndex: 0,
              }}
            />

            {/* Self-loop glyph: hairpin / SBC internal hop (same source and dest).
                A small U-turn loop on the column instead of a spanning arrow. */}
            {isSelfMessage && isSource && (
              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: '50%',
                  transform: 'translate(-50%, -50%)',
                  zIndex: 2,
                  display: 'flex',
                  opacity: isHairpin ? 0.75 : 1,
                }}
                title={
                  isHairpin
                    ? `${label} — SBC internal hop (re-traversal through own VIP)`
                    : label
                }
              >
                <svg width={18} height={16} viewBox="0 0 18 16" style={{ display: 'block' }}>
                  {/* loop: out of the column line, around, and back */}
                  <path
                    d="M 5 13 V 6 A 4.5 4.5 0 0 1 14 6 V 10"
                    fill="none"
                    stroke={color}
                    strokeWidth={1.6}
                  />
                  {/* arrowhead pointing back down at the column */}
                  <polygon points="11,10 17,10 14,15" fill={color} />
                  {/* origin dot on the column line */}
                  <circle cx={5} cy={13} r={2} fill={color} />
                </svg>
              </div>
            )}

            {/* Arrow line rendering */}
            {!isSelfMessage && (isSource || isDest || isInArrowPath) && (
              <div
                style={{
                  position: 'absolute',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  // Line extends from center of cell to edge (or full width for middle cells)
                  left: isSource
                    ? direction === 'right'
                      ? '50%' // Start from center, extend right
                      : 0     // Start from left edge, extend to center
                    : isDest
                      ? direction === 'right'
                        ? 0     // Start from left edge, extend to center
                        : '50%' // Start from center, extend right
                      : 0,     // Middle cell: full width
                  right: isSource
                    ? direction === 'right'
                      ? 0     // Extend to right edge
                      : '50%' // Extend to center
                    : isDest
                      ? direction === 'right'
                        ? '50%' // Extend to center
                        : 0     // Extend to right edge
                      : 0,     // Middle cell: full width
                  // The loopback connector is a hair thinner than a real 2px hop but
                  // still clearly readable — an obvious, intentional same-box bridge,
                  // not a captured packet.
                  height: internalHandoff ? 1.5 : 2,
                  // Solid for wire-confirmed direction; dashed when the direction
                  // was inferred from SIP semantics (collapsed HEP src/dst) OR when
                  // this is the synthetic same-box loopback connector. The loopback
                  // uses a longer dash cadence + a soft glow so it reads as a
                  // deliberate connector while staying visually distinct from a real
                  // fine-dashed "inferred" hop.
                  ...(directionInferred
                    ? {
                        background: 'none',
                        backgroundImage: internalHandoff
                          ? `repeating-linear-gradient(90deg, ${color} 0px, ${color} 7px, transparent 7px, transparent 12px)`
                          : `repeating-linear-gradient(90deg, ${color} 0px, ${color} 5px, transparent 5px, transparent 9px)`,
                        ...(internalHandoff
                          ? { filter: `drop-shadow(0 0 3px ${color})` }
                          : {}),
                      }
                    : { background: color }),
                  zIndex: 1,
                }}
              />
            )}

            {/* Source dot */}
            {!isSelfMessage && isSource && (
              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: '50%',
                  transform: 'translate(-50%, -50%)',
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: color,
                  zIndex: 2,
                }}
              />
            )}

            {/* Destination arrowhead */}
            {!isSelfMessage && isDest && (
              <div
                style={{
                  position: 'absolute',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  zIndex: 2,
                  ...(direction === 'right'
                    ? { left: 'calc(50% - 8px)' }
                    : { left: '50%' }),
                }}
              >
                <ArrowHead direction={direction} color={color} />
              </div>
            )}

            {/* Arrow label (centered on the arrow span) */}
            {!isSelfMessage && colIdx === Math.floor((sourceCol + destCol) / 2) && (
              <div
                style={{
                  position: 'absolute',
                  top: '50%',
                  left: '50%',
                  transform: 'translate(-50%, -120%)',
                  whiteSpace: 'nowrap',
                  fontSize: '0.68rem',
                  fontWeight: 600,
                  fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
                  color,
                  zIndex: 3,
                  pointerEvents: 'none',
                  textShadow: `0 0 8px ${LADDER_COLORS.bg}, 0 0 4px ${LADDER_COLORS.bg}, 0 1px 3px ${LADDER_COLORS.bg}`,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  // The connector's label is italic + non-mono so it reads as an
                  // annotation rather than a SIP method/status like a real hop.
                  ...(internalHandoff
                    ? { fontStyle: 'italic', fontWeight: 500, fontFamily: 'inherit' }
                    : {}),
                }}
              >
                {internalHandoff && (
                  <span aria-hidden style={{ fontStyle: 'normal', fontSize: '0.8rem', lineHeight: 1 }}>
                    ⟳
                  </span>
                )}
                {label}
                {isRetrans && (
                  <span
                    style={{
                      fontSize: '0.6rem',
                      fontWeight: 500,
                      color: LADDER_COLORS.textFaint,
                      fontStyle: 'italic',
                    }}
                  >
                    retrans
                  </span>
                )}
                {/* Same-box loopback chip — mutually exclusive with the plain
                    "inferred" chip so the connector is never double-tagged. */}
                {internalHandoff ? (
                  <span
                    title="Internal loopback — the VIP and this SBC are the same Kamailio process (NLB is pass-through). No wire packet crosses this boundary."
                    style={{
                      fontSize: '0.58rem',
                      fontWeight: 600,
                      color: LADDER_COLORS.internalHandoff,
                      fontStyle: 'italic',
                      border: `1px dashed ${LADDER_COLORS.internalHandoff}`,
                      borderRadius: 3,
                      padding: '0 3px',
                      letterSpacing: '0.02em',
                    }}
                  >
                    internal (same box)
                  </span>
                ) : (
                  directionInferred && (
                    <span
                      title="Direction inferred from SIP headers (wire src/dst aliased to one node)"
                      style={{
                        fontSize: '0.58rem',
                        fontWeight: 600,
                        color: LADDER_COLORS.textFaint,
                        fontStyle: 'italic',
                        border: `1px solid ${LADDER_COLORS.controlBorder}`,
                        borderRadius: 3,
                        padding: '0 3px',
                        letterSpacing: '0.02em',
                      }}
                    >
                      inferred
                    </span>
                  )
                )}
              </div>
            )}

            {/* For self-messages, show label above the loop glyph */}
            {isSelfMessage && isSource && (
              <div
                style={{
                  position: 'absolute',
                  top: '50%',
                  left: '50%',
                  transform: 'translate(-50%, -150%)',
                  whiteSpace: 'nowrap',
                  fontSize: '0.68rem',
                  fontWeight: 600,
                  fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
                  color,
                  zIndex: 3,
                  pointerEvents: 'none',
                  textShadow: `0 0 8px ${LADDER_COLORS.bg}, 0 0 4px ${LADDER_COLORS.bg}`,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                {label}
                {isHairpin && (
                  <span
                    style={{
                      fontSize: '0.58rem',
                      fontWeight: 600,
                      color: LADDER_COLORS.textFaint,
                      fontStyle: 'italic',
                      border: `1px solid ${LADDER_COLORS.controlBorder}`,
                      borderRadius: 3,
                      padding: '0 3px',
                      letterSpacing: '0.02em',
                    }}
                  >
                    internal hop
                  </span>
                )}
              </div>
            )}
          </td>
        );
      })}
    </tr>
  );
}

export { TIMESTAMP_COL_WIDTH };
