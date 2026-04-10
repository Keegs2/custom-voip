import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { PortalHeader } from './RcfPage';
import { IconDocs } from '../components/icons/ProductIcons';

/* ─── Types ──────────────────────────────────────────────── */

type DocMode = 'customer' | 'fullref';
type SwaggerView = 'swagger' | 'redoc';

interface NavSection {
  id: string;
  label: string;
  icon: React.ReactNode;
}

/* ─── Nav sections ───────────────────────────────────────── */

const NAV_SECTIONS: NavSection[] = [
  {
    id: 'getting-started',
    label: 'Getting Started',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 14, height: 14 }}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5 10.5 6.75 14.25 10.5 20.25 3.75M20.25 3.75H15m5.25 0V9" />
      </svg>
    ),
  },
  {
    id: 'authentication',
    label: 'Authentication',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 14, height: 14 }}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 0 1 18.75 8.25Z" />
      </svg>
    ),
  },
  {
    id: 'originate',
    label: 'Making Calls',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 14, height: 14 }}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 0 0 2.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 0 1-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 0 0-1.091-.852H4.5A2.25 2.25 0 0 0 2.25 4.5v2.25Z" />
      </svg>
    ),
  },
  {
    id: 'numbers',
    label: 'Managing Numbers',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 14, height: 14 }}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9h16.5m-16.5 6.75h16.5" />
      </svg>
    ),
  },
  {
    id: 'webhooks',
    label: 'Webhooks',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 14, height: 14 }}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
      </svg>
    ),
  },
  {
    id: 'verbs',
    label: 'Call Control Verbs',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 14, height: 14 }}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
      </svg>
    ),
  },
  {
    id: 'errors',
    label: 'Error Codes',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 14, height: 14 }}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
      </svg>
    ),
  },
];

/* ─── Design tokens ──────────────────────────────────────── */

const COLORS = {
  bg: '#13151d',
  surface: '#1a1d27',
  surfaceAlt: '#1e2130',
  border: 'rgba(42,47,69,0.6)',
  borderSubtle: 'rgba(42,47,69,0.35)',
  text: '#e2e8f0',
  textMuted: '#718096',
  textFaint: '#4a5568',
  accent: '#3b82f6',
  accentGlow: 'rgba(59,130,246,0.15)',
  green: '#22c55e',
  purple: '#a855f7',
  amber: '#f59e0b',
  red: '#ef4444',
  codeBg: '#0d0f15',
  codeString: '#4ade80',
  codeKey: '#60a5fa',
  codeComment: '#4a5568',
  codeKeyword: '#c084fc',
  codeNumber: '#fb923c',
};

/* ─── Utility components ─────────────────────────────────── */

function SectionAnchor({ id }: { id: string }) {
  return (
    <div
      id={id}
      style={{
        position: 'relative',
        // Offset so the sticky header doesn't cover the heading when scrolled to
        scrollMarginTop: 32,
      }}
    />
  );
}

interface SectionCardProps {
  id: string;
  accent: string;
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}

