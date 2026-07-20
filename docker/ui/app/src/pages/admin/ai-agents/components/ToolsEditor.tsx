/**
 * ToolsEditor — the agent's tool configuration.
 *
 *  - The four BUILT-IN tools (transfer_call / send_dtmf / end_call /
 *    capture_result) are ALWAYS available to the model (they map to real ESL
 *    call actions), so they are shown as an informational, always-on panel with
 *    one-click "insert schema" helpers.
 *  - CUSTOM tools live in the agent's `tools` JSON array (each an OpenAI function
 *    schema, optionally with an `{ "http": { "url": ... } }` execution block).
 *    The textarea is validated live (mirrors the server's `_validate_tools`).
 */

import { CheckCircle2, AlertTriangle, Wrench, Plus } from 'lucide-react';
import { FormField } from '../../../../components/ui/FormField';
import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import { BUILTIN_TOOLS } from '../types';
import type { ToolsParseResult } from '../hooks';
import { helpNote, MONO } from '../styles';

interface ToolsEditorProps {
  value: string;
  onChange: (v: string) => void;
  parse: ToolsParseResult;
}

/** A minimal, valid custom-tool skeleton to help operators get started. */
const CUSTOM_TEMPLATE = [
  {
    name: 'lookup_order',
    description: 'Look up an order by its ID for the caller.',
    parameters: {
      type: 'object',
      properties: { order_id: { type: 'string', description: 'The order number.' } },
      required: ['order_id'],
    },
    http: { method: 'GET', url: 'http://internal-api.svc/orders/{order_id}' },
  },
];

export function ToolsEditor({ value, onChange, parse }: ToolsEditorProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Built-in tools — always available */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Wrench size={13} style={{ color: GLASS.accent }} />
          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: GLASS.text }}>Built-in tools</span>
          <span style={{ fontSize: '0.66rem', color: GLASS.success, fontWeight: 700 }}>always available</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 8 }}>
          {BUILTIN_TOOLS.map((t) => (
            <div
              key={t.name}
              style={{
                padding: '10px 12px',
                borderRadius: 10,
                background: 'rgba(255,255,255,0.02)',
                border: `1px solid ${hexToRgba(GLASS.accent, 0.18)}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <CheckCircle2 size={12} style={{ color: GLASS.success, flexShrink: 0 }} />
                <code style={{ fontFamily: MONO, fontSize: '0.72rem', color: '#93c5fd', fontWeight: 700 }}>{t.name}</code>
              </div>
              <div style={{ fontSize: '0.68rem', color: GLASS.textMuted, marginTop: 4, lineHeight: 1.45 }}>{t.description}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Custom tools JSON */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: GLASS.text }}>Custom tools (JSON)</span>
          <button
            type="button"
            onClick={() => onChange(JSON.stringify(CUSTOM_TEMPLATE, null, 2))}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: '0.68rem',
              fontWeight: 700,
              color: GLASS.accent,
              background: hexToRgba(GLASS.accent, 0.1),
              border: `1px solid ${hexToRgba(GLASS.accent, 0.28)}`,
              borderRadius: 8,
              padding: '4px 10px',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <Plus size={11} />
            Insert example
          </button>
        </div>
        <FormField
          as="textarea"
          label=""
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="[]  — leave empty for built-in tools only"
          spellCheck={false}
          style={{ fontFamily: MONO, fontSize: '0.74rem', minHeight: 150, lineHeight: 1.55 }}
        />
        <div style={{ marginTop: 8 }}>
          {parse.ok ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.72rem', color: GLASS.success, fontWeight: 600 }}>
              <CheckCircle2 size={13} />
              {parse.count === 0 ? 'No custom tools — built-ins only' : `${parse.count} custom tool${parse.count === 1 ? '' : 's'} valid`}
            </span>
          ) : (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.72rem', color: '#f87171', fontWeight: 600 }}>
              <AlertTriangle size={13} />
              {parse.error}
            </span>
          )}
        </div>
        <p style={{ ...helpNote, marginTop: 8 }}>
          Each entry is an OpenAI function schema. Add an <code style={{ fontFamily: MONO, color: '#93c5fd' }}>{'"http": { "url": ... }'}</code> block to
          let the runtime call an internal API when the model invokes the tool.
        </p>
      </div>
    </div>
  );
}
