/**
 * ProviderChips — the three per-agent provider chips (STT / LLM / TTS) shown in
 * the agents table. Each chip shows the layer kind + the selected provider (and
 * model where present). A cloud-provider chip is bordered amber, self-hosted
 * green — a quick at-a-glance boundary read that the ComplianceBadge confirms.
 */

import { Mic, Cpu, Volume2 } from 'lucide-react';
import { layerChip, layerKind } from '../styles';
import { GLASS } from '../../../../components/glass/glass';
import type { AiAgent } from '../../../../types/aiAgent';

const CLOUD = new Set(['deepgram', 'azure', 'azure_openai', 'openai', 'elevenlabs', 'eleven']);

function isCloud(provider: string | null): boolean {
  return provider != null && CLOUD.has(provider.toLowerCase());
}

function Chip({ kind, icon, provider, model }: { kind: string; icon: React.ReactNode; provider: string | null; model: string | null }) {
  const cloud = isCloud(provider);
  return (
    <span style={layerChip(cloud)}>
      <span style={{ color: cloud ? GLASS.warning : GLASS.success, display: 'inline-flex' }}>{icon}</span>
      <span style={layerKind}>{kind}</span>
      <span>{provider || 'default'}{model ? ` · ${model}` : ''}</span>
    </span>
  );
}

export function ProviderChips({ agent }: { agent: AiAgent }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      <Chip kind="STT" icon={<Mic size={11} />} provider={agent.stt_provider} model={agent.stt_model} />
      <Chip kind="LLM" icon={<Cpu size={11} />} provider={agent.llm_provider} model={agent.llm_model} />
      <Chip kind="TTS" icon={<Volume2 size={11} />} provider={agent.tts_provider} model={agent.tts_voice} />
    </div>
  );
}
