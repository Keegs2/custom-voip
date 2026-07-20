/**
 * AI Voice Agent types — map 1:1 to the FastAPI schemas in
 * `routers/ai_agents.py` + the resolved runtime view in `services/ai_config.py`.
 *
 * Secrets are NEVER stored: every `*_api_key_ref` is an ENV VAR NAME
 * (e.g. `OPENAI_API_KEY`), not a key. The compliance signal (`data_stays_in_vpc`)
 * is authoritative from the `/runtime-config` endpoint.
 */

/** Canonical provider options surfaced in the UI (server soft-validates; more
 *  aliases are accepted server-side, but these are the documented choices). */
export type SttProvider = 'whisper_http' | 'deepgram' | 'noop';
export type LlmProvider = 'openai_compat' | 'azure' | 'vllm' | 'ollama';
export type TtsProvider = 'piper' | 'http' | 'openai' | 'elevenlabs';

/**
 * One tool entry in an agent's `tools` array. Either a full OpenAI function
 * schema (`{ type:'function', function:{...} }`) or the compact
 * `{ name, description, parameters, http? }` form. The optional `http` block is
 * used by the runtime to execute a custom tool (never shown to the model).
 */
export interface AgentTool {
  type?: string;
  function?: Record<string, unknown>;
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  http?: { url: string; method?: string } & Record<string, unknown>;
  [key: string]: unknown;
}

export interface AiAgent {
  id: number;
  customer_id: number;
  name: string;
  enabled: boolean;
  system_prompt: string;
  greeting: string | null;

  stt_provider: string | null;
  stt_model: string | null;
  stt_language: string | null;
  stt_base_url: string | null;
  stt_api_key_ref: string | null;

  llm_provider: string | null;
  llm_model: string | null;
  llm_base_url: string | null;
  llm_api_key_ref: string | null;
  temperature: number;
  max_tokens: number;

  tts_provider: string | null;
  tts_voice: string | null;
  tts_model: string | null;
  tts_base_url: string | null;
  tts_api_key_ref: string | null;

  tools: AgentTool[];
  fallback_destination: string | null;
  max_turns: number;
  max_duration_seconds: number;
  barge_in_enabled: boolean;
  store_transcript: boolean;

  created_at: string;
  updated_at: string;
}

/** Create payload — customer_id required; everything else has a server default. */
export interface AiAgentCreate {
  customer_id: number;
  name: string;
  system_prompt?: string;
  greeting?: string | null;
  enabled?: boolean;

  stt_provider?: string | null;
  stt_model?: string | null;
  stt_language?: string | null;
  stt_base_url?: string | null;
  stt_api_key_ref?: string | null;

  llm_provider?: string | null;
  llm_model?: string | null;
  llm_base_url?: string | null;
  llm_api_key_ref?: string | null;
  temperature?: number;
  max_tokens?: number;

  tts_provider?: string | null;
  tts_voice?: string | null;
  tts_model?: string | null;
  tts_base_url?: string | null;
  tts_api_key_ref?: string | null;

  tools?: AgentTool[];
  fallback_destination?: string | null;
  max_turns?: number;
  max_duration_seconds?: number;
  barge_in_enabled?: boolean;
  store_transcript?: boolean;
}

/** Partial update — the backend excludes null fields (see report on clearing). */
export type AiAgentUpdate = Partial<Omit<AiAgentCreate, 'customer_id'>>;

/** One resolved provider layer in the runtime-config response. */
export interface RuntimeSttLayer {
  provider: string;
  mode: string;
  self_hosted: boolean;
}
export interface RuntimeLlmLayer {
  provider: string;
  model: string;
  self_hosted: boolean;
}
export interface RuntimeTtsLayer {
  provider: string;
  self_hosted: boolean;
}

/**
 * The resolved runtime view — the providers that WOULD run, the authoritative
 * compliance signal (`data_stays_in_vpc`), the tool schema the model sees, and
 * the exact `<Connect><Stream>` TwiML the flow/DID layer emits to route here.
 */
export interface AgentRuntimeConfig {
  agent_id: number;
  customer_id: number;
  name: string;
  enabled: boolean;
  stt: RuntimeSttLayer;
  llm: RuntimeLlmLayer;
  tts: RuntimeTtsLayer;
  /** TRUE iff STT + LLM + TTS are ALL self-hosted (no cloud egress). */
  data_stays_in_vpc: boolean;
  tools: AgentTool[];
  guardrails: {
    max_turns: number;
    max_duration_seconds: number;
    barge_in_enabled: boolean;
    store_transcript: boolean;
    fallback_destination: string | null;
  };
  ws_path: string;
  connect_twiml_template: string;
}
