/**
 * Local types + consts for the AI Voice Agents admin feature.
 *
 * Page-global agent types (AiAgent, AiAgentCreate, AgentRuntimeConfig, …) live in
 * `src/types/aiAgent.ts`. Only feature-local form shapes, provider option lists,
 * and built-in tool metadata live here.
 */

import type { SttProvider, LlmProvider, TtsProvider } from '../../../types/aiAgent';

/** Provider dropdown options (label + value). Empty value = server default. */
export interface ProviderOption<T extends string> {
  value: T | '';
  label: string;
  /** Whether picking this provider keeps data in-VPC when its URL is internal. */
  cloud?: boolean;
}

export const STT_PROVIDERS: ReadonlyArray<ProviderOption<SttProvider>> = [
  { value: '', label: 'Default (self-hosted noop)' },
  { value: 'whisper_http', label: 'Whisper (self-hosted HTTP)' },
  { value: 'deepgram', label: 'Deepgram (cloud)', cloud: true },
  { value: 'noop', label: 'None / passthrough' },
];

export const LLM_PROVIDERS: ReadonlyArray<ProviderOption<LlmProvider>> = [
  { value: '', label: 'Default (self-hosted)' },
  { value: 'openai_compat', label: 'OpenAI-compatible (vLLM / self-hosted)' },
  { value: 'vllm', label: 'vLLM (self-hosted)' },
  { value: 'ollama', label: 'Ollama (self-hosted)' },
  { value: 'azure', label: 'Azure OpenAI (cloud)', cloud: true },
];

export const TTS_PROVIDERS: ReadonlyArray<ProviderOption<TtsProvider>> = [
  { value: '', label: 'Default (self-hosted Piper)' },
  { value: 'piper', label: 'Piper (self-hosted)' },
  { value: 'http', label: 'HTTP / OpenedAI (self-hosted)' },
  { value: 'openai', label: 'OpenAI (cloud)', cloud: true },
  { value: 'elevenlabs', label: 'ElevenLabs (cloud)', cloud: true },
];

/** Guardrail slider/number bounds (mirrors the server field validators). */
export const TEMP_MIN = 0;
export const TEMP_MAX = 2;
export const TOKENS_MIN = 16;
export const TOKENS_MAX = 4096;
export const TURNS_MIN = 1;
export const TURNS_MAX = 200;
export const DURATION_MIN = 10;
export const DURATION_MAX = 7200;

/** The four always-available built-in tools (from services/ai_config.py). */
export interface BuiltinTool {
  name: string;
  label: string;
  description: string;
}
export const BUILTIN_TOOLS: ReadonlyArray<BuiltinTool> = [
  { name: 'transfer_call', label: 'Transfer Call', description: 'Hand the live call to a human or another destination (escalation).' },
  { name: 'send_dtmf', label: 'Send DTMF', description: 'Send touch-tones to navigate an IVR or enter a code.' },
  { name: 'end_call', label: 'End Call', description: 'Hang up after resolving the request or saying goodbye.' },
  { name: 'capture_result', label: 'Capture Result', description: 'Persist structured data collected on the call (name, intent, disposition).' },
];

/** Controlled create/edit form state — strings for inputs, numbers for sliders. */
export interface AgentFormState {
  /** Create-only. On edit the agent's customer is fixed. */
  customerId: string;
  name: string;
  enabled: boolean;
  greeting: string;
  systemPrompt: string;

  sttProvider: string;
  sttModel: string;
  sttLanguage: string;
  sttBaseUrl: string;
  sttApiKeyRef: string;

  llmProvider: string;
  llmModel: string;
  llmBaseUrl: string;
  llmApiKeyRef: string;
  temperature: number;
  maxTokens: number;

  ttsProvider: string;
  ttsVoice: string;
  ttsModel: string;
  ttsBaseUrl: string;
  ttsApiKeyRef: string;

  /** Raw JSON text for the custom-tools editor. */
  toolsJson: string;
  fallbackDestination: string;
  maxTurns: number;
  maxDurationSeconds: number;
  bargeInEnabled: boolean;
  storeTranscript: boolean;
}

/** Client-side compliance ESTIMATE for the live form preview. The authoritative
 *  signal always comes from the `/runtime-config` endpoint. */
export interface ComplianceEstimate {
  allSelfHosted: boolean;
  stt: boolean;
  llm: boolean;
  tts: boolean;
  /** Human-readable list of the layers that egress to a cloud provider. */
  cloudLayers: string[];
}