function SectionCard({ id, accent, icon, title, children }: SectionCardProps) {
  return (
    <div style={{ position: 'relative' }}>
      <SectionAnchor id={id} />
      <div
        style={{
          background: `linear-gradient(135deg, ${COLORS.surface} 0%, ${COLORS.surfaceAlt} 100%)`,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 16,
          overflow: 'hidden',
          marginBottom: 32,
        }}
      >
        {/* Top accent line */}
        <div
          style={{
            height: 2,
            background: `linear-gradient(90deg, transparent, ${accent}, transparent)`,
            opacity: 0.6,
          }}
        />

        <div style={{ padding: '32px 36px' }}>
          {/* Section header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: `linear-gradient(135deg, ${accent}20 0%, ${accent}08 100%)`,
                border: `1px solid ${accent}30`,
                color: accent,
                flexShrink: 0,
              }}
            >
              {icon}
            </div>
            <h2
              style={{
                fontSize: '1.15rem',
                fontWeight: 700,
                color: COLORS.text,
                letterSpacing: '-0.01em',
                margin: 0,
              }}
            >
              {title}
            </h2>
          </div>

          {children}
        </div>
      </div>
    </div>
  );
}

interface CodeBlockProps {
  code: string;
  language?: string;
}

/**
 * Tokenize a line of code into colored spans.
 * Works on raw text (no HTML escaping needed since we use React elements).
 */
type Token = { text: string; color?: string };

function tokenizeLine(line: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let inString = false;
  let current = '';
  let currentColor: string | undefined;

  function flush() {
    if (current) {
      tokens.push({ text: current, color: currentColor });
      current = '';
      currentColor = undefined;
    }
  }

  while (i < line.length) {
    const ch = line[i];

    // Comment (# outside string)
    if (ch === '#' && !inString) {
      flush();
      tokens.push({ text: line.slice(i), color: COLORS.codeComment });
      return tokens;
    }

    // String start/end
    if (ch === '"' && (i === 0 || line[i - 1] !== '\\')) {
      if (!inString) {
        flush();
        inString = true;
        // Look ahead to find closing quote
        let j = i + 1;
        while (j < line.length && !(line[j] === '"' && line[j - 1] !== '\\')) j++;
        const str = line.slice(i, j + 1);
        // Check if this is a key (followed by :) or value
        const afterStr = line.slice(j + 1).trimStart();
        const isKey = afterStr.startsWith(':');
        tokens.push({ text: str, color: isKey ? COLORS.codeKey : COLORS.codeString });
        i = j + 1;
        inString = false;
        continue;
      }
    }

    // XML/HTML tags: <Tag> or </Tag>
    if (ch === '<' && !inString) {
      const match = line.slice(i).match(/^<\/?[A-Za-z][^>]*>/);
      if (match) {
        flush();
        tokens.push({ text: match[0], color: COLORS.codeKey });
        i += match[0].length;
        continue;
      }
    }

    // curl flags: -X, -H, --header
    if ((ch === '-') && !inString && (i === 0 || line[i - 1] === ' ')) {
      const match = line.slice(i).match(/^(?:-[A-Za-z]+|--[A-Za-z-]+)/);
      if (match) {
        flush();
        tokens.push({ text: match[0], color: COLORS.codeKeyword });
        i += match[0].length;
        continue;
      }
    }

    current += ch;
    i++;
  }
  flush();
  return tokens;
}

function CodeBlock({ code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  // Build React elements per line — no dangerouslySetInnerHTML
  const lines = code.split('\n');
  const rendered = lines.map((line, li) => {
    const tokens = tokenizeLine(line);
    return (
      <span key={li}>
        {tokens.map((t, ti) =>
          t.color
            ? <span key={ti} style={{ color: t.color }}>{t.text}</span>
            : <span key={ti}>{t.text}</span>
        )}
        {li < lines.length - 1 ? '\n' : ''}
      </span>
    );
  });

  return (
    <div
      style={{
        position: 'relative',
        borderRadius: 10,
        overflow: 'hidden',
        border: `1px solid rgba(42,47,69,0.8)`,
        marginTop: 12,
        marginBottom: 4,
      }}
    >
      {/* Copy button */}
      <button
        type="button"
        onClick={handleCopy}
        style={{
          position: 'absolute',
          top: 10,
          right: 10,
          padding: '4px 10px',
          borderRadius: 6,
          fontSize: '0.7rem',
          fontWeight: 600,
          background: copied ? 'rgba(34,197,94,0.15)' : 'rgba(42,47,69,0.6)',
          color: copied ? COLORS.green : COLORS.textMuted,
          border: `1px solid ${copied ? 'rgba(34,197,94,0.3)' : 'rgba(42,47,69,0.8)'}`,
          cursor: 'pointer',
          transition: 'all 0.15s',
          zIndex: 2,
          letterSpacing: '0.04em',
        }}
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>

      <pre
        style={{
          margin: 0,
          padding: '20px 24px',
          background: COLORS.codeBg,
          fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
          fontSize: '0.8rem',
          lineHeight: 1.75,
          color: '#cbd5e1',
          overflowX: 'auto',
          whiteSpace: 'pre',
        }}
      >{rendered}</pre>
    </div>
  );
}

interface HttpBadgeProps {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
}

function HttpBadge({ method }: HttpBadgeProps) {
  const colors: Record<string, { bg: string; color: string }> = {
    GET: { bg: 'rgba(34,197,94,0.12)', color: '#4ade80' },
    POST: { bg: 'rgba(59,130,246,0.12)', color: '#60a5fa' },
    PUT: { bg: 'rgba(245,158,11,0.12)', color: '#fbbf24' },
    DELETE: { bg: 'rgba(239,68,68,0.12)', color: '#f87171' },
    PATCH: { bg: 'rgba(168,85,247,0.12)', color: '#c084fc' },
  };
  const { bg, color } = colors[method] ?? colors.GET;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 9px',
        borderRadius: 5,
        fontSize: '0.7rem',
        fontWeight: 800,
        letterSpacing: '0.07em',
        background: bg,
        color,
        marginRight: 10,
        fontFamily: 'monospace',
        verticalAlign: 'middle',
      }}
    >
      {method}
    </span>
  );
}

function EndpointRow({ method, path, description }: { method: HttpBadgeProps['method']; path: string; description: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '14px 18px',
        borderRadius: 8,
        background: 'rgba(13,15,21,0.5)',
        border: `1px solid ${COLORS.borderSubtle}`,
        marginBottom: 10,
      }}
    >
      <HttpBadge method={method} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <code
          style={{
            fontSize: '0.82rem',
            color: '#93c5fd',
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            display: 'block',
            marginBottom: 3,
          }}
        >
          {path}
        </code>
        <p style={{ margin: 0, fontSize: '0.82rem', color: COLORS.textMuted, lineHeight: 1.5 }}>
          {description}
        </p>
      </div>
    </div>
  );
}

