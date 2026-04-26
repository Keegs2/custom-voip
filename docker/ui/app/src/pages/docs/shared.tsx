/**
 * Shared design tokens, helper components, and layout primitives used across
 * all three documentation pages (RCF Docs, API Reference, Integration Guide).
 *
 * Keep this file free of page-specific content — it is pure shared infrastructure.
 */

import { useState } from 'react';
import { ChevronDown, Info } from 'lucide-react';

/* ─── Design tokens ──────────────────────────────────────── */

export const C = {
  bg: '#13151d',
  surface: '#1a1d27',
  surfaceAlt: '#1e2130',
  border: 'rgba(42,47,69,0.6)',
  borderSubtle: 'rgba(42,47,69,0.35)',
  text: '#e2e8f0',
  textMuted: '#94a3b8',
  textFaint: '#4a5568',
  accent: '#3b82f6',
  amber: '#f59e0b',
  red: '#ef4444',
} as const;

/* ─── Typography helpers ─────────────────────────────────── */

export function P({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ margin: '0 0 14px', fontSize: '0.875rem', color: C.textMuted, lineHeight: 1.75 }}>
      {children}
    </p>
  );
}

export function H3({ children }: { children: React.ReactNode }) {
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

/** Inline code span. */
export function IC({ children }: { children: React.ReactNode }) {
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

/* ─── Callout box ────────────────────────────────────────── */

export function Callout({
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
        <Info size={14} />
      </div>
      <div>{children}</div>
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

export function AccordionSection({
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

/* ─── Code block ─────────────────────────────────────────── */

/**
 * Renders a single code line with simple blue-palette token colouring.
 * Covers the patterns that appear in curl/JSON examples without a full parser.
 */
function CodeLine({ raw }: { raw: string }) {
  // Comment lines
  if (/^\s*#/.test(raw)) {
    return (
      <div>
        <span style={{ color: '#334155' }}>{raw}</span>
      </div>
    );
  }

  const tokens: Array<{ text: string; color: string }> = [];
  const remaining = raw;

  const TOKEN_RE = /("[\w\s:+@./\\-]*"\s*:)|("(?:[^"\\]|\\.)*")|(\b(?:true|false|null)\b)|(\b\d+(?:\.\d+)?\b)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(remaining)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ text: remaining.slice(lastIndex, match.index), color: '#94a3b8' });
    }

    if (match[1]) {
      tokens.push({ text: match[1], color: '#60a5fa' });
    } else if (match[2]) {
      tokens.push({ text: match[2], color: '#93c5fd' });
    } else if (match[3]) {
      tokens.push({ text: match[3], color: '#818cf8' });
    } else if (match[4]) {
      tokens.push({ text: match[4], color: '#38bdf8' });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < remaining.length) {
    tokens.push({ text: remaining.slice(lastIndex), color: '#94a3b8' });
  }

  if (tokens.length === 0) {
    return <div><span style={{ color: '#94a3b8' }}>{raw || '\u00A0'}</span></div>;
  }

  return (
    <div>
      {tokens.map((t, i) => (
        <span key={i} style={{ color: t.color }}>{t.text}</span>
      ))}
    </div>
  );
}

/** Syntax-highlighted code block with copy-to-clipboard. */
export function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  const lines = code.split('\n');

  return (
    <div
      style={{
        borderRadius: 10,
        overflow: 'hidden',
        border: `1px solid rgba(59,130,246,0.2)`,
        marginBottom: 16,
      }}
    >
      {/* Top bar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '8px 16px',
          background: 'rgba(59,130,246,0.06)',
          borderBottom: '1px solid rgba(59,130,246,0.15)',
        }}
      >
        <span
          style={{
            fontSize: '0.7rem',
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: '#60a5fa',
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          }}
        >
          {label ?? 'code'}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: '0.7rem',
            color: copied ? '#4ade80' : '#475569',
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            padding: '2px 6px',
            borderRadius: 4,
            transition: 'color 0.2s',
          }}
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>

      {/* Code body */}
      <div
        style={{
          background: 'rgba(10,13,22,0.85)',
          padding: '16px 20px',
          overflowX: 'auto',
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          fontSize: '0.78rem',
          lineHeight: 1.75,
        }}
      >
        {lines.map((raw, idx) => (
          <CodeLine key={idx} raw={raw} />
        ))}
      </div>
    </div>
  );
}

/* ─── HTTP Endpoint row ──────────────────────────────────── */

export function Endpoint({
  method,
  path,
  description,
}: {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  description: string;
}) {
  const methodColors: Record<string, { bg: string; text: string }> = {
    GET:    { bg: 'rgba(59,130,246,0.15)',  text: '#60a5fa' },
    POST:   { bg: 'rgba(34,197,94,0.12)',   text: '#4ade80' },
    PUT:    { bg: 'rgba(245,158,11,0.12)',   text: '#fbbf24' },
    DELETE: { bg: 'rgba(239,68,68,0.12)',    text: '#f87171' },
    PATCH:  { bg: 'rgba(168,85,247,0.12)',   text: '#c084fc' },
  };
  const mc = methodColors[method] ?? methodColors.GET;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 16px',
        borderRadius: 8,
        background: 'rgba(10,13,22,0.55)',
        border: `1px solid rgba(59,130,246,0.18)`,
        marginBottom: 12,
      }}
    >
      <span
        style={{
          display: 'inline-block',
          padding: '3px 9px',
          borderRadius: 5,
          background: mc.bg,
          color: mc.text,
          fontSize: '0.68rem',
          fontWeight: 800,
          letterSpacing: '0.08em',
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          flexShrink: 0,
        }}
      >
        {method}
      </span>
      <code
        style={{
          color: '#93c5fd',
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          fontSize: '0.82rem',
          flexShrink: 0,
        }}
      >
        {path}
      </code>
      <span style={{ color: C.textMuted, fontSize: '0.81rem', lineHeight: 1.4 }}>
        {description}
      </span>
    </div>
  );
}

