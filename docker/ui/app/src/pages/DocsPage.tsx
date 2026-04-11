import { useState, useCallback } from 'react';
import {
  ChevronDown,
  Copy,
  Check,
  Key,
  Phone,
  Network,
  Code,
  Terminal,
} from 'lucide-react';
import { PortalHeader } from './RcfPage';
import { IconDocs } from '../components/icons/ProductIcons';

/* ─── Design tokens ──────────────────────────────────────── */

const C = {
  bg: '#13151d',
  surface: '#1a1d27',
  surfaceAlt: '#1e2130',
  border: 'rgba(42,47,69,0.6)',
  borderSubtle: 'rgba(42,47,69,0.35)',
  text: '#e2e8f0',
  textMuted: '#94a3b8',
  textFaint: '#4a5568',
  accent: '#3b82f6',
  green: '#22c55e',
  purple: '#a855f7',
  amber: '#f59e0b',
  red: '#ef4444',
  codeBg: '#0d1117',
  codeKey: '#79c0ff',
  codeStr: '#a5d6ff',
  codeComment: '#6e7681',
  codeKeyword: '#ff7b72',
  codeNumber: '#f0883e',
  codePunct: '#8b949e',
};

/* ─── Tokenizer ──────────────────────────────────────────── */

type Token = { text: string; color?: string };

function tokenizeLine(line: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  function push(text: string, color?: string) {
    if (text) tokens.push({ text, color });
  }

  while (i < line.length) {
    const ch = line[i];

    // Comment
    if ((ch === '#' || (ch === '/' && line[i + 1] === '/')) && tokens.every(t => !t.color || t.color !== C.codeStr)) {
      push(line.slice(i), C.codeComment);
      return tokens;
    }

    // String
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) {
        if (line[j] === '\\') j++;
        j++;
      }
      const str = line.slice(i, j + 1);
      const after = line.slice(j + 1).trimStart();
      const isKey = after.startsWith(':');
      push(str, isKey ? C.codeKey : C.codeStr);
      i = j + 1;
      continue;
    }

    // XML/HTML tag
    if (ch === '<') {
      const match = line.slice(i).match(/^<\/?[A-Za-z][^>]*>/);
      if (match) {
        push(match[0], C.codeKeyword);
        i += match[0].length;
        continue;
      }
    }

    // curl flags
    if (ch === '-' && (i === 0 || line[i - 1] === ' ')) {
      const match = line.slice(i).match(/^(?:--?[A-Za-z][A-Za-z-]*)/);
      if (match) {
        push(match[0], C.codeKeyword);
        i += match[0].length;
        continue;
      }
    }

    // Numbers (standalone)
    if (/[0-9]/.test(ch) && (i === 0 || /[\s,:[{(]/.test(line[i - 1]))) {
      const match = line.slice(i).match(/^[0-9]+\.?[0-9]*/);
      if (match) {
        push(match[0], C.codeNumber);
        i += match[0].length;
        continue;
      }
    }

    // Keywords: true, false, null
    if (/[a-z]/.test(ch)) {
      const match = line.slice(i).match(/^(true|false|null|undefined)\b/);
      if (match) {
        push(match[0], C.codeNumber);
        i += match[0].length;
        continue;
      }
    }

    // HTTP methods
    if (/[A-Z]/.test(ch)) {
      const match = line.slice(i).match(/^(GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)\b/);
      if (match) {
        push(match[0], '#ff7b72');
        i += match[0].length;
        continue;
      }
    }

    // Punctuation
    if ('{}[](),;'.includes(ch)) {
      push(ch, C.codePunct);
      i++;
      continue;
    }

    push(ch);
    i++;
  }

  return tokens;
}

/* ─── CodeBlock ──────────────────────────────────────────── */

function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  const lines = code.split('\n');

  return (
    <div
      style={{
        position: 'relative',
        borderRadius: 10,
        overflow: 'hidden',
        border: `1px solid rgba(48,54,82,0.8)`,
        marginTop: 10,
        marginBottom: 6,
      }}
    >
      {/* Top bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '7px 14px',
          background: 'rgba(22,27,34,0.95)',
          borderBottom: `1px solid rgba(48,54,82,0.6)`,
        }}
      >
        <div style={{ display: 'flex', gap: 6 }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#ff5f57' }} />
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#febc2e' }} />
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#28c840' }} />
        </div>
        {label && (
          <span style={{ fontSize: '0.68rem', color: C.codeComment, letterSpacing: '0.04em', fontFamily: 'monospace' }}>
            {label}
          </span>
        )}
        <button
          type="button"
          onClick={handleCopy}
          title="Copy to clipboard"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            padding: '3px 9px',
            borderRadius: 5,
            fontSize: '0.7rem',
            fontWeight: 600,
            background: copied ? 'rgba(34,197,94,0.12)' : 'rgba(48,54,82,0.5)',
            color: copied ? C.green : C.textMuted,
            border: `1px solid ${copied ? 'rgba(34,197,94,0.25)' : 'rgba(48,54,82,0.8)'}`,
            cursor: 'pointer',
            transition: 'all 0.15s',
            letterSpacing: '0.04em',
          }}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <pre
        style={{
          margin: 0,
          padding: '18px 22px',
          background: C.codeBg,
          fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
          fontSize: '0.79rem',
          lineHeight: 1.8,
          color: '#c9d1d9',
          overflowX: 'auto',
          whiteSpace: 'pre',
        }}
      >
        {lines.map((line, li) => {
          const toks = tokenizeLine(line);
          return (
            <span key={li}>
              {toks.map((t, ti) =>
                t.color
                  ? <span key={ti} style={{ color: t.color }}>{t.text}</span>
                  : <span key={ti}>{t.text}</span>
              )}
              {li < lines.length - 1 ? '\n' : ''}
            </span>
          );
        })}
      </pre>
    </div>
  );
}

/* ─── Shared sub-components ──────────────────────────────── */

function HttpBadge({ method }: { method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' }) {
  const palette: Record<string, { bg: string; fg: string }> = {
    GET:    { bg: 'rgba(34,197,94,0.1)',   fg: '#4ade80' },
    POST:   { bg: 'rgba(59,130,246,0.12)', fg: '#60a5fa' },
    PUT:    { bg: 'rgba(245,158,11,0.12)', fg: '#fbbf24' },
    DELETE: { bg: 'rgba(239,68,68,0.12)',  fg: '#f87171' },
    PATCH:  { bg: 'rgba(168,85,247,0.12)', fg: '#c084fc' },
  };
  const { bg, fg } = palette[method] ?? palette.GET;
  return (
    <span
      style={{
        display: 'inline-block',
        minWidth: 56,
        padding: '2px 9px',
        borderRadius: 4,
        fontSize: '0.67rem',
        fontWeight: 800,
        letterSpacing: '0.07em',
        background: bg,
        color: fg,
        fontFamily: 'monospace',
        textAlign: 'center',
        flexShrink: 0,
      }}
    >
      {method}
    </span>
  );
}

function Endpoint({
  method,
  path,
  description,
}: {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  description: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        padding: '12px 16px',
        borderRadius: 8,
        background: 'rgba(13,17,23,0.6)',
        border: `1px solid ${C.borderSubtle}`,
        marginBottom: 8,
      }}
    >
      <HttpBadge method={method} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <code
          style={{
            fontSize: '0.81rem',
            color: '#79c0ff',
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            display: 'block',
            marginBottom: 3,
          }}
        >
          {path}
        </code>
        <p style={{ margin: 0, fontSize: '0.82rem', color: C.textMuted, lineHeight: 1.5 }}>
          {description}
        </p>
      </div>
    </div>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ margin: '0 0 14px', fontSize: '0.875rem', color: C.textMuted, lineHeight: 1.75 }}>
      {children}
    </p>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{
        margin: '28px 0 10px',
        fontSize: '0.72rem',
        fontWeight: 700,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: C.textFaint,
      }}
    >
      {children}
    </h3>
  );
}