function ProseP({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ margin: '0 0 14px', fontSize: '0.875rem', color: COLORS.textMuted, lineHeight: 1.7 }}>
      {children}
    </p>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{
        margin: '28px 0 12px',
        fontSize: '0.8rem',
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: COLORS.textFaint,
      }}
    >
      {children}
    </h3>
  );
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code
      style={{
        background: 'rgba(13,15,21,0.7)',
        border: `1px solid ${COLORS.borderSubtle}`,
        borderRadius: 4,
        padding: '1px 6px',
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: '0.78rem',
        color: '#93c5fd',
      }}
    >
      {children}
    </code>
  );
}

interface TableRow {
  col1: string;
  col2: string;
  col3?: string;
  accent?: string;
}

function SimpleTable({ headers, rows }: { headers: string[]; rows: TableRow[] }) {
  return (
    <div
      style={{
        borderRadius: 8,
        overflow: 'hidden',
        border: `1px solid ${COLORS.borderSubtle}`,
        marginBottom: 4,
      }}
    >
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
        <thead>
          <tr style={{ background: 'rgba(13,15,21,0.6)' }}>
            {headers.map((h) => (
              <th
                key={h}
                style={{
                  padding: '10px 16px',
                  textAlign: 'left',
                  color: COLORS.textFaint,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  fontSize: '0.7rem',
                  textTransform: 'uppercase',
                  borderBottom: `1px solid ${COLORS.borderSubtle}`,
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(13,15,21,0.25)' }}
            >
              <td
                style={{
                  padding: '10px 16px',
                  fontFamily: 'monospace',
                  fontSize: '0.78rem',
                  color: row.accent ?? '#60a5fa',
                  borderBottom: `1px solid ${COLORS.borderSubtle}`,
                  whiteSpace: 'nowrap',
                }}
              >
                {row.col1}
              </td>
              <td
                style={{
                  padding: '10px 16px',
                  color: COLORS.textMuted,
                  borderBottom: `1px solid ${COLORS.borderSubtle}`,
                }}
              >
                {row.col2}
              </td>
              {row.col3 !== undefined && (
                <td
                  style={{
                    padding: '10px 16px',
                    color: COLORS.textMuted,
                    borderBottom: `1px solid ${COLORS.borderSubtle}`,
                  }}
                >
                  {row.col3}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ─── Doc section contents ───────────────────────────────── */

function GettingStartedSection() {
  return (
    <SectionCard
      id="getting-started"
      accent={COLORS.accent}
      title="Getting Started"
      icon={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 18, height: 18 }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5 10.5 6.75 14.25 10.5 20.25 3.75M20.25 3.75H15m5.25 0V9" />
        </svg>
      }
    >
      <ProseP>
        Welcome to the Voice Platform API. This API lets you originate outbound calls, manage your
        phone numbers, and build programmable voice applications using webhook-driven call control.
        Every request is authenticated with an API key and communicates over HTTPS.
      </ProseP>

      <SubHeading>Base URL</SubHeading>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 18px',
          borderRadius: 8,
          background: 'rgba(13,15,21,0.5)',
          border: `1px solid ${COLORS.borderSubtle}`,
          marginBottom: 20,
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke={COLORS.accent} strokeWidth={1.8} style={{ width: 16, height: 16, flexShrink: 0 }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253M3 12a8.96 8.96 0 0 0 .284 2.253" />
        </svg>
        <code
          style={{
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            fontSize: '0.875rem',
            color: '#93c5fd',
          }}
        >
          https://&#123;platform-host&#125;/api
        </code>
      </div>

      <SubHeading>Quick Example</SubHeading>
      <ProseP>
        Every API request must include your API key in the <InlineCode>Authorization</InlineCode> header.
        Here is a minimal call to verify your credentials are working:
      </ProseP>
      <CodeBlock
        language="bash"
        code={`curl -X GET https://{platform-host}/api/api-dids \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json"`}
      />
    </SectionCard>
  );
}

function AuthenticationSection() {
  return (
    <SectionCard
      id="authentication"
      accent={COLORS.purple}
      title="Authentication"
      icon={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 18, height: 18 }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 0 1 18.75 8.25Z" />
        </svg>
      }
    >
      <ProseP>
        The API uses Bearer token authentication. Your API key is a long-lived token that you include
        in every request header. Keep it secure — treat it like a password.
      </ProseP>

      <SubHeading>Obtaining Credentials</SubHeading>
      <ProseP>
        API credentials are provisioned by your platform administrator. Contact your account manager
        or open a support ticket to request an API key. Once issued, keys do not expire automatically
        but can be revoked at any time by an administrator.
      </ProseP>

      <SubHeading>Using your API Key</SubHeading>
      <ProseP>
        Include the key as a Bearer token in the <InlineCode>Authorization</InlineCode> header of
        every request:
      </ProseP>
      <CodeBlock
        language="bash"
        code={`# Replace YOUR_API_KEY with the key issued to you
curl -X GET https://{platform-host}/api/api-dids \\
  -H "Authorization: Bearer YOUR_API_KEY"`}
      />

      <SubHeading>Authentication Errors</SubHeading>
      <SimpleTable
        headers={['Status', 'Meaning']}
        rows={[
          { col1: '401 Unauthorized', col2: 'Missing or invalid API key', accent: COLORS.red },
          { col1: '403 Forbidden', col2: 'Key is valid but lacks permission for this resource', accent: COLORS.amber },
        ]}
      />
    </SectionCard>
  );
}

function OriginateSection() {
  return (
    <SectionCard
      id="originate"
      accent={COLORS.green}
      title="Making Calls (Originate)"
      icon={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 18, height: 18 }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 0 0 2.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 0 1-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 0 0-1.091-.852H4.5A2.25 2.25 0 0 0 2.25 4.5v2.25Z" />
        </svg>
      }
    >
      <ProseP>
        Use the originate endpoint to programmatically start an outbound call. The platform dials the
        destination number and — once answered — fetches TwiML instructions from your <InlineCode>voice_url</InlineCode>.
      </ProseP>

      <EndpointRow
        method="POST"
        path="/api/calls/originate"
        description="Initiate an outbound call from one of your API-enabled numbers"
      />

      <SubHeading>Request Body</SubHeading>
      <CodeBlock
        language="json"
        code={`{
  "to": "+15551234567",     # E.164 destination number
  "from": "+15559876543",   # Your API-enabled DID
  "voice_url": "https://yourserver.com/call-handler"  # Webhook URL
}`}
      />

      <SubHeading>Request Fields</SubHeading>
      <SimpleTable
        headers={['Field', 'Type', 'Description']}
        rows={[
          { col1: 'to', col2: 'string', col3: 'Destination number in E.164 format (e.g. +15551234567)' },
          { col1: 'from', col2: 'string', col3: 'Your platform DID in E.164 format — must be API-enabled' },
          { col1: 'voice_url', col2: 'string', col3: 'URL the platform will POST to when the call is answered' },
        ]}
      />

      <SubHeading>Response</SubHeading>
      <CodeBlock
        language="json"
        code={`{
  "call_id": "c8f3a912-4b1e-4d72-a2c9-71e08fbc3a41",
  "status": "initiated",
  "to": "+15551234567",
  "from": "+15559876543",
  "created_at": "2026-04-09T14:30:00Z"
}`}
      />

      <SubHeading>Full Example</SubHeading>
      <CodeBlock
        language="bash"
        code={`curl -X POST https://{platform-host}/api/calls/originate \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "to": "+15551234567",
    "from": "+15559876543",
    "voice_url": "https://yourserver.com/call-handler"
  }'`}
      />
    </SectionCard>
  );
}

function NumbersSection() {
  return (
    <SectionCard
      id="numbers"
      accent={COLORS.amber}
      title="Managing Numbers"
      icon={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 18, height: 18 }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9h16.5m-16.5 6.75h16.5" />
        </svg>
      }
    >
      <ProseP>
        API-enabled DIDs are phone numbers that have been provisioned for programmatic use.
        You can list your numbers and update the webhook URL for any of them.
      </ProseP>

      <EndpointRow
        method="GET"
        path="/api/api-dids"
        description="List all API-enabled numbers assigned to your account"
      />
      <EndpointRow
        method="PUT"
        path="/api/api-dids/{id}"
        description="Update configuration for a specific number (e.g. change its voice URL)"
      />

      <SubHeading>List Numbers — Response</SubHeading>
      <CodeBlock
        language="json"
        code={`[
  {
    "id": 42,
    "did": "+15559876543",
    "voice_url": "https://yourserver.com/call-handler",
    "enabled": true,
    "description": "Main sales line"
  }
]`}
      />

      <SubHeading>Update a Number — Request Body</SubHeading>
      <CodeBlock
        language="json"
        code={`{
  "voice_url": "https://yourserver.com/new-handler",
  "description": "Updated sales line"
}`}
      />

      <SubHeading>Examples</SubHeading>
      <CodeBlock
        language="bash"
        code={`# List your numbers
curl -X GET https://{platform-host}/api/api-dids \\
  -H "Authorization: Bearer YOUR_API_KEY"

# Update voice URL for number with id 42
curl -X PUT https://{platform-host}/api/api-dids/42 \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"voice_url": "https://yourserver.com/new-handler"}'`}
      />
    </SectionCard>
  );
}

function WebhooksSection() {
  return (
    <SectionCard
      id="webhooks"
      accent="#06b6d4"
      title="Webhooks"
      icon={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 18, height: 18 }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244" />
        </svg>
      }
    >
      <ProseP>
        When an inbound call arrives on one of your API-enabled numbers (or when an outbound call
        is answered), the platform sends an HTTP POST to your configured <InlineCode>voice_url</InlineCode>.
        Your server must respond with TwiML-style XML that instructs the platform on how to handle the call.
      </ProseP>

      <SubHeading>Webhook Request (POST to your server)</SubHeading>
      <ProseP>
        The platform sends the following JSON body when it POSTs to your webhook:
      </ProseP>
      <CodeBlock
        language="json"
        code={`{
  "call_id": "c8f3a912-4b1e-4d72-a2c9-71e08fbc3a41",
  "call_status": "ringing",
  "direction": "inbound",
  "to": "+15559876543",
  "from": "+15551234567",
  "timestamp": "2026-04-09T14:30:00Z"
}`}
      />

      <SubHeading>Required Response</SubHeading>
      <ProseP>
        Your server must respond with HTTP 200 and a <InlineCode>Content-Type: application/xml</InlineCode> body
        containing valid call control XML. The platform will execute the verbs in order.
      </ProseP>
      <CodeBlock
        language="xml"
        code={`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Hello! Please hold while we connect your call.</Say>
  <Dial>+15559990000</Dial>
</Response>`}
      />

      <SubHeading>Example Webhook Handler (Node.js / Express)</SubHeading>
      <CodeBlock
        language="javascript"
        code={`import express from 'express';
const app = express();
app.use(express.json());

app.post('/call-handler', (req, res) => {
  const { from, to, call_id } = req.body;
  console.log(\`Call \${call_id} from \${from} to \${to}\`);

  res.set('Content-Type', 'application/xml');
  res.send(\`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Thanks for calling. Connecting you now.</Say>
  <Dial>\${process.env.FORWARD_NUMBER}</Dial>
</Response>\`);
});

app.listen(3000);`}
      />

      <SubHeading>Webhook Reliability Tips</SubHeading>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
        {[
          'Respond within 10 seconds — the platform will hang up if your webhook times out.',
          'Return HTTP 200. Non-2xx responses will trigger a retry with exponential backoff.',
          'Your endpoint must be publicly reachable over HTTPS with a valid TLS certificate.',
          'Validate the call_id to prevent replay attacks.',
        ].map((tip, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <div
              style={{
                width: 18,
                height: 18,
                borderRadius: '50%',
                background: 'rgba(6,182,212,0.12)',
                border: '1px solid rgba(6,182,212,0.25)',
                color: '#22d3ee',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '0.65rem',
                fontWeight: 700,
                flexShrink: 0,
                marginTop: 1,
              }}
            >
              {i + 1}
            </div>
            <p style={{ margin: 0, fontSize: '0.82rem', color: COLORS.textMuted, lineHeight: 1.6 }}>
              {tip}
            </p>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

function VerbsSection() {
  const verbs = [
    {
      name: 'Say',
      accent: '#60a5fa',
      description: 'Convert text to speech and play it to the caller.',
      attrs: [
        { name: 'voice', desc: 'Voice name — alice, man, woman (default: alice)' },
        { name: 'language', desc: 'BCP-47 language tag (default: en-US)' },
        { name: 'loop', desc: 'Number of times to repeat (default: 1)' },
      ],
      example: `<Say voice="alice" language="en-US">
  Welcome to our service. Press 1 for sales.
</Say>`,
    },
    {
      name: 'Play',
      accent: '#4ade80',
      description: 'Play an audio file (MP3 or WAV) from a URL.',
      attrs: [
        { name: 'loop', desc: 'Number of times to repeat (default: 1)' },
      ],
      example: `<Play loop="1">https://yourserver.com/hold-music.mp3</Play>`,
    },
    {
      name: 'Gather',
      accent: '#c084fc',
      description: 'Collect DTMF digits from the caller and POST them to an action URL.',
      attrs: [
        { name: 'action', desc: 'URL to POST gathered digits to' },
        { name: 'numDigits', desc: 'Stop gathering after this many digits' },
        { name: 'timeout', desc: 'Seconds to wait for input before continuing (default: 5)' },
        { name: 'finishOnKey', desc: 'Digit that finalizes input (default: #)' },
      ],
      example: `<Gather action="https://yourserver.com/menu" numDigits="1" timeout="5">
  <Say>Press 1 for sales, 2 for support.</Say>
</Gather>`,
    },
    {
      name: 'Dial',
      accent: '#fbbf24',
      description: 'Forward the call to another phone number or SIP URI.',
      attrs: [
        { name: 'callerId', desc: 'Override the caller ID shown to the destination' },
        { name: 'timeout', desc: 'Seconds to wait for answer (default: 30)' },
        { name: 'action', desc: 'URL to call when the dialed call ends' },
      ],
      example: `<Dial callerId="+15559876543" timeout="30">
  +15550001234
</Dial>`,
    },
    {
      name: 'Hangup',
      accent: '#f87171',
      description: 'End the call immediately.',
      attrs: [],
      example: `<Hangup />`,
    },
    {
      name: 'Pause',
      accent: '#94a3b8',
      description: 'Wait silently for a specified number of seconds.',
      attrs: [
        { name: 'length', desc: 'Duration in seconds (default: 1)' },
      ],
      example: `<Pause length="2" />`,
    },
  ];

  return (
    <SectionCard
      id="verbs"
      accent={COLORS.purple}
      title="Call Control Verbs"
      icon={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 18, height: 18 }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
        </svg>
      }
    >
      <ProseP>
        Your webhook responses contain XML verbs inside a <InlineCode>&lt;Response&gt;</InlineCode> root
        element. The platform executes each verb sequentially. Verbs can be nested where noted.
      </ProseP>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {verbs.map((verb) => (
          <div
            key={verb.name}
            style={{
              borderRadius: 10,
              border: `1px solid ${COLORS.borderSubtle}`,
              overflow: 'hidden',
            }}
          >
            {/* Verb header */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '12px 18px',
                background: 'rgba(13,15,21,0.5)',
                borderBottom: `1px solid ${COLORS.borderSubtle}`,
              }}
            >
              <span
                style={{
                  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                  fontSize: '0.85rem',
                  fontWeight: 700,
                  color: verb.accent,
                  background: `${verb.accent}12`,
                  border: `1px solid ${verb.accent}30`,
                  borderRadius: 6,
                  padding: '2px 10px',
                }}
              >
                &lt;{verb.name}&gt;
              </span>
              <span style={{ fontSize: '0.82rem', color: COLORS.textMuted }}>
                {verb.description}
              </span>
            </div>

            <div style={{ padding: '16px 18px' }}>
              {verb.attrs.length > 0 && (
                <>
                  <p
                    style={{
                      margin: '0 0 10px',
                      fontSize: '0.72rem',
                      fontWeight: 700,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      color: COLORS.textFaint,
                    }}
                  >
                    Attributes
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
                    {verb.attrs.map((attr) => (
                      <div key={attr.name} style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
                        <InlineCode>{attr.name}</InlineCode>
                        <span style={{ fontSize: '0.8rem', color: COLORS.textMuted }}>
                          {attr.desc}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              <CodeBlock language="xml" code={verb.example} />
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

function ErrorCodesSection() {
  return (
    <SectionCard
      id="errors"
      accent={COLORS.red}
      title="Error Codes"
      icon={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 18, height: 18 }}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
        </svg>
      }
    >
      <SubHeading>HTTP Status Codes</SubHeading>
      <SimpleTable
        headers={['Code', 'Meaning', 'Common Cause']}
        rows={[
          { col1: '200 OK', col2: 'Request succeeded', col3: '', accent: COLORS.green },
          { col1: '400 Bad Request', col2: 'Invalid request body or parameters', col3: 'Missing required field, bad E.164 format', accent: COLORS.amber },
          { col1: '401 Unauthorized', col2: 'Authentication failed', col3: 'Missing or expired API key', accent: COLORS.red },
          { col1: '403 Forbidden', col2: 'Permission denied', col3: 'Your key cannot access this resource', accent: COLORS.red },
          { col1: '404 Not Found', col2: 'Resource does not exist', col3: 'Wrong DID id, call not found', accent: COLORS.amber },
          { col1: '429 Too Many Requests', col2: 'Rate limit exceeded', col3: 'Slow down — retry after the Retry-After header', accent: COLORS.amber },
          { col1: '500 Internal Error', col2: 'Platform error', col3: 'Transient — retry with exponential backoff', accent: COLORS.red },
        ]}
      />

      <SubHeading>SIP Error Codes</SubHeading>
      <SimpleTable
        headers={['SIP Code', 'Meaning']}
        rows={[
          { col1: '403', col2: 'Forbidden — caller not authorized on this trunk', accent: COLORS.red },
          { col1: '404', col2: 'Not Found — dialed number does not exist', accent: COLORS.amber },
          { col1: '408', col2: 'Request Timeout — far-end did not respond in time', accent: COLORS.amber },
          { col1: '480', col2: 'Temporarily Unavailable — called party is offline', accent: COLORS.amber },
          { col1: '486', col2: 'Busy Here — called party is busy', accent: COLORS.amber },
          { col1: '503', col2: 'Service Unavailable — carrier congestion', accent: COLORS.red },
        ]}
      />

      <SubHeading>Troubleshooting Tips</SubHeading>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
        {[
          { title: 'Check your Authorization header', body: 'Ensure the header is spelled correctly and the token has no extra whitespace or line breaks.' },
          { title: 'Use E.164 number format', body: 'All phone numbers must start with + followed by country code and subscriber number, e.g. +15551234567.' },
          { title: 'Verify your webhook is reachable', body: 'The platform cannot reach localhost. Use a publicly accessible HTTPS URL with a valid TLS certificate.' },
          { title: 'Webhook must respond within 10 seconds', body: 'Long-running processing should be deferred — respond immediately with XML and do async work separately.' },
          { title: 'Handle 429 with backoff', body: 'If rate-limited, wait the number of seconds in the Retry-After response header before retrying.' },
        ].map((item) => (
          <div
            key={item.title}
            style={{
              padding: '14px 16px',
              borderRadius: 8,
              background: 'rgba(13,15,21,0.4)',
              border: `1px solid ${COLORS.borderSubtle}`,
            }}
          >
            <p style={{ margin: '0 0 4px', fontSize: '0.82rem', fontWeight: 700, color: COLORS.text }}>
              {item.title}
            </p>
            <p style={{ margin: 0, fontSize: '0.8rem', color: COLORS.textMuted, lineHeight: 1.6 }}>
              {item.body}
            </p>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

/* ─── Sidebar nav ────────────────────────────────────────── */

interface SidebarNavProps {
  activeSection: string;
  onNavigate: (id: string) => void;
}

function SidebarNav({ activeSection, onNavigate }: SidebarNavProps) {
  return (
    <nav
      style={{
        width: 220,
        flexShrink: 0,
        position: 'sticky',
        top: 24,
        alignSelf: 'flex-start',
        maxHeight: 'calc(100vh - 200px)',
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          background: `linear-gradient(135deg, ${COLORS.surface} 0%, ${COLORS.surfaceAlt} 100%)`,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 12,
          padding: '8px 6px',
        }}
      >
        <p
          style={{
            margin: '6px 10px 10px',
            fontSize: '0.65rem',
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: COLORS.textFaint,
          }}
        >
          Contents
        </p>
        {NAV_SECTIONS.map((section) => {
          const isActive = activeSection === section.id;
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => onNavigate(section.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '8px 10px',
                borderRadius: 7,
                background: isActive ? 'rgba(59,130,246,0.12)' : 'transparent',
                color: isActive ? '#93c5fd' : COLORS.textMuted,
                fontSize: '0.8rem',
                fontWeight: isActive ? 600 : 400,
                cursor: 'pointer',
                border: 'none',
                textAlign: 'left',
                transition: 'all 0.15s',
                borderLeft: isActive ? `2px solid ${COLORS.accent}` : '2px solid transparent',
              }}
            >
              <span style={{ opacity: isActive ? 1 : 0.5, flexShrink: 0 }}>{section.icon}</span>
              {section.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/* ─── View toggle button ─────────────────────────────────── */

interface ToggleButtonProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

function ToggleButton({ label, active, onClick }: ToggleButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '6px 14px',
        borderRadius: 7,
        fontSize: '0.82rem',
        fontWeight: 600,
        whiteSpace: 'nowrap',
        transition: 'background 0.15s, color 0.15s',
        background: active ? COLORS.accent : 'transparent',
        color: active ? '#ffffff' : COLORS.textMuted,
        boxShadow: active ? '0 0 10px rgba(59,130,246,0.3)' : 'none',
        cursor: 'pointer',
        border: 'none',
      }}
    >
      {label}
    </button>
  );
}

/* ─── Full-ref iframe panel (admin only) ─────────────────── */

function FullRefPanel() {
  const [swaggerView, setSwaggerView] = useState<SwaggerView>('swagger');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Sub-toggle: Swagger vs ReDoc */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            background: 'rgba(19,21,29,0.9)',
            border: `1px solid ${COLORS.border}`,
            borderRadius: 10,
            padding: 4,
          }}
        >
          <ToggleButton
            label="Swagger UI"
            active={swaggerView === 'swagger'}
            onClick={() => setSwaggerView('swagger')}
          />
          <ToggleButton
            label="ReDoc"
            active={swaggerView === 'redoc'}
            onClick={() => setSwaggerView('redoc')}
          />
        </div>
      </div>

      <div
        style={{
          borderRadius: 16,
          border: `1px solid ${COLORS.border}`,
          overflow: 'hidden',
          boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
        }}
      >
        <iframe
          key={swaggerView}
          src={swaggerView === 'swagger' ? '/docs' : '/redoc'}
          title={swaggerView === 'swagger' ? 'Swagger UI' : 'ReDoc API Documentation'}
          style={{
            width: '100%',
            height: 'calc(100vh - 220px)',
            border: 'none',
            background: '#1a1d27',
          }}
        />
      </div>
    </div>
  );
}

/* ─── Customer docs main content ─────────────────────────── */

function CustomerDocs() {
  const [activeSection, setActiveSection] = useState<string>('getting-started');
  const contentRef = useRef<HTMLDivElement>(null);
  const ticking = useRef(false);

  // Scrollspy: update active section based on scroll position
  useEffect(() => {
    const container = contentRef.current?.closest('.docs-scroll-container') ?? window;

    const handleScroll = () => {
      if (ticking.current) return;
      ticking.current = true;
      requestAnimationFrame(() => {
        ticking.current = false;
        const ids = NAV_SECTIONS.map((s) => s.id);
        let currentId = ids[0];
        for (const id of ids) {
          const el = document.getElementById(id);
          if (el) {
            const rect = el.getBoundingClientRect();
            if (rect.top <= 120) {
              currentId = id;
            }
          }
        }
        setActiveSection(currentId);
      });
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollToSection = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveSection(id);
    }
  }, []);

  return (
    <div style={{ display: 'flex', gap: 32, alignItems: 'flex-start' }}>
      <SidebarNav activeSection={activeSection} onNavigate={scrollToSection} />

      <div ref={contentRef} style={{ flex: 1, minWidth: 0 }}>
        <GettingStartedSection />
        <AuthenticationSection />
        <OriginateSection />
        <NumbersSection />
        <WebhooksSection />
        <VerbsSection />
        <ErrorCodesSection />

        {/* Footer */}
        <div
          style={{
            padding: '24px 0',
            borderTop: `1px solid ${COLORS.borderSubtle}`,
            textAlign: 'center',
          }}
        >
          <p style={{ margin: 0, fontSize: '0.8rem', color: COLORS.textFaint }}>
            Need help? Contact your platform administrator or open a support ticket.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────── */

export function DocsPage() {
  const { isAdmin } = useAuth();
  const [docMode, setDocMode] = useState<DocMode>('customer');

  return (
    <div className="flex flex-col h-full">
      <PortalHeader
        icon={<IconDocs size={24} />}
        title="API Documentation"
        subtitle={
          isAdmin && docMode === 'fullref'
            ? 'Full internal API reference — all platform endpoints'
            : 'Integration guide and API reference for building on the platform'
        }
        badgeVariant="api"
      />

      {/* Admin mode toggle */}
      {isAdmin && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            marginBottom: 24,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              background: 'rgba(19,21,29,0.9)',
              border: `1px solid ${COLORS.border}`,
              borderRadius: 10,
              padding: 4,
            }}
          >
            <ToggleButton
              label="Customer Docs"
              active={docMode === 'customer'}
              onClick={() => setDocMode('customer')}
            />
            <ToggleButton
              label="Full API Reference"
              active={docMode === 'fullref'}
              onClick={() => setDocMode('fullref')}
            />
          </div>
        </div>
      )}

      {docMode === 'customer' ? <CustomerDocs /> : <FullRefPanel />}
    </div>
  );
}
