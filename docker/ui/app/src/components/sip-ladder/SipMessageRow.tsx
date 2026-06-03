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

/** Width of the timestamp column */
const TIMESTAMP_COL_WIDTH = 90;

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
  fontFamily: 'ui-monospace, monospace',
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
}

export function SipMessageRow({
  message,
  nodes,
  isExpanded,
  onToggleExpand,
  hideRetransmissions,
  hide100Trying,
}: SipMessageRowProps) {
  // ALL hooks unconditionally at the top (React rules of hooks)
  const handleClick = useCallback(() => {
    onToggleExpand(message.id);
  }, [message.id, onToggleExpand]);

  // Early returns AFTER all hooks
  if (hideRetransmissions && message.isRetransmission) return null;
  if (hide100Trying && message.original.status === 100) return null;

  const {
    sourceCol,
    destCol,
    color,
    label,
    isRetransmission: isRetrans,
    direction,
    timeDeltaMs,
    directionInferred,
  } = message;
  const numCols = nodes.length;

  // Determine the column range the arrow spans
  const minCol = Math.min(sourceCol, destCol);
  const maxCol = Math.max(sourceCol, destCol);

  // Build the timestamp display
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
  } else {
    timestampDisplay = `+${formatTimeDelta(timeDeltaMs)}`;
  }

  // Row opacity for retransmissions
  const rowOpacity = isRetrans ? 0.4 : 1;

  // Row hover background
  const rowBg = isExpanded ? 'rgba(59,130,246,0.06)' : 'transparent';

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
        e.currentTarget.style.background = isExpanded ? 'rgba(59,130,246,0.06)' : 'transparent';
      }}
      title={message.original.raw_msg ? 'Click to view packet details' : undefined}
    >
      {/* Timestamp cell */}
      <td style={timestampCellStyle}>{timestampDisplay}</td>

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

            {/* Self-message indicator (same source and dest) */}
            {isSelfMessage && isSource && (
              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: '50%',
                  transform: 'translate(-50%, -50%)',
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: color,
                  zIndex: 2,
                }}
                title={label}
              />
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
                  height: 2,
                  // Solid for wire-confirmed direction; dashed when the direction
                  // was inferred from SIP semantics (collapsed HEP src/dst).
                  ...(directionInferred
                    ? {
                        background: 'none',
                        backgroundImage: `repeating-linear-gradient(90deg, ${color} 0px, ${color} 5px, transparent 5px, transparent 9px)`,
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
                  fontFamily: 'ui-monospace, monospace',
                  color,
                  zIndex: 3,
                  pointerEvents: 'none',
                  textShadow: `0 0 8px ${LADDER_COLORS.bg}, 0 0 4px ${LADDER_COLORS.bg}, 0 1px 3px ${LADDER_COLORS.bg}`,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
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
                {directionInferred && (
                  <span
                    title="Direction inferred from SIP headers (wire src/dst aliased to one node)"
                    style={{
                      fontSize: '0.58rem',
                      fontWeight: 600,
                      color: LADDER_COLORS.textFaint,
                      fontStyle: 'italic',
                      border: `1px solid ${LADDER_COLORS.borderLight}`,
                      borderRadius: 3,
                      padding: '0 3px',
                      letterSpacing: '0.02em',
                    }}
                  >
                    inferred
                  </span>
                )}
              </div>
            )}

            {/* For self-messages, show label above the dot */}
            {isSelfMessage && isSource && (
              <div
                style={{
                  position: 'absolute',
                  top: '50%',
                  left: '50%',
                  transform: 'translate(-50%, -120%)',
                  whiteSpace: 'nowrap',
                  fontSize: '0.68rem',
                  fontWeight: 600,
                  fontFamily: 'ui-monospace, monospace',
                  color,
                  zIndex: 3,
                  pointerEvents: 'none',
                  textShadow: `0 0 8px ${LADDER_COLORS.bg}, 0 0 4px ${LADDER_COLORS.bg}`,
                }}
              >
                {label}
              </div>
            )}
          </td>
        );
      })}
    </tr>
  );
}

export { TIMESTAMP_COL_WIDTH };
