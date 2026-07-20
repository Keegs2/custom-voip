/**
 * Data + logic layer for the AI Voice Agents admin feature.
 *
 * Per docs/FRONTEND_GLASS_REFACTOR.md the page does composition + top-level state
 * only; ALL data fetching, mutations, derived state, the create/edit form
 * pipeline, and the pure compliance-estimate helpers live here.
 *
 * React #310: every hook below is called unconditionally at the top of its own
 * hook function — no early returns precede a hook.
 */

import { useCallback, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listAiAgents,
  createAiAgent,
  updateAiAgent,
  deleteAiAgent,
  getAgentRuntimeConfig,
} from '../../../api/aiAgents';
import { listCustomers } from '../../../api/customers';
import { useToast } from '../../../components/ui/Toast';
import type { AiAgent, AiAgentCreate, AgentTool } from '../../../types/aiAgent';
import type { AgentFormState, ComplianceEstimate } from './types';

// ── Customer dropdown (shared cache key) ──────────────────────────────────────

export function useCustomerOptions(enabled = true) {
  const { data } = useQuery({
    queryKey: ['customers-dropdown'],
    queryFn: () => listCustomers({ limit: 500 }),
    enabled,
    staleTime: 60_000,
  });
  return data?.items ?? [];
}

// ── Agents list ───────────────────────────────────────────────────────────────

export interface UseAgentsResult {
  agents: AiAgent[];
  isLoading: boolean;
  isError: boolean;
}

export function useAgents(customerId: number | undefined): UseAgentsResult {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['ai-agents', { customerId: customerId ?? null }],
    queryFn: () => listAiAgents(customerId !== undefined ? { customer_id: customerId } : {}),
  });
  return { agents: data ?? [], isLoading, isError };
}

// ── Runtime config (authoritative compliance) — one per agent, cached/shared ──

export function useAgentRuntime(agentId: number, enabled = true) {
  return useQuery({
    queryKey: ['ai-agent', agentId, 'runtime-config'],
    queryFn: () => getAgentRuntimeConfig(agentId),
    enabled,
    staleTime: 30_000,
  });
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export function useCreateAgent(onDone: () => void) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  return useMutation({
    mutationFn: (data: AiAgentCreate) => createAiAgent(data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ai-agents'] });
      toastOk('AI agent created');
      onDone();
    },
    onError: (err: Error) => toastErr(`Create failed: ${err.message}`),
  });
}

export function useUpdateAgent(agentId: number, onDone: () => void) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  return useMutation({
    mutationFn: (data: Partial<AiAgentCreate>) => updateAiAgent(agentId, data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ai-agents'] });
      void qc.invalidateQueries({ queryKey: ['ai-agent', agentId, 'runtime-config'] });
      toastOk('AI agent updated');
      onDone();
    },
    onError: (err: Error) => toastErr(`Save failed: ${err.message}`),
  });
}

export function useDeleteAgent() {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  return useMutation({
    mutationFn: (agentId: number) => deleteAiAgent(agentId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ai-agents'] });
      toastOk('AI agent deleted');
    },
    onError: (err: Error) => toastErr(`Delete failed: ${err.message}`),
  });
}

/** Optimistic-free enable/disable toggle (a tiny PATCH). */
export function useToggleAgent() {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => updateAiAgent(id, { enabled }),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['ai-agents'] });
      void qc.invalidateQueries({ queryKey: ['ai-agent', vars.id, 'runtime-config'] });
      toastOk(vars.enabled ? 'Agent enabled' : 'Agent disabled');
    },
    onError: (err: Error) => toastErr(`Update failed: ${err.message}`),
  });
}

// ── Pure compliance estimate (faithful mirror of services/*.py) ───────────────
// The AUTHORITATIVE compliance flag always comes from `/runtime-config`. This
// estimate drives the live form preview only (an unsaved agent has no runtime
// config yet), so it is always labelled "estimated".