/* ─── Parameter reference table ─────────────────────────── */

export interface Param {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export function ParamTable({ params }: { params: Param[] }) {
  return (
    <div
      style={{
        borderRadius: 8,
        overflow: 'hidden',
        border: `1px solid rgba(59,130,246,0.18)`,
        marginBottom: 20,
      }}
    >
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
        <thead>
          <tr style={{ background: 'rgba(10,13,22,0.7)' }}>
            {['Parameter', 'Type', 'Required', 'Description'].map(h => (
              <th
                key={h}
                style={{
                  padding: '9px 14px',
                  textAlign: 'left',
                  color: '#475569',
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  fontSize: '0.67rem',
                  textTransform: 'uppercase',
                  borderBottom: '1px solid rgba(59,130,246,0.15)',
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {params.map((p, i) => (
            <tr key={p.name} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(10,13,22,0.28)' }}>
              <td style={{ padding: '9px 14px', borderBottom: '1px solid rgba(42,47,69,0.3)', whiteSpace: 'nowrap' }}>
                <code style={{ color: '#60a5fa', fontFamily: 'monospace', fontSize: '0.8rem', fontWeight: 700 }}>
                  {p.name}
                </code>
              </td>
              <td style={{ padding: '9px 14px', borderBottom: '1px solid rgba(42,47,69,0.3)', whiteSpace: 'nowrap' }}>
                <code style={{ color: '#818cf8', fontFamily: 'monospace', fontSize: '0.78rem' }}>
                  {p.type}
                </code>
              </td>
              <td style={{ padding: '9px 14px', borderBottom: '1px solid rgba(42,47,69,0.3)', whiteSpace: 'nowrap' }}>
                <span
                  style={{
                    display: 'inline-block',
                    padding: '2px 7px',
                    borderRadius: 4,
                    fontSize: '0.67rem',
                    fontWeight: 700,
                    letterSpacing: '0.05em',
                    background: p.required ? 'rgba(59,130,246,0.12)' : 'rgba(71,85,105,0.2)',
                    color: p.required ? '#60a5fa' : '#475569',
                  }}
                >
                  {p.required ? 'required' : 'optional'}
                </span>
              </td>
              <td style={{ padding: '9px 14px', borderBottom: '1px solid rgba(42,47,69,0.3)', color: C.textMuted, lineHeight: 1.55 }}>
                {p.description}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ─── Side-by-side request + response ───────────────────── */

export function ReqRes({ request, response }: { request: string; response: string }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 12,
        marginBottom: 20,
      }}
    >
      <CodeBlock code={request} label="request" />
      <CodeBlock code={response} label="response" />
    </div>
  );
}

/* ─── Behavior note card grid ────────────────────────────── */

export function NoteCards({
  accent,
  items,
}: {
  accent: string;
  items: { title: string; body: string }[];
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 4 }}>
      {items.map(({ title, body }) => (
        <div
          key={title}
          style={{
            padding: '14px 16px',
            borderRadius: 8,
            background: `${accent}07`,
            border: `1px solid ${accent}20`,
          }}
        >
          <div style={{ fontSize: '0.78rem', fontWeight: 700, color: accent, marginBottom: 6 }}>
            {title}
          </div>
          <div style={{ fontSize: '0.81rem', color: C.textMuted, lineHeight: 1.6 }}>
            {body}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─── Page header glass card ─────────────────────────────── */

interface PageHeaderCardProps {
  /** Eyebrow text above the title */
  eyebrow: string;
  title: string;
  subtitle: string;
  /** Accent colour drives the top rule, glow, and border */
  accent: string;
}

export function PageHeaderCard({ eyebrow, title, subtitle, accent }: PageHeaderCardProps) {
  return (
    <div
      className="animate-fade-in-up"
      style={{
        position: 'relative',
        background: 'rgba(19, 21, 29, 0.72)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        border: `1px solid ${accent}28`,
        borderRadius: 20,
        padding: '32px 36px 28px',
        marginBottom: 28,
        overflow: 'hidden',
        boxShadow: `0 8px 40px -12px rgba(0,0,0,0.55), 0 0 0 1px ${accent}0a`,
      }}
    >
      {/* Top accent rule */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 48,
          right: 48,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${accent}b0, transparent)`,
          borderRadius: '0 0 2px 2px',
        }}
      />

      {/* Radial glow */}
      <div
        style={{
          position: 'absolute',
          top: -60,
          right: -60,
          width: 280,
          height: 280,
          background: `radial-gradient(circle, ${accent}12 0%, transparent 70%)`,
          pointerEvents: 'none',
        }}
      />

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 24 }}>
        {/* Logo badge */}
        <div style={{ flexShrink: 0, position: 'relative' }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: `linear-gradient(135deg, ${accent}2e 0%, ${accent}0e 100%)`,
              border: `1px solid ${accent}45`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: `0 0 24px ${accent}33`,
            }}
          >
            <img
              src="/keystone_logo.png"
              alt="Keystone"
              style={{
                width: 36,
                height: 36,
                objectFit: 'contain',
                filter: `drop-shadow(0 0 8px ${accent}8c) brightness(1.1)`,
              }}
            />
          </div>
        </div>

        {/* Text block */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: '0.6rem',
              fontWeight: 700,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: accent,
              opacity: 0.85,
              marginBottom: 6,
            }}
          >
            {eyebrow}
          </div>
          <h1
            style={{
              fontSize: 'clamp(1.2rem, 2.5vw, 1.55rem)',
              fontWeight: 800,
              color: '#e2e8f0',
              letterSpacing: '-0.025em',
              lineHeight: 1.15,
              margin: '0 0 8px',
            }}
          >
            {title}
          </h1>
          <p
            style={{
              fontSize: '0.85rem',
              color: '#718096',
              lineHeight: 1.65,
              margin: 0,
              maxWidth: 520,
            }}
          >
            {subtitle}
          </p>
        </div>
      </div>
    </div>
  );
}
