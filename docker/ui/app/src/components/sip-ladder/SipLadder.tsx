import { useState, useMemo, useCallback } from 'react';
import type { HomerSearchResult } from '../../api/homer';
import type { LadderLayout, LadderNode } from './sipLadderTypes';
import { computeLayout } from './sipLadderLayout';
import { LADDER_COLORS } from './sipLadderUtils';
import { SipMessageRow, TIMESTAMP_COL_WIDTH } from './SipMessageRow';
import { PacketDetailPanel } from './PacketDetailPanel';
import './sipLadder.css';

// ─── Design tokens ──────────────────────────────────────────────────────────
// ALL colors come from the LADDER_COLORS theme object (sipLadderUtils.ts) —
// never hard-code a hue here. These two constants are structural only.

/** Daylight card — white slab with a hairline border, mirroring `.dl-panel`. */
const CARD: React.CSSProperties = {
  background: LADDER_COLORS.bg,
  border: `1px solid ${LADDER_COLORS.border}`,
  borderRadius: 12,
  boxShadow: '0 1px 2px rgba(14,23,38,0.05)',
};

const MONO: React.CSSProperties = {
  fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
};

/**
 * Minimum width per node column. Combined with the fixed timestamp gutter this
 * sets the ladder table's min-width, so when the frame is narrower than the
 * diagram needs, the ladder PANS inside its own scroll region
 * (.sipladder-scroll) instead of crushing columns into unreadable slivers.
 */
const NODE_COL_MIN_WIDTH = 128;

// ─── Role display helpers ───────────────────────────────────────────────────

function getRoleLabel(role: string): string {
  switch (role) {
    case 'carrier-ingress': return 'carrier (in)';
    case 'carrier-egress': return 'carrier (out)';
    case 'sbc-vip': return 'load balancer';
    case 'sbc': return 'SBC';
    case 'media-server': return 'media server';
    default: return role;
  }
}

function getRoleColor(role: string): string {
  switch (role) {
    case 'carrier-ingress': return LADDER_COLORS.roleCarrier;
    case 'carrier-egress': return LADDER_COLORS.roleCarrier;
    case 'sbc-vip': return LADDER_COLORS.roleVip;
    case 'sbc': return LADDER_COLORS.roleSbc;
    case 'media-server': return LADDER_COLORS.roleMedia;
    default: return LADDER_COLORS.textFaint;
  }
}

// ─── Legend item ─────────────────────────────────────────────────────────────

interface LegendItemProps {
  color: string;
  label: string;
  dashed?: boolean;
}

function LegendItem({ color, label, dashed }: LegendItemProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div
        style={{
          width: 20,
          height: 2,
          background: color,
          borderRadius: 1,
          ...(dashed ? { backgroundImage: `repeating-linear-gradient(90deg, ${color} 0px, ${color} 4px, transparent 4px, transparent 8px)`, background: 'none' } : {}),
        }}
      />
      <span style={{ fontSize: '0.7rem', color: LADDER_COLORS.textMuted }}>{label}</span>
    </div>
  );
}

// ─── Filter button ──────────────────────────────────────────────────────────

interface FilterBtnProps {
  active: boolean;
  label: string;
  count?: number;
  onClick: () => void;
}

