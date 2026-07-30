/**
 * QuickstartNote — a small informational glass panel explaining how to
 * authenticate against the programmable-voice REST API (HTTP Basic with
 * api_key:api_secret) and the base API path. Read-only; no data fetching.
 */

import { useState, useCallback } from 'react';
import { BookOpen, Terminal, Copy, Check } from 'lucide-react';
import { Link } from 'react-router-dom';

const ACCENT = '#3b82f6';

/** Base path all programmable-voice REST endpoints live under (nginx-proxied). */
const API_BASE_PATH = '/api';

const CURL_EXAMPLE = [
  '# Authenticate with HTTP Basic — api_key as the username, api_secret as the password',
  `curl -u "$API_KEY:$API_SECRET" \\`,
  `  https://<your-host>${API_BASE_PATH}/api-dids`,
].join('\n');

export function QuickstartNote() {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(CURL_EXAMPLE);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — user can select manually */
    }
  }, []);

  return (
    <section className="glass-surface" style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 9,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: `linear-gradient(135deg, ${ACCENT}22 0%, ${ACCENT}0d 100%)`,
            border: `1px solid ${ACCENT}33`,
            color: '#60a5fa',
            flexShrink: 0,
          }}
          aria-hidden="true"
        >
          <Terminal size={16} />
        </div>
        <h2 style={{ fontSize: '0.95rem', fontWeight: 700, color: '#e2e8f0', margin: 0 }}>
          Quickstart
        </h2>
      </div>

      <p style={{ fontSize: '0.82rem', color: '#94a3b8', lineHeight: 1.65, margin: '0 0 14px' }}>
        The REST API lives under{' '}
        <code style={codeInline}>{API_BASE_PATH}</code>. Authenticate every request with{' '}
        <strong style={{ color: '#e2e8f0' }}>HTTP Basic</strong> — send your{' '}
        <code style={codeInline}>api_key</code> as the username and your{' '}
        <code style={codeInline}>api_secret</code> as the password. Generate a key/secret pair in
        the API Keys panel above.
      </p>

      {/* Copyable curl example */}
      <div style={{ position: 'relative' }}>
        <pre
          style={{
            fontSize: '0.76rem',
            lineHeight: 1.7,
            fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
            color: '#cbd5e0',
            background: '#0d0f15',
            border: '1px solid rgba(42,47,69,0.6)',
            borderRadius: 10,
            padding: '14px 16px',
            paddingRight: 48,
            overflowX: 'auto',
            margin: 0,
            whiteSpace: 'pre',
          }}
          aria-label="Example authenticated curl request"
        >
          {CURL_EXAMPLE}
        </pre>
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copy example"
          title="Copy example"
          style={{
            position: 'absolute',
            top: 10,
            right: 10,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            borderRadius: 7,
            border: `1px solid ${copied ? 'rgba(34,197,94,0.4)' : 'rgba(59,130,246,0.20)'}`,
            background: copied ? 'rgba(34,197,94,0.12)' : 'rgba(59,130,246,0.06)',
            color: copied ? '#22c55e' : '#94a3b8',
            cursor: 'pointer',
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>

      <div style={{ marginTop: 14 }}>
        <Link
          to="/docs/api"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: '0.8rem',
            fontWeight: 600,
            color: '#60a5fa',
            textDecoration: 'none',
          }}
        >
          <BookOpen size={13} />
          Full API documentation
        </Link>
      </div>
    </section>
  );
}

const codeInline: React.CSSProperties = {
  fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
  fontSize: '0.78rem',
  color: '#93c5fd',
  background: 'rgba(59,130,246,0.10)',
  border: '1px solid rgba(59,130,246,0.18)',
  borderRadius: 5,
  padding: '1px 6px',
};