function IC({ children }: { children: React.ReactNode }) {
  return (
    <code
      style={{
        background: 'rgba(13,17,23,0.7)',
        border: `1px solid ${C.borderSubtle}`,
        borderRadius: 4,
        padding: '1px 6px',
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: '0.78rem',
        color: '#79c0ff',
      }}
    >
      {children}
    </code>
  );
}

interface ParamRow {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

function ParamTable({ rows }: { rows: ParamRow[] }) {
  return (
    <div
      style={{
        borderRadius: 8,
        overflow: 'hidden',
        border: `1px solid ${C.borderSubtle}`,
        marginBottom: 16,
      }}
    >
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
        <thead>
          <tr style={{ background: 'rgba(13,17,23,0.7)' }}>
            {['Parameter', 'Type', 'Required', 'Description'].map(h => (
              <th
                key={h}
                style={{
                  padding: '9px 14px',
                  textAlign: 'left',
                  color: C.textFaint,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  fontSize: '0.67rem',
                  textTransform: 'uppercase',
                  borderBottom: `1px solid ${C.borderSubtle}`,
                  whiteSpace: 'nowrap',
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
              style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(13,17,23,0.25)' }}
            >
              <td style={{ padding: '9px 14px', borderBottom: `1px solid ${C.borderSubtle}`, whiteSpace: 'nowrap' }}>
                <code style={{ color: '#79c0ff', fontFamily: 'monospace', fontSize: '0.78rem' }}>
                  {row.name}
                </code>
              </td>
              <td style={{ padding: '9px 14px', borderBottom: `1px solid ${C.borderSubtle}`, whiteSpace: 'nowrap' }}>
                <span style={{ color: '#f0883e', fontFamily: 'monospace', fontSize: '0.78rem' }}>
                  {row.type}
                </span>
              </td>
              <td style={{ padding: '9px 14px', borderBottom: `1px solid ${C.borderSubtle}` }}>
                <span
                  style={{
                    fontSize: '0.68rem',
                    fontWeight: 700,
                    letterSpacing: '0.05em',
                    color: row.required ? '#f87171' : C.textFaint,
                    background: row.required ? 'rgba(239,68,68,0.08)' : 'rgba(74,85,104,0.12)',
                    padding: '1px 7px',
                    borderRadius: 4,
                  }}
                >
                  {row.required ? 'required' : 'optional'}
                </span>
              </td>
              <td style={{ padding: '9px 14px', borderBottom: `1px solid ${C.borderSubtle}`, color: C.textMuted, lineHeight: 1.5 }}>
                {row.description}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface TierRow {
  tier: string;
  cps: string;
  perCall: string;
  monthly: string;
  highlight?: boolean;
}

function TierTable({ rows }: { rows: TierRow[] }) {
  return (
    <div
      style={{
        borderRadius: 8,
        overflow: 'hidden',
        border: `1px solid ${C.borderSubtle}`,
        marginBottom: 16,
      }}
    >
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
        <thead>
          <tr style={{ background: 'rgba(13,17,23,0.7)' }}>
            {['Tier', 'Max CPS', 'Per-Call Fee', 'Monthly'].map(h => (
              <th
                key={h}
                style={{
                  padding: '9px 14px',
                  textAlign: 'left',
                  color: C.textFaint,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  fontSize: '0.67rem',
                  textTransform: 'uppercase',
                  borderBottom: `1px solid ${C.borderSubtle}`,
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
              style={{
                background: row.highlight
                  ? 'rgba(168,85,247,0.06)'
                  : i % 2 === 0 ? 'transparent' : 'rgba(13,17,23,0.25)',
              }}
            >
              <td style={{ padding: '10px 14px', borderBottom: `1px solid ${C.borderSubtle}` }}>
                <span
                  style={{
                    color: row.highlight ? C.purple : C.text,
                    fontWeight: row.highlight ? 700 : 400,
                  }}
                >
                  {row.tier}
                </span>
                {row.highlight && (
                  <span
                    style={{
                      marginLeft: 8,
                      fontSize: '0.65rem',
                      fontWeight: 700,
                      color: C.purple,
                      background: 'rgba(168,85,247,0.12)',
                      padding: '1px 6px',
                      borderRadius: 4,
                      letterSpacing: '0.06em',
                    }}
                  >
                    POPULAR
                  </span>
                )}
              </td>
              <td style={{ padding: '10px 14px', borderBottom: `1px solid ${C.borderSubtle}`, color: C.text, fontFamily: 'monospace' }}>
                {row.cps}
              </td>
              <td style={{ padding: '10px 14px', borderBottom: `1px solid ${C.borderSubtle}`, color: C.textMuted }}>
                {row.perCall}
              </td>
              <td style={{ padding: '10px 14px', borderBottom: `1px solid ${C.borderSubtle}`, color: C.textMuted }}>
                {row.monthly}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ─── Request/Response pair ──────────────────────────────── */

function ReqRes({ request, response }: { request: string; response: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 4 }}>
      <div>
        <div style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.08em', color: C.textFaint, textTransform: 'uppercase', marginBottom: 4 }}>
          Request
        </div>
        <CodeBlock code={request} />
      </div>
      <div>
        <div style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.08em', color: C.textFaint, textTransform: 'uppercase', marginBottom: 4 }}>
          Response
        </div>
        <CodeBlock code={response} />
      </div>
    </div>
  );
}

/* ─── Collapsible accordion section ─────────────────────── */

interface AccordionSectionProps {
  id: string;
  accent: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

function AccordionSection({
  accent,
  icon,
  title,
  subtitle,
  children,
  defaultOpen = false,
}: AccordionSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div
      style={{
        border: `1px solid ${open ? accent + '40' : C.border}`,
        borderRadius: 14,
        overflow: 'hidden',
        marginBottom: 20,
        transition: 'border-color 0.2s',
        background: `linear-gradient(135deg, ${C.surface} 0%, ${C.surfaceAlt} 100%)`,
      }}
    >
      {/* Header bar */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '20px 28px',
          background: open
            ? `linear-gradient(90deg, ${accent}0d 0%, transparent 60%)`
            : 'transparent',
          border: 'none',
          borderBottom: open ? `1px solid ${accent}25` : '1px solid transparent',
          cursor: 'pointer',
          textAlign: 'left',
          transition: 'background 0.2s',
        }}
      >
        {/* Icon badge */}
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: `linear-gradient(135deg, ${accent}20 0%, ${accent}08 100%)`,
            border: `1px solid ${accent}35`,
            color: accent,
            flexShrink: 0,
          }}
        >
          {icon}
        </div>

        {/* Title + subtitle */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: '1.05rem',
              fontWeight: 700,
              color: C.text,
              letterSpacing: '-0.01em',
              marginBottom: 2,
            }}
          >
            {title}
          </div>
          <div style={{ fontSize: '0.82rem', color: C.textMuted, lineHeight: 1.4 }}>
            {subtitle}
          </div>
        </div>

        {/* Chevron */}
        <div
          style={{
            color: accent,
            flexShrink: 0,
            transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 0.2s',
          }}
        >
          <ChevronDown size={20} />
        </div>
      </button>

      {/* Collapsible body */}
      {open && (
        <div style={{ padding: '28px 32px' }}>
          {children}
        </div>
      )}
    </div>
  );
}

/* ─── Callout box ────────────────────────────────────────── */

function Callout({
  accent,
  children,
}: {
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: '14px 18px',
        borderRadius: 8,
        background: `${accent}0a`,
        border: `1px solid ${accent}25`,
        marginBottom: 16,
        fontSize: '0.84rem',
        color: C.textMuted,
        lineHeight: 1.65,
      }}
    >
      <div style={{ color: accent, flexShrink: 0, marginTop: 1 }}>
        <Terminal size={14} />
      </div>
      <div>{children}</div>
    </div>
  );
}

/* ─── Auth section (always visible) ─────────────────────── */

function AuthSection() {
  return (
    <div
      style={{
        background: `linear-gradient(135deg, ${C.surface} 0%, ${C.surfaceAlt} 100%)`,
        border: `1px solid ${C.border}`,
        borderRadius: 14,
        overflow: 'hidden',
        marginBottom: 28,
      }}
    >
      {/* Top accent */}
      <div
        style={{
          height: 2,
          background: `linear-gradient(90deg, transparent, ${C.accent}, transparent)`,
          opacity: 0.5,
        }}
      />

      <div style={{ padding: '28px 32px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: `linear-gradient(135deg, ${C.accent}20 0%, ${C.accent}08 100%)`,
              border: `1px solid ${C.accent}30`,
              color: C.accent,
              flexShrink: 0,
            }}
          >
            <Key size={18} />
          </div>
          <div>
            <h2
              style={{
                fontSize: '1rem',
                fontWeight: 700,
                color: C.text,
                margin: 0,
                letterSpacing: '-0.01em',
              }}
            >
              Authentication
            </h2>
            <p style={{ margin: 0, fontSize: '0.8rem', color: C.textMuted }}>
              JWT Bearer token — required on every request
            </p>
          </div>
        </div>

        {/* Base URL + auth method */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 12,
            marginBottom: 24,
          }}
        >
          {[
            { label: 'Base URL', value: '/api/v1' },
            { label: 'Auth Header', value: 'Authorization: Bearer <token>' },
          ].map(({ label, value }) => (
            <div
              key={label}
              style={{
                padding: '14px 18px',
                borderRadius: 8,
                background: 'rgba(13,17,23,0.55)',
                border: `1px solid ${C.borderSubtle}`,
              }}
            >
              <div style={{ fontSize: '0.67rem', fontWeight: 700, color: C.textFaint, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
                {label}
              </div>
              <code style={{ fontFamily: 'monospace', fontSize: '0.82rem', color: '#79c0ff' }}>
                {value}
              </code>
            </div>
          ))}
        </div>

        <P>
          All endpoints are protected by JWT authentication. To obtain a token, <IC>POST</IC> your credentials to <IC>/api/v1/auth/login</IC>. The token returned must be included in the <IC>Authorization</IC> header of every subsequent request. Tokens expire after 24 hours.
        </P>

        <H3>Step 1 — Obtain a token</H3>
        <ReqRes
          request={`curl -X POST https://{host}/api/v1/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{
    "username": "your@email.com",
    "password": "your-password"
  }'`}
          response={`{
  "access_token": "eyJhbGciOiJIUzI1NiIsIn...",
  "token_type": "bearer",
  "expires_in": 86400
}`}
        />

        <H3>Step 2 — Authenticate requests</H3>
        <CodeBlock
          label="All subsequent requests"
          code={`curl -X GET https://{host}/api/v1/rcf \\
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsIn..." \\
  -H "Content-Type: application/json"`}
        />

        <Callout accent={C.accent}>
          Store your token securely. Never log it, commit it to version control, or expose it in client-side JavaScript. If compromised, contact your platform administrator to revoke and reissue credentials.
        </Callout>
      </div>
    </div>
  );
}

/* ─── Section 1: RCF ─────────────────────────────────────── */

function RcfSection() {
  return (
    <AccordionSection
      id="rcf"
      accent={C.green}
      icon={<Phone size={18} />}
      title="RCF — Remote Call Forwarding"
      subtitle="Manage phone number forwarding. Create, update, and delete RCF numbers that route incoming calls to any destination."
      defaultOpen
    >
      <P>
        RCF numbers are DIDs (Direct Inward Dial numbers) that forward all incoming calls to a configurable destination — another phone number, SIP address, or extension. Use the RCF API to provision numbers, change forwarding targets in real time, set ring timeouts, and configure failover behavior without portal access.
      </P>

      <Callout accent={C.green}>
        All phone numbers must be in E.164 format: a leading <IC>+</IC>, country code, then subscriber number. US example: <IC>+15087282017</IC>. Extensions are expressed as short numeric strings (e.g. <IC>1001</IC>).
      </Callout>

      <H3>Endpoints</H3>

      <Endpoint method="POST"   path="/api/v1/rcf"       description="Create a new RCF number and configure its forwarding destination." />
      <Endpoint method="GET"    path="/api/v1/rcf"       description="List all RCF numbers. Filter by customer_id or enabled status." />
      <Endpoint method="GET"    path="/api/v1/rcf/{did}" description="Retrieve a single RCF record by its E.164 DID." />
      <Endpoint method="PUT"    path="/api/v1/rcf/{did}" description="Update forwarding destination, name, ring timeout, failover, or enabled state." />
      <Endpoint method="DELETE" path="/api/v1/rcf/{did}" description="Permanently delete an RCF number and stop all forwarding." />

      {/* Create */}
      <H3>Create RCF — POST /api/v1/rcf</H3>
      <ParamTable
        rows={[
          { name: 'customer_id',    type: 'integer', required: true,  description: 'Your account customer ID.' },
          { name: 'did',            type: 'string',  required: true,  description: 'The inbound DID in E.164 format (+1XXXXXXXXXX).' },
          { name: 'forward_to',     type: 'string',  required: true,  description: 'Destination in E.164 format or numeric extension.' },
          { name: 'name',           type: 'string',  required: false, description: 'Friendly label for this RCF entry.' },
          { name: 'pass_caller_id', type: 'boolean', required: false, description: 'If true, the original caller\'s number is passed through. If false, the RCF DID is shown as the caller ID. Default: true.' },
          { name: 'ring_timeout',   type: 'integer', required: false, description: 'Seconds to ring before failing over. Range: 5–120. Default: 30.' },
          { name: 'failover_to',    type: 'string',  required: false, description: 'If set, calls route here when ring_timeout expires (E.164 or extension).' },
        ]}
      />

      <div style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.08em', color: C.textFaint, textTransform: 'uppercase', marginBottom: 6 }}>
        Example — Create RCF number
      </div>
      <ReqRes
        request={`curl -X POST https://{host}/api/v1/rcf \\
  -H "Authorization: Bearer {token}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "customer_id": 1042,
    "did": "+15087282017",
    "forward_to": "+16175550100",
    "name": "Boston Sales Line",
    "pass_caller_id": true,
    "ring_timeout": 25,
    "failover_to": "+18005550199"
  }'`}
        response={`{
  "id": 8841,
  "did": "+15087282017",
  "forward_to": "+16175550100",
  "name": "Boston Sales Line",
  "pass_caller_id": true,
  "ring_timeout": 25,
  "failover_to": "+18005550199",
  "enabled": true,
  "customer_id": 1042,
  "created_at": "2026-04-10T14:22:01Z"
}`}
      />

      {/* List */}
      <H3>List RCF Numbers — GET /api/v1/rcf</H3>
      <P>
        Returns all RCF numbers. Use query parameters to filter results.
      </P>
      <ParamTable
        rows={[
          { name: 'customer_id', type: 'integer', required: false, description: 'Filter to a specific customer.' },
          { name: 'enabled',     type: 'boolean', required: false, description: 'Filter by active/inactive status.' },
        ]}
      />
      <CodeBlock
        label="GET /api/v1/rcf?customer_id=1042"
        code={`curl -X GET "https://{host}/api/v1/rcf?customer_id=1042&enabled=true" \\
  -H "Authorization: Bearer {token}"`}
      />

      {/* Update */}
      <H3>Update RCF — PUT /api/v1/rcf/{'{did}'}</H3>
      <P>
        Change where <IC>+15087282017</IC> forwards to, or adjust any configuration. Only fields included in the request body are updated.
      </P>
      <ParamTable
        rows={[
          { name: 'forward_to',     type: 'string',  required: false, description: 'New forwarding destination (E.164 or extension).' },
          { name: 'name',           type: 'string',  required: false, description: 'Updated friendly label.' },
          { name: 'ring_timeout',   type: 'integer', required: false, description: 'Ring timeout in seconds (5–120).' },
          { name: 'failover_to',    type: 'string',  required: false, description: 'Updated failover destination.' },
          { name: 'enabled',        type: 'boolean', required: false, description: 'Enable or disable this RCF number.' },
          { name: 'pass_caller_id', type: 'boolean', required: false, description: 'Toggle caller ID pass-through.' },
        ]}
      />

      <div style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.08em', color: C.textFaint, textTransform: 'uppercase', marginBottom: 6 }}>
        Example — Change where +15087282017 forwards to
      </div>
      <ReqRes
        request={`curl -X PUT https://{host}/api/v1/rcf/%2B15087282017 \\
  -H "Authorization: Bearer {token}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "forward_to": "+16175559999",
    "ring_timeout": 40
  }'`}
        response={`{
  "id": 8841,
  "did": "+15087282017",
  "forward_to": "+16175559999",
  "name": "Boston Sales Line",
  "pass_caller_id": true,
  "ring_timeout": 40,
  "failover_to": "+18005550199",
  "enabled": true,
  "updated_at": "2026-04-10T16:05:33Z"
}`}
      />

      <Callout accent={C.green}>
        URL-encode the DID when using it as a path parameter. The <IC>+</IC> character must be encoded as <IC>%2B</IC>. Example: <IC>/api/v1/rcf/%2B15087282017</IC>
      </Callout>

      {/* Behavior notes */}
      <H3>Behavior Notes</H3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 4 }}>
        {[
          {
            title: 'Failover',
            body: 'If ring_timeout expires and failover_to is set, the call is immediately rerouted to that destination. If failover_to is not set, the call goes to the default voicemail treatment.',
          },
          {
            title: 'pass_caller_id',
            body: 'When true, the original PSTN caller ID is preserved end-to-end. When false, the called party sees the RCF DID as the incoming caller ID — useful for call tracking numbers.',
          },
          {
            title: 'Ring Timeout',
            body: 'Valid range is 5–120 seconds. Setting below 5 or above 120 returns a 422 validation error. The default is 30 seconds if not specified at creation.',
          },
          {
            title: 'E.164 Format',
            body: 'All number fields require E.164 format. US numbers: +1 followed by 10 digits. International: + followed by country code and subscriber number. No spaces or dashes.',
          },
        ].map(({ title, body }) => (
          <div
            key={title}
            style={{
              padding: '14px 16px',
              borderRadius: 8,
              background: 'rgba(34,197,94,0.04)',
              border: `1px solid rgba(34,197,94,0.15)`,
            }}
          >
            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: C.green, marginBottom: 6 }}>
              {title}
            </div>
            <div style={{ fontSize: '0.81rem', color: C.textMuted, lineHeight: 1.6 }}>
              {body}
            </div>
          </div>
        ))}
      </div>
    </AccordionSection>
  );
}

/* ─── Section 2: SIP Trunking ────────────────────────────── */

function SipTrunkingSection() {
  return (
    <AccordionSection
      id="sip"
      accent={C.amber}
      icon={<Network size={18} />}
      title="SIP Trunking"
      subtitle="Manage SIP trunks for connecting your PBX to the PSTN. Configure capacity, IP authentication, and DIDs."
    >
      <P>
        SIP trunks provide the gateway between your IP PBX, softswitch, or contact center platform and the public telephone network. Use the Trunks API to provision capacity, authorize your PBX IP addresses, assign DIDs, and monitor real-time utilization — all without a support ticket.
      </P>

      <Callout accent={C.amber}>
        Trunk <IC>auth_type</IC> controls how your PBX authenticates inbound registrations: <IC>ip</IC> (source IP whitelist only), <IC>credential</IC> (SIP username/password), or <IC>both</IC> (IP must be whitelisted AND credentials must match).
      </Callout>

      {/* Core trunk endpoints */}
      <H3>Trunk Endpoints</H3>

      <Endpoint method="POST" path="/api/v1/trunks"          description="Create a new SIP trunk for a customer." />
      <Endpoint method="GET"  path="/api/v1/trunks"          description="List all SIP trunks. Filter by customer_id." />
      <Endpoint method="GET"  path="/api/v1/trunks/{id}"     description="Get full configuration details for a single trunk." />
      <Endpoint method="PUT"  path="/api/v1/trunks/{id}"     description="Update trunk name, channel capacity, CPS limit, or enabled state." />
      <Endpoint method="GET"  path="/api/v1/trunks/{id}/stats" description="Real-time trunk statistics: active channels, utilization %, ASR, ACD." />

      <H3>Create Trunk — POST /api/v1/trunks</H3>
      <ParamTable
        rows={[
          { name: 'customer_id', type: 'integer', required: true,  description: 'Customer account this trunk belongs to.' },
          { name: 'trunk_name',  type: 'string',  required: true,  description: 'Friendly identifier for the trunk (e.g. "HQ PBX - Primary").' },
          { name: 'max_channels',type: 'integer', required: true,  description: 'Maximum simultaneous calls allowed on this trunk.' },
          { name: 'cps_limit',   type: 'integer', required: true,  description: 'Max call attempts per second (CPS). Excess attempts receive 503.' },
          { name: 'auth_type',   type: 'string',  required: true,  description: 'One of: ip | credential | both.' },
        ]}
      />

      <div style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.08em', color: C.textFaint, textTransform: 'uppercase', marginBottom: 6 }}>
        Example — Set up a trunk with 100 channels and IP auth
      </div>
      <ReqRes
        request={`curl -X POST https://{host}/api/v1/trunks \\
  -H "Authorization: Bearer {token}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "customer_id": 1042,
    "trunk_name": "HQ PBX - Primary",
    "max_channels": 100,
    "cps_limit": 10,
    "auth_type": "ip"
  }'`}
        response={`{
  "id": 221,
  "trunk_name": "HQ PBX - Primary",
  "customer_id": 1042,
  "max_channels": 100,
  "cps_limit": 10,
  "auth_type": "ip",
  "enabled": true,
  "sip_domain": "hq-pbx.sip.platform.net",
  "created_at": "2026-04-10T14:30:00Z"
}`}
      />

      {/* Real-time stats */}
      <H3>Real-Time Stats — GET /api/v1/trunks/{'{id}'}/stats</H3>
      <CodeBlock
        label="Response"
        code={`{
  "trunk_id": 221,
  "active_channels": 34,
  "max_channels": 100,
  "utilization_pct": 34.0,
  "calls_per_second": 2,
  "asr_pct": 96.4,
  "acd_seconds": 187,
  "as_of": "2026-04-10T16:00:01Z"
}`}
      />

      {/* IP Auth */}
      <H3>IP Authentication</H3>
      <P>
        When <IC>auth_type</IC> is <IC>ip</IC> or <IC>both</IC>, only SIP INVITE requests from whitelisted IP addresses are accepted. Add the public IP of your PBX after creating the trunk.
      </P>

      <Endpoint method="POST"   path="/api/v1/trunks/{id}/ips"          description="Whitelist an IP address for this trunk." />
      <Endpoint method="GET"    path="/api/v1/trunks/{id}/ips"          description="List all authorized IP addresses." />
      <Endpoint method="DELETE" path="/api/v1/trunks/{id}/ips/{ip_id}"  description="Remove an IP address from the whitelist." />

      <ParamTable
        rows={[
          { name: 'ip_address',  type: 'string', required: true,  description: 'IPv4 or IPv6 address of the PBX (e.g. 203.0.113.10).' },
          { name: 'description', type: 'string', required: false, description: 'Label for this IP (e.g. "Primary WAN" or "Backup link").' },
        ]}
      />
      <ReqRes
        request={`curl -X POST https://{host}/api/v1/trunks/221/ips \\
  -H "Authorization: Bearer {token}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "ip_address": "203.0.113.10",
    "description": "Primary WAN"
  }'`}
        response={`{
  "id": 55,
  "trunk_id": 221,
  "ip_address": "203.0.113.10",
  "description": "Primary WAN",
  "created_at": "2026-04-10T14:35:00Z"
}`}
      />

      {/* DID Management */}
      <H3>DID Management</H3>
      <P>
        Assign DIDs to a trunk so that inbound calls to those numbers are delivered via that trunk's SIP connection.
      </P>

      <Endpoint method="POST" path="/api/v1/trunks/{id}/dids" description="Assign a DID to this trunk." />
      <Endpoint method="GET"  path="/api/v1/trunks/{id}/dids" description="List all DIDs assigned to this trunk." />

      <ReqRes
        request={`curl -X POST https://{host}/api/v1/trunks/221/dids \\
  -H "Authorization: Bearer {token}" \\
  -H "Content-Type: application/json" \\
  -d '{ "did": "+16175550199" }'`}
        response={`{
  "trunk_id": 221,
  "did": "+16175550199",
  "assigned_at": "2026-04-10T14:40:00Z"
}`}
      />

      {/* Call Path Packages */}
      <H3>Call Path Packages</H3>
      <P>
        Call path packages define the maximum number of concurrent calls (channels) and associated rate card. Browse available packages and assign one to a trunk to change its capacity tier.
      </P>

      <Endpoint method="GET" path="/api/v1/trunks/call-paths"         description="List all available call path packages and pricing." />
      <Endpoint method="PUT" path="/api/v1/trunks/{id}/call-paths"    description="Assign a call path package to this trunk." />

      <ParamTable
        rows={[
          { name: 'package_id', type: 'integer', required: true, description: 'ID of the call path package to assign (from GET /call-paths).' },
        ]}
      />

      {/* Behavior notes */}
      <H3>Capacity & Rate Limiting</H3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {[
          {
            title: 'Channel Capacity',
            body: 'max_channels is a hard limit. When the trunk is at capacity, new INVITEs are rejected with SIP 503. Use the /stats endpoint to monitor utilization and scale proactively.',
          },
          {
            title: 'CPS Rate Limiting',
            body: 'cps_limit throttles call attempt bursts. If your PBX sends more than the configured CPS, excess attempts receive SIP 429. Recommended starting point: 1 CPS per 10 channels.',
          },
          {
            title: 'Auth Type: ip',
            body: 'Only requests from whitelisted IPs are accepted. Best for static PBX installations. No SIP credentials are required or checked.',
          },
          {
            title: 'Auth Type: both',
            body: 'IP must be whitelisted AND valid SIP credentials must be provided. Most secure — recommended for trunks serving multiple locations.',
          },
        ].map(({ title, body }) => (
          <div
            key={title}
            style={{
              padding: '14px 16px',
              borderRadius: 8,
              background: 'rgba(245,158,11,0.04)',
              border: `1px solid rgba(245,158,11,0.15)`,
            }}
          >
            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: C.amber, marginBottom: 6 }}>
              {title}
            </div>
            <div style={{ fontSize: '0.81rem', color: C.textMuted, lineHeight: 1.6 }}>
              {body}
            </div>
          </div>
        ))}
      </div>
    </AccordionSection>
  );
}

/* ─── Section 3: API Calling ─────────────────────────────── */

function ApiCallingSection() {
  return (
    <AccordionSection
      id="api-calling"
      accent={C.purple}
      icon={<Code size={18} />}
      title="API Calling — Programmable Voice"
      subtitle="Build voice applications with programmable DIDs and call origination. Receive webhooks for inbound calls and initiate outbound calls via API."
    >
      <P>
        Programmable Voice lets you attach a webhook URL to any DID so that every inbound call fetches XML/TwiML instructions from your server — enabling dynamic call routing, IVR menus, recording, conferencing, and more. You can also originate outbound calls programmatically and modify live calls in flight.
      </P>

      <Callout accent={C.purple}>
        Your <IC>voice_url</IC> must return valid TwiML XML within 10 seconds. The platform will retry with a <IC>GET</IC> if the initial <IC>POST</IC> fails. If both attempts fail, the call receives a platform error treatment.
      </Callout>

      {/* DID Management */}
      <H3>API DID Management</H3>
      <P>
        API DIDs are phone numbers with a webhook attached. When a call arrives, your <IC>voice_url</IC> is fetched and the returned TwiML is executed to handle the call.
      </P>

      <Endpoint method="POST"   path="/api/v1/api-dids"       description="Create an API DID and attach a voice webhook URL." />
      <Endpoint method="GET"    path="/api/v1/api-dids"       description="List all API DIDs for your account." />
      <Endpoint method="GET"    path="/api/v1/api-dids/{did}" description="Get configuration for a single API DID." />
      <Endpoint method="PUT"    path="/api/v1/api-dids/{did}" description="Update voice_url, status_callback, or enabled state." />
      <Endpoint method="DELETE" path="/api/v1/api-dids/{did}" description="Remove API DID and stop webhook delivery." />

      <H3>Create API DID — POST /api/v1/api-dids</H3>
      <ParamTable
        rows={[
          { name: 'customer_id',      type: 'integer', required: true,  description: 'Customer account this DID belongs to.' },
          { name: 'did',              type: 'string',  required: true,  description: 'Phone number in E.164 format (+1XXXXXXXXXX).' },
          { name: 'voice_url',        type: 'string',  required: true,  description: 'HTTPS URL that returns TwiML for inbound call handling.' },
          { name: 'status_callback',  type: 'string',  required: false, description: 'HTTPS URL to receive call lifecycle status events (ringing, answered, completed, failed).' },
        ]}
      />

      <ReqRes
        request={`curl -X POST https://{host}/api/v1/api-dids \\
  -H "Authorization: Bearer {token}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "customer_id": 1042,
    "did": "+16175550300",
    "voice_url": "https://yourapp.com/voice/inbound",
    "status_callback": "https://yourapp.com/voice/status"
  }'`}
        response={`{
  "id": 77,
  "did": "+16175550300",
  "customer_id": 1042,
  "voice_url": "https://yourapp.com/voice/inbound",
  "status_callback": "https://yourapp.com/voice/status",
  "enabled": true,
  "created_at": "2026-04-10T15:00:00Z"
}`}
      />

      {/* Inbound webhook */}
      <H3>Inbound Call Webhook</H3>
      <P>
        When a call arrives on your API DID, the platform sends a <IC>POST</IC> to your <IC>voice_url</IC> with these parameters. Your server must respond with TwiML.
      </P>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.08em', color: C.textFaint, textTransform: 'uppercase', marginBottom: 6 }}>
            Webhook POST body
          </div>
          <CodeBlock
            code={`CallSid=CA123abc...
From=%2B16175550100
To=%2B16175550300
CallStatus=ringing
Direction=inbound`}
          />
        </div>
        <div>
          <div style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.08em', color: C.textFaint, textTransform: 'uppercase', marginBottom: 6 }}>
            Your TwiML response
          </div>
          <CodeBlock
            code={`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">
    Welcome. Connecting you now.
  </Say>
  <Dial timeout="30">
    +16175551234
  </Dial>
</Response>`}
          />
        </div>
      </div>

      {/* Call Origination */}
      <H3>Call Origination</H3>
      <P>
        Initiate outbound calls programmatically. The platform dials the <IC>to</IC> number, and when answered, fetches your <IC>webhook_url</IC> for call instructions.
      </P>

      <Endpoint method="POST" path="/api/v1/calls"                   description="Initiate an outbound call." />
      <Endpoint method="GET"  path="/api/v1/calls/{call_id}"         description="Get current status and metadata for a call." />
      <Endpoint method="POST" path="/api/v1/calls/{call_id}/update"  description="Modify a live call: hangup, transfer, or hold." />

      <H3>Originate Call — POST /api/v1/calls</H3>
      <ParamTable
        rows={[
          { name: 'from_did',    type: 'string',  required: true,  description: 'Your API DID to call from (E.164). Must be in your account.' },
          { name: 'to',         type: 'string',  required: true,  description: 'Destination number in E.164 format.' },
          { name: 'webhook_url', type: 'string',  required: false, description: 'URL to fetch TwiML when the call is answered. Falls back to voice_url on the from_did.' },
          { name: 'timeout',     type: 'integer', required: false, description: 'Seconds to ring before giving up. Default: 30, max: 120.' },
          { name: 'caller_id',   type: 'string',  required: false, description: 'Override the caller ID shown to the destination. Must be a verified number in your account.' },
        ]}
      />

      <div style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.08em', color: C.textFaint, textTransform: 'uppercase', marginBottom: 6 }}>
        Example — Make an outbound call and get status updates
      </div>
      <ReqRes
        request={`curl -X POST https://{host}/api/v1/calls \\
  -H "Authorization: Bearer {token}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "from_did": "+16175550300",
    "to": "+18005551234",
    "webhook_url": "https://yourapp.com/voice/answered",
    "timeout": 45,
    "caller_id": "+16175550300"
  }'`}
        response={`{
  "call_id": "CA7f3d2a1b4e5c6d8f",
  "status": "queued",
  "from": "+16175550300",
  "to": "+18005551234",
  "direction": "outbound",
  "created_at": "2026-04-10T16:10:00Z"
}`}
      />

      <H3>Get Call Status — GET /api/v1/calls/{'{call_id}'}</H3>
      <CodeBlock
        label="Response"
        code={`{
  "call_id": "CA7f3d2a1b4e5c6d8f",
  "status": "in-progress",
  "from": "+16175550300",
  "to": "+18005551234",
  "duration": 47,
  "direction": "outbound",
  "answered_at": "2026-04-10T16:10:08Z",
  "ended_at": null
}`}
      />

      <H3>Modify Live Call — POST /api/v1/calls/{'{call_id}'}/update</H3>
      <ParamTable
        rows={[
          { name: 'action', type: 'string', required: true,  description: 'One of: hangup | transfer | hold' },
          { name: 'target', type: 'string', required: false, description: 'Required for transfer action: E.164 number or SIP URI to transfer to.' },
        ]}
      />
      <ReqRes
        request={`curl -X POST https://{host}/api/v1/calls/CA7f3d2a1b4e5c6d8f/update \\
  -H "Authorization: Bearer {token}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "action": "transfer",
    "target": "+16175559000"
  }'`}
        response={`{
  "call_id": "CA7f3d2a1b4e5c6d8f",
  "action": "transfer",
  "target": "+16175559000",
  "status": "transferring"
}`}
      />

      {/* Status callbacks */}
      <H3>Status Callback Events</H3>
      <P>
        When a <IC>status_callback</IC> URL is configured, the platform sends a <IC>POST</IC> for each lifecycle event. Your server must respond with HTTP 200.
      </P>

      <div
        style={{
          borderRadius: 8,
          overflow: 'hidden',
          border: `1px solid ${C.borderSubtle}`,
          marginBottom: 16,
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.81rem' }}>
          <thead>
            <tr style={{ background: 'rgba(13,17,23,0.7)' }}>
              {['Event', 'Description'].map(h => (
                <th
                  key={h}
                  style={{
                    padding: '9px 14px',
                    textAlign: 'left',
                    color: C.textFaint,
                    fontWeight: 700,
                    fontSize: '0.67rem',
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    borderBottom: `1px solid ${C.borderSubtle}`,
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              { event: 'queued',      desc: 'Call has been accepted and is waiting to be dialed.' },
              { event: 'ringing',     desc: 'The destination is ringing.' },
              { event: 'answered',    desc: 'The call was answered. Webhook fetched for call instructions.' },
              { event: 'completed',   desc: 'Call ended normally. duration field is populated.' },
              { event: 'no-answer',   desc: 'Destination rang until timeout without being answered.' },
              { event: 'busy',        desc: 'Destination returned a busy signal (SIP 486).' },
              { event: 'failed',      desc: 'Call could not be completed due to a platform or network error.' },
            ].map((row, i) => (
              <tr key={row.event} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(13,17,23,0.25)' }}>
                <td style={{ padding: '9px 14px', borderBottom: `1px solid ${C.borderSubtle}` }}>
                  <code style={{ color: '#c084fc', fontFamily: 'monospace', fontSize: '0.78rem' }}>
                    {row.event}
                  </code>
                </td>
                <td style={{ padding: '9px 14px', borderBottom: `1px solid ${C.borderSubtle}`, color: C.textMuted }}>
                  {row.desc}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* CPS Tiers */}
      <H3>CPS Tiers</H3>
      <P>
        Outbound call origination is rate-limited by your CPS tier. If you exceed your tier's CPS limit, the API returns <IC>429 Too Many Requests</IC>. Upgrade your tier to support higher origination volume.
      </P>

      <TierTable
        rows={[
          { tier: 'Basic',    cps: '5',  perCall: '$0.010', monthly: 'Included' },
          { tier: 'Standard', cps: '8',  perCall: '$0.008', monthly: '$299',    highlight: true },
          { tier: 'Premium',  cps: '15', perCall: '$0.005', monthly: '$799' },
        ]}
      />

      <Callout accent={C.purple}>
        Receiving a <IC>429</IC> response means you have hit your CPS ceiling for that second. Implement exponential backoff with jitter — wait 1s, 2s, 4s between retries. To permanently increase throughput, contact your account manager to upgrade your CPS tier.
      </Callout>
    </AccordionSection>
  );
}

/* ─── Page root ──────────────────────────────────────────── */

export function DocsPage() {
  return (
    <div className="flex flex-col h-full">
      <PortalHeader
        icon={<IconDocs size={24} />}
        title="API Documentation"
        subtitle="Integrate with the Custom VoIP platform via REST API"
        badgeVariant="api"
      />

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '28px 32px 60px',
          background: C.bg,
        }}
      >
        <div style={{ maxWidth: 1080, margin: '0 auto' }}>

          {/* Page intro */}
          <div style={{ marginBottom: 28 }}>
            <h1
              style={{
                fontSize: '1.6rem',
                fontWeight: 800,
                color: C.text,
                margin: '0 0 8px',
                letterSpacing: '-0.02em',
              }}
            >
              API Documentation
            </h1>
            <p style={{ margin: 0, fontSize: '0.92rem', color: C.textMuted, lineHeight: 1.6 }}>
              Full self-service reference for RCF, SIP Trunking, and Programmable Voice. All endpoints require JWT authentication.
            </p>
          </div>

          {/* Always-visible auth section */}
          <AuthSection />

          {/* Collapsible product sections */}
          <RcfSection />
          <SipTrunkingSection />
          <ApiCallingSection />

        </div>
      </div>
    </div>
  );
}