/** Does this base URL stay in the VPC? Mirrors `_looks_internal` in the backend. */
export function looksInternal(url: string | null | undefined): boolean {
  const host = (url ?? '').replace(/^\w+:\/\//, '').split('/')[0].split(':')[0].toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.svc')) return true;
  if (!host.includes('.')) return true; // bare service name OR empty → internal
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

const CLOUD_STT = new Set(['deepgram']);
const CLOUD_LLM = new Set(['azure', 'azure_openai']);
const CLOUD_TTS = new Set(['openai', 'elevenlabs', 'eleven']);

function sttSelfHosted(provider: string, baseUrl: string): boolean {
  const p = provider.toLowerCase();
  if (p === '' || p === 'noop' || p === 'none' || p === 'off') return true;
  if (CLOUD_STT.has(p)) return false;
  return looksInternal(baseUrl);
}
function llmSelfHosted(provider: string, baseUrl: string): boolean {
  const p = provider.toLowerCase();
  if (CLOUD_LLM.has(p)) return false;
  return looksInternal(baseUrl);
}
function ttsSelfHosted(provider: string, baseUrl: string): boolean {
  const p = provider.toLowerCase();
  if (CLOUD_TTS.has(p)) return false;
  return looksInternal(baseUrl);
}

export function assessCompliance(form: AgentFormState): ComplianceEstimate {
  const stt = sttSelfHosted(form.sttProvider, form.sttBaseUrl);
  const llm = llmSelfHosted(form.llmProvider, form.llmBaseUrl);
  const tts = ttsSelfHosted(form.ttsProvider, form.ttsBaseUrl);
  const cloudLayers: string[] = [];
  if (!stt) cloudLayers.push(`STT (${form.sttProvider || 'cloud'})`);
  if (!llm) cloudLayers.push(`LLM (${form.llmProvider || 'cloud'})`);
  if (!tts) cloudLayers.push(`TTS (${form.ttsProvider || 'cloud'})`);
  return { allSelfHosted: stt && llm && tts, stt, llm, tts, cloudLayers };
}

// ── Tools JSON validation (mirrors _validate_tools in the backend) ────────────

export interface ToolsParseResult {
  ok: boolean;
  tools: AgentTool[];
  error: string | null;
  count: number;
}

export function parseToolsJson(raw: string): ToolsParseResult {
  const text = raw.trim();
  if (text === '' || text === '[]') return { ok: true, tools: [], error: null, count: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, tools: [], error: e instanceof Error ? e.message : 'Invalid JSON', count: 0 };
  }
  if (!Array.isArray(parsed)) return { ok: false, tools: [], error: 'tools must be a JSON array', count: 0 };
  for (let i = 0; i < parsed.length; i++) {
    const t = parsed[i];
    if (typeof t !== 'object' || t === null || Array.isArray(t)) {
      return { ok: false, tools: [], error: `tool #${i + 1} must be an object`, count: 0 };
    }
    const rec = t as Record<string, unknown>;
    const fn = rec['function'] as Record<string, unknown> | undefined;
    const name = rec['name'] ?? (fn ? fn['name'] : undefined);
    if (!name) return { ok: false, tools: [], error: `tool #${i + 1} needs a "name" (or function.name)`, count: 0 };
    const http = rec['http'];
    if (http !== undefined && http !== null) {
      if (typeof http !== 'object' || Array.isArray(http) || !(http as Record<string, unknown>)['url']) {
        return { ok: false, tools: [], error: `tool "${String(name)}": http block needs a "url"`, count: 0 };
      }
    }
  }
  return { ok: true, tools: parsed as AgentTool[], error: null, count: parsed.length };
}

// ── Create/edit form state + build-and-submit pipeline ────────────────────────

function initialForm(agent?: AiAgent): AgentFormState {
  return {
    customerId: agent ? String(agent.customer_id) : '',
    name: agent?.name ?? '',
    enabled: agent?.enabled ?? true,
    greeting: agent?.greeting ?? 'Hello, thanks for calling. How can I help you today?',
    systemPrompt:
      agent?.system_prompt ??
      'You are a helpful voice assistant answering a phone call. Keep replies short and spoken-friendly.',
    sttProvider: agent?.stt_provider ?? '',
    sttModel: agent?.stt_model ?? '',
    sttLanguage: agent?.stt_language ?? '',
    sttBaseUrl: agent?.stt_base_url ?? '',
    sttApiKeyRef: agent?.stt_api_key_ref ?? '',
    llmProvider: agent?.llm_provider ?? '',
    llmModel: agent?.llm_model ?? '',
    llmBaseUrl: agent?.llm_base_url ?? '',
    llmApiKeyRef: agent?.llm_api_key_ref ?? '',
    temperature: agent?.temperature ?? 0.4,
    maxTokens: agent?.max_tokens ?? 512,
    ttsProvider: agent?.tts_provider ?? '',
    ttsVoice: agent?.tts_voice ?? '',
    ttsModel: agent?.tts_model ?? '',
    ttsBaseUrl: agent?.tts_base_url ?? '',
    ttsApiKeyRef: agent?.tts_api_key_ref ?? '',
    toolsJson: agent && agent.tools.length > 0 ? JSON.stringify(agent.tools, null, 2) : '',
    fallbackDestination: agent?.fallback_destination ?? '',
    maxTurns: agent?.max_turns ?? 40,
    maxDurationSeconds: agent?.max_duration_seconds ?? 600,
    bargeInEnabled: agent?.barge_in_enabled ?? true,
    storeTranscript: agent?.store_transcript ?? true,
  };
}

/** Empty string → null (so create uses server defaults / update excludes it). */
function orNull(v: string): string | null {
  const t = v.trim();
  return t === '' ? null : t;
}

export interface UseAgentFormResult {
  form: AgentFormState;
  setField: <K extends keyof AgentFormState>(key: K, value: AgentFormState[K]) => void;
  compliance: ComplianceEstimate;
  toolsParse: ToolsParseResult;
  error: string | null;
  submitting: boolean;
  submit: () => void;
}

/**
 * Owns all create/edit form field state, the live compliance estimate, tools
 * JSON validation, and the build-and-submit pipeline. `isCreate` drives whether
 * customer_id is required + included. `onSubmit` receives the assembled payload.
 */
export function useAgentForm(
  agent: AiAgent | undefined,
  isCreate: boolean,
  onSubmit: (values: AiAgentCreate) => Promise<void>,
): UseAgentFormResult {
  const [form, setForm] = useState<AgentFormState>(() => initialForm(agent));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const setField = useCallback(
    <K extends keyof AgentFormState>(key: K, value: AgentFormState[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const compliance = useMemo(() => assessCompliance(form), [form]);
  const toolsParse = useMemo(() => parseToolsJson(form.toolsJson), [form.toolsJson]);

  const submit = useCallback(async () => {
    if (!form.name.trim()) {
      setError('Agent name is required');
      return;
    }
    if (isCreate && !form.customerId) {
      setError('Select a customer for this agent');
      return;
    }
    if (!toolsParse.ok) {
      setError(`Tools JSON: ${toolsParse.error}`);
      return;
    }
    setError(null);
    setSubmitting(true);

    const values: AiAgentCreate = {
      customer_id: Number(form.customerId),
      name: form.name.trim(),
      enabled: form.enabled,
      greeting: orNull(form.greeting),
      system_prompt: form.systemPrompt.trim() || undefined,
      stt_provider: orNull(form.sttProvider),
      stt_model: orNull(form.sttModel),
      stt_language: orNull(form.sttLanguage),
      stt_base_url: orNull(form.sttBaseUrl),
      stt_api_key_ref: orNull(form.sttApiKeyRef),
      llm_provider: orNull(form.llmProvider),
      llm_model: orNull(form.llmModel),
      llm_base_url: orNull(form.llmBaseUrl),
      llm_api_key_ref: orNull(form.llmApiKeyRef),
      temperature: form.temperature,
      max_tokens: form.maxTokens,
      tts_provider: orNull(form.ttsProvider),
      tts_voice: orNull(form.ttsVoice),
      tts_model: orNull(form.ttsModel),
      tts_base_url: orNull(form.ttsBaseUrl),
      tts_api_key_ref: orNull(form.ttsApiKeyRef),
      tools: toolsParse.tools,
      fallback_destination: orNull(form.fallbackDestination),
      max_turns: form.maxTurns,
      max_duration_seconds: form.maxDurationSeconds,
      barge_in_enabled: form.bargeInEnabled,
      store_transcript: form.storeTranscript,
    };

    try {
      await onSubmit(values);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save agent');
    } finally {
      setSubmitting(false);
    }
  }, [form, isCreate, toolsParse, onSubmit]);

  return {
    form,
    setField,
    compliance,
    toolsParse,
    error,
    submitting,
    submit: () => void submit(),
  };
}
