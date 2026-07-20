/**
 * Code rendering for the documentation pages: a syntax-highlighted, frosted
 * code block with copy-to-clipboard, plus the side-by-side request/response
 * layout. Presentational + self-contained clipboard state only.
 *
 * Exports only components (react-refresh discipline). The line-tokeniser is a
 * private component within this module.
 */

import { useState } from 'react';
import {
  DOCS,
  codeFrame,
  codeBar,
  codeBarLabel,
  codeCopyBtn,
  codeBody,
  reqResGrid,
} from '../styles';

/**
 * Renders a single code line with simple blue-palette token colouring — covers
 * the curl/JSON patterns in the examples without a full parser.
 */
function CodeLine({ raw }: { raw: string }) {
  // Comment lines render flat in the faint comment colour.
  if (/^\s*#/.test(raw)) {
    return (
      <div>
        <span style={{ color: DOCS.code.comment }}>{raw}</span>
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
      tokens.push({ text: remaining.slice(lastIndex, match.index), color: DOCS.code.plain });
    }

    if (match[1]) {
      tokens.push({ text: match[1], color: DOCS.code.keyName });
    } else if (match[2]) {
      tokens.push({ text: match[2], color: DOCS.code.string });
    } else if (match[3]) {
      tokens.push({ text: match[3], color: DOCS.code.literal });
    } else if (match[4]) {
      tokens.push({ text: match[4], color: DOCS.code.number });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < remaining.length) {
    tokens.push({ text: remaining.slice(lastIndex), color: DOCS.code.plain });
  }

  if (tokens.length === 0) {
    return (
      <div>
        <span style={{ color: DOCS.code.plain }}>{raw || ' '}</span>
      </div>
    );
  }

  return (
    <div>
      {tokens.map((t, i) => (
        <span key={i} style={{ color: t.color }}>
          {t.text}
        </span>
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
    <div style={codeFrame}>
      <div style={codeBar}>
        <span style={codeBarLabel}>{label ?? 'code'}</span>
        <button type="button" onClick={handleCopy} style={codeCopyBtn(copied)}>
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <div style={codeBody}>
        {lines.map((raw, idx) => (
          <CodeLine key={idx} raw={raw} />
        ))}
      </div>
    </div>
  );
}

/** Side-by-side request + response code blocks. */
export function ReqRes({ request, response }: { request: string; response: string }) {
  return (
    <div style={reqResGrid}>
      <CodeBlock code={request} label="request" />
      <CodeBlock code={response} label="response" />
    </div>
  );
}
