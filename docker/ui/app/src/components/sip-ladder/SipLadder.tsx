import { useState, useMemo, useCallback } from 'react';
import type { HomerSearchResult } from '../../api/homer';
import type { LadderLayout, LadderNode } from './sipLadderTypes';
import { computeLayout } from './sipLadderLayout';
import { LADDER_COLORS, formatTimeDelta } from './sipLadderUtils';
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

// ─── Format phone numbers for display ───────────────────────────────────────

function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `+1 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
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

// ─── Call summary header ────────────────────────────────────────────────────

interface CallSummaryProps {
  layout: LadderLayout;
}

function CallSummary({ layout }: CallSummaryProps) {
  const firstMsg = layout.messages[0]?.original;
  const lastMsg = layout.messages[layout.messages.length - 1]?.original;

  if (!firstMsg) return null;

  // Find the final response status (highest 2xx or highest final response)
  let finalStatus: number | null = null;
  for (const msg of layout.messages) {
    const s = msg.original.status;
    if (s !== null && s >= 200) {
      if (finalStatus === null || (s >= 200 && s < 300 && (finalStatus < 200 || finalStatus >= 300))) {
        finalStatus = s;
      } else if (finalStatus !== null && !(finalStatus >= 200 && finalStatus < 300) && s > finalStatus) {
        finalStatus = s;
      }
    }
  }

  const fromDisplay = formatPhone(firstMsg.from_user);
  const toDisplay = formatPhone(firstMsg.to_user);

  // Duration
  let durationDisplay = '--';
  if (layout.callDurationMs !== null) {
    durationDisplay = formatTimeDelta(layout.callDurationMs);
  }

  // Status badge tones — light-canvas washes of the semantic arrow hues
  // (mirrors the page's dlx5-status pills so both status reads match).
  let statusBg = 'rgba(93,111,140,0.08)';
  let statusColor: string = LADDER_COLORS.textMuted;
  let statusBorder = 'rgba(93,111,140,0.2)';
  if (finalStatus !== null) {
    if (finalStatus >= 200 && finalStatus < 300) {
      statusBg = 'rgba(22,163,74,0.1)';
      statusColor = LADDER_COLORS.success;
      statusBorder = 'rgba(22,163,74,0.26)';
    } else if (finalStatus >= 400 && finalStatus < 500) {
      statusBg = 'rgba(180,83,9,0.09)';
      statusColor = LADDER_COLORS.clientError;
      statusBorder = 'rgba(180,83,9,0.26)';
    } else if (finalStatus >= 500) {
      statusBg = 'rgba(220,38,38,0.07)';
      statusColor = LADDER_COLORS.serverError;
      statusBorder = 'rgba(220,38,38,0.26)';
    }
  }

  return (
    <div
      style={{
        ...CARD,
        padding: '16px 20px',
        marginBottom: 12,
      }}
    >
      {/* Top row: from/to, duration, status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
        {/* From → To */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: '0.7rem', fontWeight: 600, color: LADDER_COLORS.textFaint, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            From
          </span>
          <span style={{ ...MONO, fontSize: '0.82rem', fontWeight: 600, color: LADDER_COLORS.text }}>
            {fromDisplay}
          </span>
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke={LADDER_COLORS.textFaint} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <line x1={5} y1={12} x2={19} y2={12} />
            <polyline points="12 5 19 12 12 19" />
          </svg>
          <span style={{ fontSize: '0.7rem', fontWeight: 600, color: LADDER_COLORS.textFaint, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            To
          </span>
          <span style={{ ...MONO, fontSize: '0.82rem', fontWeight: 600, color: LADDER_COLORS.text }}>
            {toDisplay}
          </span>
        </div>

        {/* Divider */}
        <div style={{ width: 1, height: 20, background: LADDER_COLORS.borderLight }} />

        {/* Duration */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: '0.7rem', fontWeight: 600, color: LADDER_COLORS.textFaint, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Duration
          </span>
          <span style={{ ...MONO, fontSize: '0.82rem', fontWeight: 600, color: LADDER_COLORS.provisional }}>
            {durationDisplay}
          </span>
        </div>

        {/* Status badge */}
        {finalStatus !== null && (
          <>
            <div style={{ width: 1, height: 20, background: LADDER_COLORS.borderLight }} />
            <span
              style={{
                ...MONO,
                display: 'inline-block',
                padding: '3px 10px',
                borderRadius: 5,
                fontSize: '0.72rem',
                fontWeight: 700,
                background: statusBg,
                color: statusColor,
                border: `1px solid ${statusBorder}`,
              }}
            >
              {finalStatus}
            </span>
          </>
        )}

        {/* Divider */}
        <div style={{ width: 1, height: 20, background: LADDER_COLORS.borderLight }} />

        {/* Message count */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: '0.7rem', fontWeight: 600, color: LADDER_COLORS.textFaint, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Messages
          </span>
          <span style={{ ...MONO, fontSize: '0.82rem', fontWeight: 600, color: LADDER_COLORS.accent }}>
            {layout.messages.filter((m) => !m.internalHandoff).length}
          </span>
        </div>
      </div>

      {/* Bottom row: Call-IDs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
        {layout.aLegCallIds.size > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span
              style={{
                fontSize: '0.6rem',
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: LADDER_COLORS.aLeg,
                padding: '1px 5px',
                borderRadius: 3,
                background: 'rgba(29,99,221,0.08)',
                border: '1px solid rgba(29,99,221,0.22)',
              }}
            >
              A-leg
            </span>
            <span
              style={{
                ...MONO,
                fontSize: '0.68rem',
                color: LADDER_COLORS.textMuted,
                maxWidth: 280,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={Array.from(layout.aLegCallIds).join(', ')}
            >
              {Array.from(layout.aLegCallIds).join(', ')}
            </span>
          </div>
        )}

        {layout.bLegCallIds.size > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span
              style={{
                fontSize: '0.6rem',
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: LADDER_COLORS.bLeg,
                padding: '1px 5px',
                borderRadius: 3,
                background: 'rgba(180,83,9,0.08)',
                border: '1px solid rgba(180,83,9,0.24)',
              }}
            >
              B-leg
            </span>
            <span
              style={{
                ...MONO,
                fontSize: '0.68rem',
                color: LADDER_COLORS.textMuted,
                maxWidth: 280,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={Array.from(layout.bLegCallIds).join(', ')}
            >
              {Array.from(layout.bLegCallIds).join(', ')}
            </span>
          </div>
        )}

        {/* Timestamps if we have them */}
        {firstMsg && lastMsg && firstMsg !== lastMsg && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginLeft: 'auto' }}>
            <span style={{ ...MONO, fontSize: '0.68rem', color: LADDER_COLORS.textFaint }}>
              {new Date(firstMsg.timestamp).toLocaleTimeString()}
            </span>
            <span style={{ fontSize: '0.68rem', color: LADDER_COLORS.textFaint }}>-</span>
            <span style={{ ...MONO, fontSize: '0.68rem', color: LADDER_COLORS.textFaint }}>
              {new Date(lastMsg.timestamp).toLocaleTimeString()}
            </span>
          </div>
        )}
      </div>
    </div>
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

  return (
    <div>
      {/* Pipeline notes — quiet ⓘ info chips, NOT warnings. What the API
          reports here (e.g. "N messages reordered for SIP causality") is the
          pipeline doing its job correctly; an amber alarm banner overstated it.
          One muted line per note, wrapping inline. */}
      {pipelineWarnings && pipelineWarnings.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
            marginBottom: 10,
          }}
        >
          {pipelineWarnings.map((warning, idx) => (
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

      {/* Call summary header */}
      <CallSummary layout={layout} />

      {/* Filter bar + Legend */}
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
