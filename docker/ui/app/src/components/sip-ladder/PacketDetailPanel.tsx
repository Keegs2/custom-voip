import { useState, useMemo, useCallback } from 'react';
import { LADDER_COLORS } from './sipLadderUtils';

// ─── SIP header parsing ─────────────────────────────────────────────────────

interface ParsedSipMessage {
  /** Request line or status line (first line of the SIP message) */
  startLine: string;
  /** Parsed header key-value pairs, preserving order */
  headers: Array<{ name: string; value: string }>;
  /** SDP body content (everything after the blank line), or null */
  sdpBody: string | null;
  /** Full raw text */
  rawText: string;
}

interface SdpInfo {
  /** Session-level connection address (c= line) */
  connectionAddress: string | null;
  /** Media descriptions (m= lines) */
  mediaDescriptions: string[];
  /** Codec names from a=rtpmap lines */
  codecs: string[];
  /** Media port from the first m= line */
  mediaPort: number | null;
  /** Origin address from o= line */
  originAddress: string | null;
}

/** Headers that are most important for SIP debugging — highlighted in the UI */
const IMPORTANT_HEADERS = new Set([
  'via',
  'record-route',
  'route',
  'contact',
  'from',
  'to',
  'call-id',
  'cseq',
  'session-expires',
  'min-se',
  'content-type',
  'x-carrier',
  'x-cid',
]);

/**
 * Parses a raw SIP message into structured components.
 *
 * SIP messages use \r\n as line delimiters. The headers and body are separated
 * by a blank line (\r\n\r\n). Some messages may use just \n, so we handle both.
 */
function parseSipMessage(raw: string): ParsedSipMessage {
  // Normalize line endings — some Homer captures use \n instead of \r\n
  const normalized = raw.replace(/\r\n/g, '\n');

  // Split on the first blank line to separate headers from body
  const blankLineIdx = normalized.indexOf('\n\n');

  let headerBlock: string;
  let sdpBody: string | null = null;

  if (blankLineIdx !== -1) {
    headerBlock = normalized.substring(0, blankLineIdx);
    const bodyText = normalized.substring(blankLineIdx + 2).trim();
    sdpBody = bodyText.length > 0 ? bodyText : null;
  } else {
    headerBlock = normalized;
  }

  const lines = headerBlock.split('\n');

  // First line is the request-line or status-line
  const startLine = lines[0] ?? '';

  // Parse remaining lines as headers. Multi-line headers (continuation lines
  // starting with whitespace) are folded into the previous header's value.
  const headers: Array<{ name: string; value: string }> = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.length === 0) continue;

    // Continuation line (starts with space or tab) — append to previous header
    if ((line[0] === ' ' || line[0] === '\t') && headers.length > 0) {
      headers[headers.length - 1].value += ' ' + line.trim();
      continue;
    }

    // Standard header: "Name: Value"
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const name = line.substring(0, colonIdx).trim();
      const value = line.substring(colonIdx + 1).trim();
      headers.push({ name, value });
    }
  }

  return {
    startLine,
    headers,
    sdpBody,
    rawText: raw,
  };
}

/**
 * Extracts structured SDP information from the body text.
 */
function extractSdpInfo(sdpBody: string): SdpInfo {
  const lines = sdpBody.split('\n').map((l) => l.trim());

  let connectionAddress: string | null = null;
  let originAddress: string | null = null;
  let mediaPort: number | null = null;
  const mediaDescriptions: string[] = [];
  const codecs: string[] = [];

  for (const line of lines) {
    // c=IN IP4 34.139.119.135
    if (line.startsWith('c=')) {
      const parts = line.substring(2).split(/\s+/);
      connectionAddress = parts[2] ?? null;
    }

    // o=FreeSWITCH 1234 5678 IN IP4 34.139.119.135
    if (line.startsWith('o=')) {
      const parts = line.substring(2).split(/\s+/);
      originAddress = parts[5] ?? null;
    }

    // m=audio 30000 RTP/AVP 0 8 101
    if (line.startsWith('m=')) {
      mediaDescriptions.push(line.substring(2));
      const parts = line.substring(2).split(/\s+/);
      if (parts[1] && mediaPort === null) {
        const port = parseInt(parts[1], 10);
        if (!isNaN(port)) {
          mediaPort = port;
        }
      }
    }

    // a=rtpmap:0 PCMU/8000
    if (line.startsWith('a=rtpmap:')) {
      const match = line.match(/a=rtpmap:\d+\s+(.+)/);
      if (match) {
        codecs.push(match[1]);
      }
    }
  }

  return {
    connectionAddress,
    mediaDescriptions,
    codecs,
    mediaPort,
    originAddress,
  };
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const panelStyle: React.CSSProperties = {
  background: 'linear-gradient(135deg, rgba(19,21,29,0.98) 0%, rgba(15,17,23,0.95) 100%)',
  border: `1px solid ${LADDER_COLORS.border}`,
  borderRadius: 12,
  margin: '4px 0 8px',
  overflow: 'hidden',
};

const sectionHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '10px 16px',
  cursor: 'pointer',
  userSelect: 'none',
  transition: 'background 0.15s',
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: '0.7rem',
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase' as const,
  color: LADDER_COLORS.textMuted,
};

const headerNameStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: '0.78rem',
  fontWeight: 600,
  color: LADDER_COLORS.textMuted,
  minWidth: 140,
  flexShrink: 0,
  paddingRight: 12,
  wordBreak: 'break-all',
};

const headerValueStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: '0.78rem',
  color: LADDER_COLORS.text,
  wordBreak: 'break-all',
  flex: 1,
};

const importantHeaderNameStyle: React.CSSProperties = {
  ...headerNameStyle,
  color: '#60a5fa',
};

const rawBlockStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: '0.72rem',
  lineHeight: 1.6,
  color: LADDER_COLORS.textMuted,
  background: 'rgba(0,0,0,0.3)',
  borderRadius: 8,
  padding: '12px 16px',
  margin: '0 16px 16px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  maxHeight: 400,
  overflowY: 'auto',
  border: `1px solid ${LADDER_COLORS.borderLight}`,
};

// ─── Chevron icon ───────────────────────────────────────────────────────────

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke={LADDER_COLORS.textFaint}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
        transition: 'transform 0.15s ease',
      }}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

// ─── SDP info card ──────────────────────────────────────────────────────────

function SdpInfoCard({ sdpInfo }: { sdpInfo: SdpInfo }) {
  const items: Array<{ label: string; value: string; highlight: boolean }> = [];

  if (sdpInfo.connectionAddress) {
    items.push({ label: 'Media IP', value: sdpInfo.connectionAddress, highlight: true });
  }
  if (sdpInfo.mediaPort !== null) {
    items.push({ label: 'Media Port', value: String(sdpInfo.mediaPort), highlight: true });
  }
  if (sdpInfo.originAddress && sdpInfo.originAddress !== sdpInfo.connectionAddress) {
    items.push({ label: 'Origin IP', value: sdpInfo.originAddress, highlight: false });
  }
  if (sdpInfo.codecs.length > 0) {
    items.push({ label: 'Codecs', value: sdpInfo.codecs.join(', '), highlight: false });
  }
  if (sdpInfo.mediaDescriptions.length > 0) {
    items.push({ label: 'Media', value: sdpInfo.mediaDescriptions.join('; '), highlight: false });
  }

  if (items.length === 0) return null;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
        gap: 8,
        padding: '0 16px 12px',
      }}
    >
      {items.map((item) => (
        <div
          key={item.label}
          style={{
            background: item.highlight ? 'rgba(59,130,246,0.06)' : 'rgba(255,255,255,0.02)',
            border: `1px solid ${item.highlight ? 'rgba(59,130,246,0.2)' : LADDER_COLORS.borderLight}`,
            borderRadius: 8,
            padding: '8px 12px',
          }}
        >
          <div
            style={{
              fontSize: '0.65rem',
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: LADDER_COLORS.textFaint,
              marginBottom: 2,
            }}
          >
            {item.label}
          </div>
          <div
            style={{
              fontFamily: 'ui-monospace, monospace',
              fontSize: '0.8rem',
              fontWeight: 600,
              color: item.highlight ? '#60a5fa' : LADDER_COLORS.text,
            }}
          >
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

interface PacketDetailPanelProps {
  /** The raw SIP message text (full headers + SDP body) */
  rawMsg: string;
  /** Accent color from the parent message row */
  accentColor: string;
  /** Called when the close button is clicked */
  onClose: () => void;
}

export function PacketDetailPanel({ rawMsg, accentColor, onClose }: PacketDetailPanelProps) {
  // ALL hooks unconditionally at the top (React rules of hooks)
  const [headersExpanded, setHeadersExpanded] = useState(true);
  const [sdpExpanded, setSdpExpanded] = useState(true);
  const [rawExpanded, setRawExpanded] = useState(false);

  const parsed = useMemo(() => parseSipMessage(rawMsg), [rawMsg]);

  const sdpInfo = useMemo(
    () => (parsed.sdpBody ? extractSdpInfo(parsed.sdpBody) : null),
    [parsed.sdpBody],
  );

  const handleHeadersToggle = useCallback(() => setHeadersExpanded((p) => !p), []);
  const handleSdpToggle = useCallback(() => setSdpExpanded((p) => !p), []);
  const handleRawToggle = useCallback(() => setRawExpanded((p) => !p), []);

  return (
    <div style={panelStyle}>
      {/* Top accent bar + close button */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 16px',
          borderBottom: `1px solid ${LADDER_COLORS.borderLight}`,
          background: 'rgba(0,0,0,0.15)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              width: 3,
              height: 16,
              borderRadius: 1.5,
              background: accentColor,
              flexShrink: 0,
            }}
          />
          <span
            style={{
              fontFamily: 'ui-monospace, monospace',
              fontSize: '0.78rem',
              fontWeight: 600,
              color: LADDER_COLORS.text,
            }}
          >
            {parsed.startLine}
          </span>
        </div>

        <button
          type="button"
          onClick={onClose}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            borderRadius: 6,
            border: `1px solid ${LADDER_COLORS.borderLight}`,
            background: 'transparent',
            cursor: 'pointer',
            color: LADDER_COLORS.textFaint,
            transition: 'color 0.15s, background 0.15s',
            padding: 0,
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = LADDER_COLORS.text;
            e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = LADDER_COLORS.textFaint;
            e.currentTarget.style.background = 'transparent';
          }}
          title="Close packet details"
        >
          <svg
            width={12}
            height={12}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1={18} y1={6} x2={6} y2={18} />
            <line x1={6} y1={6} x2={18} y2={18} />
          </svg>
        </button>
      </div>

      {/* SIP Headers section */}
      <div>
        <div
          style={sectionHeaderStyle}
          onClick={handleHeadersToggle}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.02)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
        >
          <span style={sectionTitleStyle}>
            SIP Headers ({parsed.headers.length})
          </span>
          <ChevronIcon expanded={headersExpanded} />
        </div>

        {headersExpanded && (
          <div style={{ padding: '0 16px 12px' }}>
            {parsed.headers.map((header, idx) => {
              const isImportant = IMPORTANT_HEADERS.has(header.name.toLowerCase());
              return (
                <div
                  key={`${header.name}-${idx}`}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    padding: '3px 0',
                    borderBottom:
                      idx < parsed.headers.length - 1
                        ? `1px solid rgba(42,47,69,0.15)`
                        : 'none',
                  }}
                >
                  <span style={isImportant ? importantHeaderNameStyle : headerNameStyle}>
                    {header.name}
                  </span>
                  <span style={headerValueStyle}>{header.value}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* SDP section (only if body contains SDP) */}
      {parsed.sdpBody && (
        <div style={{ borderTop: `1px solid ${LADDER_COLORS.borderLight}` }}>
          <div
            style={sectionHeaderStyle}
            onClick={handleSdpToggle}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.02)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          >
            <span style={sectionTitleStyle}>
              SDP Body
              {sdpInfo?.codecs.length ? ` (${sdpInfo.codecs.length} codec${sdpInfo.codecs.length !== 1 ? 's' : ''})` : ''}
            </span>
            <ChevronIcon expanded={sdpExpanded} />
          </div>

          {sdpExpanded && sdpInfo && <SdpInfoCard sdpInfo={sdpInfo} />}

          {sdpExpanded && (
            <pre style={rawBlockStyle}>{parsed.sdpBody}</pre>
          )}
        </div>
      )}

      {/* Raw message section */}
      <div style={{ borderTop: `1px solid ${LADDER_COLORS.borderLight}` }}>
        <div
          style={sectionHeaderStyle}
          onClick={handleRawToggle}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.02)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
        >
          <span style={sectionTitleStyle}>Raw Message</span>
          <ChevronIcon expanded={rawExpanded} />
        </div>

        {rawExpanded && (
          <pre style={rawBlockStyle}>{parsed.rawText}</pre>
        )}
      </div>
    </div>
  );
}
