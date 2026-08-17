/**
 * Shared design tokens, helper components, and layout primitives used across
 * the documentation pages (RCF Docs, API Reference).
 *
 * Keep this file free of page-specific content — it is pure shared infrastructure.
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` classes in index.css)
 * plus the docs-only `dlx-*` primitives in src/styles/dl-docs.css — paper
 * canvas, quiet breadcrumb header, white panels, ink text, azure accents,
 * ink-on-dark code blocks.
 *
 * React #310: every hook in every component below is called unconditionally
 * at the top of its function, before any early return.
 */

import { useState } from 'react';
import { ChevronDown, Info } from 'lucide-react';

import '../../styles/dl-docs.css';

/* ─── Typography helpers ─────────────────────────────────── */

export function P({ children }: { children: React.ReactNode }) {
  return <p className="dlx-p">{children}</p>;
}

export function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="dlx-h3">{children}</h3>;
}

/** Inline code span. */
export function IC({ children }: { children: React.ReactNode }) {
  return <code className="dlx-ic">{children}</code>;
}

/** Bulleted usage list — azure dash markers (see .dlx8-ul). */
export function UL({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="dlx8-ul">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
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
      className="dlx-callout"
      style={{
        background: `${accent}0d`,
        border: `1px solid ${accent}30`,
      }}
    >
      <div style={{ color: accent, flexShrink: 0, marginTop: 2 }}>
        <Info size={14} />
      </div>
      <div>{children}</div>
    </div>
  );
}

/* ─── Collapsible accordion section ─────────────────────── */

interface AccordionSectionProps {
  id: string;
  icon: React.ReactNode;
  title: React.ReactNode;
  subtitle: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

export function AccordionSection({
  id,
  icon,
  title,
  subtitle,
  children,
  defaultOpen = false,
}: AccordionSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section id={id} className="dl-panel">
      {/* Header bar */}
      <button
        type="button"
        className="dlx-section-toggle"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <span className="dlx-section-icon" aria-hidden="true">{icon}</span>
        <span className="dlx-section-id">
          <span className="dlx-section-title">{title}</span>
          <span className="dlx-section-sub">{subtitle}</span>
        </span>
        <ChevronDown
          size={18}
          className={open ? 'dlx-section-chev dlx-section-chev-open' : 'dlx-section-chev'}
        />
      </button>

      {/* Collapsible body */}
      {open && <div className="dlx-section-body">{children}</div>}
    </section>
  );
}

/* ─── Code block ─────────────────────────────────────────── */

/**
 * Renders a single code line with simple token colouring tuned for the
 * ink-on-dark navy code surface. Covers the patterns that appear in
 * curl/JSON examples without a full parser.
 */
function CodeLine({ raw }: { raw: string }) {
  // Comment lines
  if (/^\s*#/.test(raw)) {
    return (
      <div>
        <span style={{ color: '#5b6d8f' }}>{raw}</span>
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
      tokens.push({ text: remaining.slice(lastIndex, match.index), color: '#c9d5ea' });
    }

    if (match[1]) {
      tokens.push({ text: match[1], color: '#6fb0ff' });
    } else if (match[2]) {
      tokens.push({ text: match[2], color: '#a3c9ff' });
    } else if (match[3]) {
      tokens.push({ text: match[3], color: '#5fd39a' });
    } else if (match[4]) {
      tokens.push({ text: match[4], color: '#4cc9f0' });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < remaining.length) {
    tokens.push({ text: remaining.slice(lastIndex), color: '#c9d5ea' });
  }

  if (tokens.length === 0) {
    return <div><span style={{ color: '#c9d5ea' }}>{raw || ' '}</span></div>;
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
    <div className="dlx-code">
      {/* Top bar */}
      <div className="dlx-code-bar">
        <span className="dlx-code-label">{label ?? 'code'}</span>
        <button
          type="button"
          className={copied ? 'dlx-code-copy dlx-code-copied' : 'dlx-code-copy'}
          onClick={handleCopy}
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>

      {/* Code body */}
      <div className="dlx-code-body">
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
  admin = false,
}: {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  description: string;
  /** Marks an endpoint that requires the admin role (Granite-managed). */
  admin?: boolean;
}) {
  return (
    <div className="dlx-endpoint">
      <span className={`dlx-method dlx-method-${method.toLowerCase()}`}>{method}</span>
      <code className="dlx-endpoint-path">{path}</code>
      {admin && <span className="dlx8-tag-admin">Admin</span>}
      <span className="dlx-endpoint-desc">{description}</span>
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
    <div className="dlx-table-wrap">
      <table className="dlx-table">
        <thead>
          <tr>
            {['Parameter', 'Type', 'Required', 'Description'].map(h => (
              <th key={h} className="dl-th">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {params.map(p => (
            <tr key={p.name}>
              <td>
                <code className="dlx-td-code">{p.name}</code>
              </td>
              <td>
                <code className="dlx-td-type">{p.type}</code>
              </td>
              <td>
                <span className={p.required ? 'dl-tag' : 'dl-tag dl-tag-slate'}>
                  {p.required ? 'required' : 'optional'}
                </span>
              </td>
              <td>{p.description}</td>
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
    <div className="dlx-reqres">
      <CodeBlock code={request} label="request" />
      <CodeBlock code={response} label="response" />
    </div>
  );
}

/* ─── Behavior note card grid ────────────────────────────── */

export function NoteCards({
  items,
}: {
  items: { title: string; body: string }[];
}) {
  return (
    <div className="dlx-notegrid" style={{ marginBottom: 4 }}>
      {items.map(({ title, body }) => (
        <div key={title} className="dlx-notecard">
          <div className="dlx-notecard-title">{title}</div>
          <div className="dlx-notecard-body">{body}</div>
        </div>
      ))}
    </div>
  );
}

/* ─── Quiet page header — breadcrumb, title, description ─── */

interface DocsHeaderProps {
  /** First breadcrumb segment, e.g. "RCF Guide" — rendered as "X / Granite CRAG". */
  crumb: string;
  title: string;
  subtitle: string;
}

export function DocsHeader({ crumb, title, subtitle }: DocsHeaderProps) {
  return (
    <header className="dl-header fx-load">
      <div className="dl-header-id">
        <div className="dl-crumb">
          <span>{crumb}</span>
          <span className="dl-crumb-sep" aria-hidden="true">/</span>
          <span>Granite CRAG</span>
        </div>
        <h1 className="dl-title">{title}</h1>
        <p className="dl-sub">{subtitle}</p>
      </div>
    </header>
  );
}
