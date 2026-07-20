/**
 * AgentRuntimeModal — the AUTHORITATIVE runtime & compliance view for one agent.
 * Reads the resolved `/runtime-config` (cached — the table already warmed it) and
 * proves, from the backend, whether every provider is self-hosted. Also surfaces
 * the resolved per-layer providers, guardrails, the exposed tool schema, the WS
 * path, and the exact `<Connect><Stream>` TwiML the flow/DID layer must return.
 *
 * All hooks sit at the top (React #310); the modal only renders when `open`.
 */

import { useState } from 'react';
import { ShieldCheck, Cloud, Copy, Check, Mic, Cpu, Volume2 } from 'lucide-react';
import { Modal } from '../../../../components/ui/Modal';
import { Spinner } from '../../../../components/ui/Spinner';
import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import type { AiAgent } from '../../../../types/aiAgent';
import { useAgentRuntime } from '../hooks';
import {
  complianceBanner,
  complianceIcon,
  complianceTitle,
  complianceBody,
  codeBlock,
  detailRow,
  detailKey,
  detailVal,
  groupLabel,
  MONO,
} from '../styles';

interface AgentRuntimeModalProps {
  agent: AiAgent | null;
  open: boolean;
  onClose: () => void;
}

function LayerLine({ icon, kind, provider, extra, selfHosted }: { icon: React.ReactNode; kind: string; provider: string; extra?: string; selfHosted: boolean }) {
  const color = selfHosted ? GLASS.success : GLASS.warning;
  return (
    <div style={detailRow}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: GLASS.textMuted }}>
        <span style={{ color, display: 'inline-flex' }}>{icon}</span>
        {kind}
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <span style={detailVal}>{provider}{extra ? ` · ${extra}` : ''}</span>
        <span
          style={{
            fontSize: '0.6rem',
            fontWeight: 800,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            color,
            background: hexToRgba(color, 0.12),
            border: `1px solid ${hexToRgba(color, 0.3)}`,
            borderRadius: 6,
            padding: '2px 7px',
          }}
        >
          {selfHosted ? 'Self-hosted' : 'Cloud'}
        </span>
      </span>
    </div>
  );
}

export function AgentRuntimeModal({ agent, open, onClose }: AgentRuntimeModalProps) {
  const [copied, setCopied] = useState(false);
  const { data, isLoading, isError } = useAgentRuntime(agent?.id ?? 0, open && agent !== null);

  const copyTwiml = () => {
    if (!data) return;
    void navigator.clipboard.writeText(data.connect_twiml_template).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <Modal open={open} onClose={onClose} title={agent ? `Runtime — ${agent.name}` : 'Runtime'} maxWidth="max-w-2xl">
      {isLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: GLASS.textMuted, padding: '20px 0' }}>
          <Spinner size="sm" /> Resolving runtime configuration…
        </div>
      )}

      {isError && (
        <p style={{ color: '#f87171', fontSize: '0.85rem' }}>Could not resolve the runtime configuration for this agent.</p>
      )}

      {data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          {/* Authoritative compliance banner */}
          <div style={complianceBanner(data.data_stays_in_vpc)}>
            <div style={complianceIcon(data.data_stays_in_vpc)}>
              {data.data_stays_in_vpc ? <ShieldCheck size={18} /> : <Cloud size={18} />}
            </div>
            <div>
              <div style={complianceTitle(data.data_stays_in_vpc)}>
                {data.data_stays_in_vpc ? 'In-boundary — no data leaves your VPC' : 'Cloud provider selected — data leaves the boundary'}
              </div>
              <div style={complianceBody}>
                {data.data_stays_in_vpc
                  ? 'Verified from the resolved runtime config: speech-to-text, the language model, and text-to-speech all run on self-hosted, in-VPC endpoints. No PHI/CPNI egresses to a third party.'
                  : 'Verified from the resolved runtime config: at least one layer sends call audio or text to a cloud provider. Switch it to a self-hosted endpoint to keep everything in-boundary.'}
              </div>
            </div>
          </div>

          {/* Resolved providers */}
          <div>
            <div style={groupLabel()}>Resolved providers</div>
            <LayerLine icon={<Mic size={13} />} kind="Speech-to-Text" provider={data.stt.provider} extra={data.stt.mode} selfHosted={data.stt.self_hosted} />
            <LayerLine icon={<Cpu size={13} />} kind="Language Model" provider={data.llm.provider} extra={data.llm.model} selfHosted={data.llm.self_hosted} />
            <LayerLine icon={<Volume2 size={13} />} kind="Text-to-Speech" provider={data.tts.provider} selfHosted={data.tts.self_hosted} />
          </div>

          {/* Guardrails */}
          <div>
            <div style={groupLabel()}>Guardrails</div>
            <div style={detailRow}><span style={detailKey}>Max turns</span><span style={detailVal}>{data.guardrails.max_turns}</span></div>
            <div style={detailRow}><span style={detailKey}>Max duration</span><span style={detailVal}>{data.guardrails.max_duration_seconds}s</span></div>
            <div style={detailRow}><span style={detailKey}>Barge-in</span><span style={detailVal}>{data.guardrails.barge_in_enabled ? 'Enabled' : 'Disabled'}</span></div>
            <div style={detailRow}><span style={detailKey}>Store transcript</span><span style={detailVal}>{data.guardrails.store_transcript ? 'Yes' : 'No'}</span></div>
            <div style={detailRow}><span style={detailKey}>Fallback destination</span><span style={detailVal}>{data.guardrails.fallback_destination ?? '—'}</span></div>
            <div style={detailRow}><span style={detailKey}>Tools exposed to model</span><span style={detailVal}>{data.tools.length}</span></div>
          </div>

          {/* Connect TwiML */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
              <div style={{ ...groupLabel(), marginBottom: 0 }}>Route a call here (TwiML)</div>
              <button
                type="button"
                onClick={copyTwiml}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  fontSize: '0.68rem',
                  fontWeight: 700,
                  color: copied ? GLASS.success : GLASS.accent,
                  background: hexToRgba(copied ? GLASS.success : GLASS.accent, 0.1),
                  border: `1px solid ${hexToRgba(copied ? GLASS.success : GLASS.accent, 0.3)}`,
                  borderRadius: 8,
                  padding: '4px 10px',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {copied ? <Check size={12} /> : <Copy size={12} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre style={codeBlock()}>{data.connect_twiml_template}</pre>
            <div style={{ fontSize: '0.72rem', color: GLASS.textFaint, marginTop: 8 }}>
              Media WebSocket: <code style={{ fontFamily: MONO, color: '#93c5fd' }}>{data.ws_path}</code> · the flow/DID layer substitutes the real CallSid at call time.
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