function FilterBtn({ active, label, count, onClick }: FilterBtnProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '5px 12px',
        borderRadius: 6,
        border: `1px solid ${active ? LADDER_COLORS.accentBorderStrong : LADDER_COLORS.controlBorder}`,
        background: active ? LADDER_COLORS.accentWash : LADDER_COLORS.bg,
        color: active ? LADDER_COLORS.accent : LADDER_COLORS.textMuted,
        fontSize: '0.72rem',
        fontWeight: active ? 600 : 500,
        cursor: 'pointer',
        transition: 'all 0.15s',
        whiteSpace: 'nowrap',
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.borderColor = LADDER_COLORS.controlBorderHover;
          e.currentTarget.style.background = LADDER_COLORS.surface;
          e.currentTarget.style.color = LADDER_COLORS.text;
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.borderColor = LADDER_COLORS.controlBorder;
          e.currentTarget.style.background = LADDER_COLORS.bg;
          e.currentTarget.style.color = LADDER_COLORS.textMuted;
        }
      }}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span
          style={{
            ...MONO,
            fontSize: '0.65rem',
            fontWeight: 600,
            padding: '1px 5px',
            borderRadius: 4,
            background: active ? LADDER_COLORS.accentChip : LADDER_COLORS.inkChip,
            color: active ? LADDER_COLORS.accent : LADDER_COLORS.textFaint,
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// ─── Column header ──────────────────────────────────────────────────────────

function ColumnHeader({ node }: { node: LadderNode }) {
  const roleColor = getRoleColor(node.role);
  const isUnrecognized = node.role === 'unknown';

  // Split SBC columns get distinct A-leg / B-leg sublabels so the two "SBC-1"
  // headers are never ambiguous. All other roles keep their standard sublabel
  // (CARRIER (IN) / CARRIER (OUT) / LOAD BALANCER / MEDIA SERVER / SBC).
  // Un-aliased nodes (role 'unknown' — the id is the bare IP) get a quiet
  // lowercase "unrecognized" note instead of a shouting uppercase UNKNOWN.
  const roleLabel =
    node.role === 'sbc' && node.legTag
      ? `SBC · ${node.legTag === 'a' ? 'A' : 'B'}-LEG`
      : isUnrecognized
        ? 'unrecognized'
        : getRoleLabel(node.role);

  return (
    <th
      style={{
        padding: '12px 8px 10px',
        textAlign: 'center',
        verticalAlign: 'top',
        position: 'sticky',
        top: 0,
        background: 'rgba(255,255,255,0.97)',
        zIndex: 10,
        borderBottom: `1px solid ${LADDER_COLORS.border}`,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          fontSize: '0.8rem',
          fontWeight: isUnrecognized ? 500 : 700,
          color: isUnrecognized ? LADDER_COLORS.textMuted : LADDER_COLORS.text,
          ...MONO,
          marginBottom: 2,
        }}
      >
        {node.displayLabel ?? node.id}
      </div>
      <div
        style={{
          fontSize: '0.62rem',
          fontWeight: 500,
          color: roleColor,
          letterSpacing: isUnrecognized ? '0.02em' : '0.04em',
          textTransform: isUnrecognized ? 'none' : 'uppercase',
          fontStyle: isUnrecognized ? 'italic' : 'normal',
          opacity: isUnrecognized ? 1 : 0.9,
        }}
      >
        {roleLabel}
      </div>
      {/* Column guide line */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: '50%',
          width: 1,
          height: 6,
          background: LADDER_COLORS.columnLine,
        }}
      />
    </th>
  );
}

// ─── A-leg / B-leg Call-ID chips (filter-bar residents) ─────────────────────
//
// The old CallSummary strip is gone (2026-09 declutter: it repeated the
// results row verbatim). The one thing it carried that lives nowhere else —
// the per-leg Call-IDs — now sits in the filter bar as compact mono chips.
// Click copies the leg's Call-ID(s); the title tooltip always shows them in
// full for environments where the clipboard API is unavailable.

interface LegChipProps {
  leg: 'a' | 'b';
  callIds: ReadonlyArray<string>;
}

function LegChip({ leg, callIds }: LegChipProps) {
  // ALL hooks at the top (rules of hooks — see CLAUDE.md §13)
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    const text = callIds.join(', ');
    // Clipboard API is available on our HTTPS/localhost targets; if not,
    // the title tooltip still exposes the full ids — fail silently.
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => {});
  }, [callIds]);

  if (callIds.length === 0) return null;

  const accent = leg === 'a' ? LADDER_COLORS.aLeg : LADDER_COLORS.bLeg;
  const wash = leg === 'a' ? 'rgba(29,99,221,0.08)' : 'rgba(180,83,9,0.08)';
  const edge = leg === 'a' ? 'rgba(29,99,221,0.22)' : 'rgba(180,83,9,0.24)';
  const idsText = callIds.join(', ');

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={`Click to copy\n${callIds.join('\n')}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        maxWidth: 220,
        padding: '3px 9px',
        borderRadius: 6,
        border: `1px solid ${edge}`,
        background: wash,
        cursor: 'copy',
        overflow: 'hidden',
      }}
    >
      <span
        style={{
          fontSize: '0.6rem',
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: accent,
          flexShrink: 0,
        }}
      >
        {leg === 'a' ? 'A-leg' : 'B-leg'}
      </span>
      <span
        style={{
          ...MONO,
          fontSize: '0.66rem',
          color: copied ? accent : LADDER_COLORS.textMuted,
          fontWeight: copied ? 700 : 400,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
        }}
      >
        {copied ? 'copied ✓' : idsText}
      </span>
    </button>
  );
}

// ─── Empty state ────────────────────────────────────────────────────────────

function EmptyLadder() {
  return (
    <div
      style={{
        ...CARD,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '64px 32px',
        gap: 12,
      }}
    >
      <svg
        width={40}
        height={40}
        viewBox="0 0 24 24"
        fill="none"
        stroke={LADDER_COLORS.textFaint}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ opacity: 0.5 }}
      >
        <path d="M5 12.55a11 11 0 0 1 14.08 0" />
        <path d="M1.42 9a16 16 0 0 1 21.16 0" />
        <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
        <circle cx={12} cy={20} r={1} fill={LADDER_COLORS.textFaint} stroke="none" />
      </svg>
      <p style={{ color: LADDER_COLORS.textFaint, fontSize: '0.85rem', textAlign: 'center' }}>
        No SIP messages to display
      </p>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

interface SipLadderProps {
  /** All SIP messages for the call (both legs, already deduped) */
  messages: HomerSearchResult[];
  /** Call-ID correlation map (Call-ID -> related Call-IDs) */
  correlations: Record<string, string[]>;
  /** Optional pipeline diagnostics from the API (timestamp corruption, etc.) */
  pipelineWarnings?: string[];
}

export function SipLadder({ messages, correlations, pipelineWarnings }: SipLadderProps) {
  // ── ALL hooks unconditionally at the top (React rules of hooks) ──
  const [expandedMessageId, setExpandedMessageId] = useState<string | null>(null);
  const [hide100Trying, setHide100Trying] = useState(false);
  const [hideRetransmissions, setHideRetransmissions] = useState(false);
  // SBC internal hops (hairpin VIP re-traversals) are noise for most
  // troubleshooting — hidden by default, toggleable like retransmissions.
  const [hideHairpins, setHideHairpins] = useState(true);

  // Compute layout from messages
  const layout: LadderLayout = useMemo(
    () => computeLayout(messages, correlations),
    [messages, correlations],
  );

  // Count retransmissions / 100 Trying / hairpins for filter badges
  const retransmissionCount = useMemo(
    () => layout.messages.filter((m) => m.isRetransmission).length,
    [layout.messages],
  );

  const tryingCount = useMemo(
    () => layout.messages.filter((m) => m.original.status === 100).length,
    [layout.messages],
  );

  // "SBC internal hops" hides ONLY the src==dst hairpins (BYE/ACK re-traversal
  // noise). The synthetic VIP↔SBC loopback connector is NOT hidden by it — it's a
  // continuity aid (the opposite of noise), so it always shows and the call path
  // reads end-to-end even in the clean/default view (hideHairpins defaults true).
  const hairpinCount = useMemo(
    () => layout.messages.filter((m) => m.isHairpin).length,
    [layout.messages],
  );

  const visibleCount = useMemo(() => {
    return layout.messages.filter((m) => {
      if (hideRetransmissions && m.isRetransmission) return false;
      if (hide100Trying && m.original.status === 100) return false;
      if (hideHairpins && m.isHairpin) return false;
      return true;
    }).length;
  }, [layout.messages, hideRetransmissions, hide100Trying, hideHairpins]);

  // Toggle message expansion
  const handleToggleExpand = useCallback((messageId: string) => {
    setExpandedMessageId((prev) => (prev === messageId ? null : messageId));
  }, []);

  // Filter toggles
  const handleToggle100 = useCallback(() => setHide100Trying((p) => !p), []);
  const handleToggleRetrans = useCallback(() => setHideRetransmissions((p) => !p), []);
  const handleToggleHairpins = useCallback(() => setHideHairpins((p) => !p), []);
  const handleShowAll = useCallback(() => {
    setHide100Trying(false);
    setHideRetransmissions(false);
    setHideHairpins(false);
  }, []);

  // ── Early returns AFTER all hooks ──
  if (messages.length === 0) {
    return <EmptyLadder />;
  }

  // Pipeline notes — the "N messages reordered for SIP causality" note is the
  // pipeline doing its job correctly and reads as clutter above every ladder
  // (2026-09 declutter) — dropped entirely. Any OTHER diagnostic (e.g.
  // ingest-stamp corruption notices) still renders as a quiet ⓘ chip.
  const visibleWarnings = (pipelineWarnings ?? []).filter(
    (w) => !/reordered for SIP causality/i.test(w),
  );

  return (
    <div>
      {visibleWarnings.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
            marginBottom: 10,
          }}
        >
          {visibleWarnings.map((warning, idx) => (
            <span
              key={idx}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 10px',
                borderRadius: 20,
                border: `1px solid ${LADDER_COLORS.border}`,
                background: LADDER_COLORS.surface,
                fontSize: '0.7rem',
                color: LADDER_COLORS.textFaint,
              }}
            >
              <svg
                width={12}
                height={12}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: 0 }}
                aria-hidden="true"
              >
                <circle cx={12} cy={12} r={10} />
                <line x1={12} y1={16} x2={12} y2={12} />
                <line x1={12} y1={8} x2={12.01} y2={8} />
              </svg>
              {warning}
            </span>
          ))}
        </div>
      )}

      {/* Filter bar + Legend (also hosts the A/B-leg Call-ID chips — the
          summary strip that used to sit here duplicated the results row and
          was removed in the 2026-09 declutter) */}
      <div
        style={{
          ...CARD,
          padding: '10px 16px',
          marginBottom: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 10,
        }}
      >
        {/* Filters — flexWrap so this row can NEVER dictate a minimum width
            wider than the card (it used to inflate the outer results table). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', rowGap: 6 }}>
          <span
            style={{
              fontSize: '0.68rem',
              fontWeight: 600,
              color: LADDER_COLORS.textFaint,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginRight: 4,
            }}
          >
            Filter
          </span>
          <FilterBtn
            active={hide100Trying}
            label={hide100Trying ? 'Show 100 Trying' : 'Hide 100 Trying'}
            count={tryingCount}
            onClick={handleToggle100}
          />
          <FilterBtn
            active={hideRetransmissions}
            label={hideRetransmissions ? 'Show Retransmissions' : 'Hide Retransmissions'}
            count={retransmissionCount}
            onClick={handleToggleRetrans}
          />
          <FilterBtn
            active={hideHairpins}
            label={hideHairpins ? 'Show SBC internal hops' : 'Hide SBC internal hops'}
            count={hairpinCount}
            onClick={handleToggleHairpins}
          />
          {(hide100Trying || hideRetransmissions || hideHairpins) && (
            <FilterBtn active={false} label="Show All" onClick={handleShowAll} />
          )}
          <span
            style={{
              ...MONO,
              fontSize: '0.68rem',
              color: LADDER_COLORS.textFaint,
              marginLeft: 8,
            }}
          >
            {visibleCount} / {layout.messages.length} shown
          </span>

          {/* Per-leg Call-ID chips — click to copy, hover for the full ids */}
          <LegChip leg="a" callIds={Array.from(layout.aLegCallIds)} />
          <LegChip leg="b" callIds={Array.from(layout.bLegCallIds)} />
        </div>

        {/* Color legend */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <LegendItem color={LADDER_COLORS.aLeg} label="INVITE (A-leg)" />
          <LegendItem color={LADDER_COLORS.bLeg} label="INVITE (B-leg)" />
          <LegendItem color={LADDER_COLORS.provisional} label="1xx" />
          <LegendItem color={LADDER_COLORS.success} label="2xx" />
          <LegendItem color={LADDER_COLORS.serverError} label="4xx/5xx" />
          <LegendItem color={LADDER_COLORS.ack} label="ACK" />
          <LegendItem color={LADDER_COLORS.bye} label="BYE" />
          <LegendItem color={LADDER_COLORS.internalHandoff} label="⟳ internal loopback" dashed />
        </div>
      </div>

      {/* Ladder diagram */}
      <div
        style={{
          ...CARD,
          overflow: 'hidden',
        }}
      >
        {/* The ONE horizontal scroll region for the ladder columns. The table
            carries a real min-width (timestamp gutter + a readable minimum per
            node column), so a narrow frame pans here — with a visible styled
            scrollbar (.sipladder-scroll) — instead of crushing the columns. */}
        <div
          className="sipladder-scroll"
          style={{
            overflowX: 'auto',
            overflowY: 'auto',
            maxHeight: 'calc(100vh - 340px)',
          }}
        >
          <table
            style={{
              borderCollapse: 'collapse',
              width: '100%',
              minWidth: TIMESTAMP_COL_WIDTH + layout.nodes.length * NODE_COL_MIN_WIDTH,
              tableLayout: 'fixed',
            }}
          >
            {/* Column definitions */}
            <colgroup>
              <col style={{ width: TIMESTAMP_COL_WIDTH }} />
              {layout.nodes.map((node) => (
                <col key={node.id} />
              ))}
            </colgroup>

            {/* Sticky column headers */}
            <thead>
              <tr>
                <th
                  style={{
                    width: TIMESTAMP_COL_WIDTH,
                    minWidth: TIMESTAMP_COL_WIDTH,
                    padding: '12px 8px 10px',
                    textAlign: 'right',
                    position: 'sticky',
                    top: 0,
                    background: 'rgba(255,255,255,0.97)',
                    zIndex: 10,
                    borderBottom: `1px solid ${LADDER_COLORS.border}`,
                    boxSizing: 'border-box',
                  }}
                >
                  <span
                    style={{
                      fontSize: '0.62rem',
                      fontWeight: 600,
                      color: LADDER_COLORS.textFaint,
                      letterSpacing: '0.05em',
                      textTransform: 'uppercase',
                    }}
                  >
                    Time
                  </span>
                </th>
                {layout.nodes.map((node) => (
                  <ColumnHeader key={node.id} node={node} />
                ))}
              </tr>
            </thead>

            {/* Message rows */}
            <tbody>
              {layout.messages.map((msg) => {
                const isExpanded = expandedMessageId === msg.id;

                return (
                  <MessageRowWithDetail
                    key={msg.id}
                    message={msg}
                    nodes={layout.nodes}
                    isExpanded={isExpanded}
                    onToggleExpand={handleToggleExpand}
                    hideRetransmissions={hideRetransmissions}
                    hide100Trying={hide100Trying}
                    hideHairpins={hideHairpins}
                    numCols={layout.nodes.length}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Wrapper that renders message row + optional detail panel ────────────────

interface MessageRowWithDetailProps {
  message: LadderLayout['messages'][number];
  nodes: ReadonlyArray<LadderNode>;
  isExpanded: boolean;
  onToggleExpand: (messageId: string) => void;
  hideRetransmissions: boolean;
  hide100Trying: boolean;
  hideHairpins: boolean;
  numCols: number;
}

function MessageRowWithDetail({
  message,
  nodes,
  isExpanded,
  onToggleExpand,
  hideRetransmissions,
  hide100Trying,
  hideHairpins,
  numCols,
}: MessageRowWithDetailProps) {
  // ALL hooks at the top
  const handleClose = useCallback(() => {
    onToggleExpand(message.id);
  }, [onToggleExpand, message.id]);

  // Check visibility (must match SipMessageRow logic). The "SBC internal hops"
  // filter hides ONLY hairpins; the loopback connector always shows (continuity aid).
  const isHidden =
    (hideRetransmissions && message.isRetransmission) ||
    (hide100Trying && message.original.status === 100) ||
    (hideHairpins && message.isHairpin);

  if (isHidden) return null;

  return (
    <>
      <SipMessageRow
        message={message}
        nodes={nodes}
        isExpanded={isExpanded}
        onToggleExpand={onToggleExpand}
        hideRetransmissions={hideRetransmissions}
        hide100Trying={hide100Trying}
        hideHairpins={hideHairpins}
      />
      {isExpanded && message.original.raw_msg && (
        <tr>
          <td
            colSpan={numCols + 1}
            style={{ padding: '0 12px 8px', background: LADDER_COLORS.accentWashSoft }}
          >
            <PacketDetailPanel
              rawMsg={message.original.raw_msg}
              accentColor={message.color}
              onClose={handleClose}
            />
          </td>
        </tr>
      )}
      {isExpanded && !message.original.raw_msg && (
        <tr>
          <td
            colSpan={numCols + 1}
            style={{
              padding: '14px 20px',
              background: LADDER_COLORS.accentWashSoft,
              textAlign: 'center',
            }}
          >
            <span
              style={{
                fontSize: '0.78rem',
                color: LADDER_COLORS.textFaint,
                fontStyle: 'italic',
              }}
            >
              {message.internalHandoff
                ? '⟳ Internal loopback — the VIP and this SBC are the same Kamailio process (the NLB is pass-through, the SBC carries the VIP on its own loopback). There is no wire packet to capture across this boundary; the connector only marks the same-box handoff.'
                : 'Raw SIP message not available for this packet'}
            </span>
          </td>
        </tr>
      )}
    </>
  );
}
