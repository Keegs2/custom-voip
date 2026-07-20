/**
 * AgentForm — the create / edit AI-agent form. All field state, validation, the
 * live compliance estimate, and the build-and-submit pipeline live in
 * `useAgentForm`; this component is presentation + wiring only.
 *
 * Layout: identity → three provider layers (STT / LLM / TTS) → guardrails →
 * tools. A live (estimated) compliance banner sits at the top; the authoritative
 * boundary status is verified from runtime-config (Runtime drawer) after save.
 */

import { Mic, Cpu, Volume2, SlidersHorizontal, User, Wand2 } from 'lucide-react';
import { FormField } from '../../../../components/ui/FormField';
import { Button } from '../../../../components/ui/Button';
import { GLASS } from '../../../../components/glass/glass';
import type { AiAgent, AiAgentCreate } from '../../../../types/aiAgent';
import { useAgentForm } from '../hooks';
import {
  STT_PROVIDERS,
  LLM_PROVIDERS,
  TTS_PROVIDERS,
  TEMP_MIN,
  TEMP_MAX,
  TOKENS_MIN,
  TOKENS_MAX,
  TURNS_MIN,
  TURNS_MAX,
  DURATION_MIN,
  DURATION_MAX,
} from '../types';
import {
  groupLabel,
  formSection,
  formGrid,
  formError,
  sliderLabel,
  sliderValue,
  slider,
  toggleRow,
  toggleTrack,
  toggleKnob,
  toggleTitle,
  toggleHint,
  helpNote,
} from '../styles';
import { CompliancePreview } from './CompliancePreview';
import { ToolsEditor } from './ToolsEditor';

interface CustomerOption {
  id: number;
  name: string;
  account_type: string;
}

interface AgentFormProps {
  agent?: AiAgent;
  customers: CustomerOption[];
  onSubmit: (values: AiAgentCreate) => Promise<void>;
  onCancel: () => void;
  submitLabel: string;
}

/** Local, non-exported glass toggle (keeps the file's only export a component). */
function Toggle({
  checked,
  onChange,
  title,
  hint,
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  hint: string;
}) {
  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onChange();
    }
  };
  return (
    <div role="switch" aria-checked={checked} tabIndex={0} onClick={onChange} onKeyDown={handleKey} style={toggleRow(checked)}>
      <div style={toggleTrack(checked)}>
        <div style={toggleKnob(checked)} />
      </div>
      <div>
        <div style={toggleTitle}>{title}</div>
        <div style={toggleHint}>{hint}</div>
      </div>
    </div>
  );
}

export function AgentForm({ agent, customers, onSubmit, onCancel, submitLabel }: AgentFormProps) {
  const isCreate = !agent;
  const { form, setField, compliance, toolsParse, error, submitting, submit } = useAgentForm(agent, isCreate, onSubmit);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {error && <p style={formError}>{error}</p>}

      <CompliancePreview estimate={compliance} />

      {/* Identity */}
      <div>
        <div style={groupLabel()}>
          <User size={13} /> Identity
        </div>
        <div style={formGrid}>
          {isCreate && (
            <FormField
              as="select"
              label="Customer"
              required
              value={form.customerId}
              onChange={(e) => setField('customerId', e.target.value)}
            >
              <option value="">Select customer…</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.account_type.toUpperCase()})
                </option>
              ))}
            </FormField>
          )}
          <FormField
            label="Agent Name"
            required
            value={form.name}
            onChange={(e) => setField('name', e.target.value)}
            placeholder="Support Line Assistant"
          />
          <FormField
            label="Fallback Destination"
            value={form.fallbackDestination}
            onChange={(e) => setField('fallbackDestination', e.target.value)}
            placeholder="+15551234567 or extension"
            hint="Where the call transfers on failure"
          />
        </div>
        <div style={{ marginTop: 14 }}>
          <FormField
            as="textarea"
            label="Greeting"
            value={form.greeting}
            onChange={(e) => setField('greeting', e.target.value)}
            placeholder="Hello, thanks for calling. How can I help you today?"
            style={{ minHeight: 60 }}
          />
        </div>
        <div style={{ marginTop: 14 }}>
          <FormField
            as="textarea"
            label="System Prompt"
            value={form.systemPrompt}
            onChange={(e) => setField('systemPrompt', e.target.value)}
            placeholder="You are a helpful voice assistant answering a phone call…"
            style={{ minHeight: 90 }}
          />
        </div>
      </div>

      {/* STT */}
      <div style={formSection}>
        <div style={groupLabel()}>
          <Mic size={13} /> Speech-to-Text (STT)
        </div>
        <div style={formGrid}>
          <FormField as="select" label="Provider" value={form.sttProvider} onChange={(e) => setField('sttProvider', e.target.value)}>
            {STT_PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </FormField>
          <FormField label="Model" value={form.sttModel} onChange={(e) => setField('sttModel', e.target.value)} placeholder="e.g. base.en" />
          <FormField label="Language" value={form.sttLanguage} onChange={(e) => setField('sttLanguage', e.target.value)} placeholder="e.g. en" />
          <FormField label="Base URL" value={form.sttBaseUrl} onChange={(e) => setField('sttBaseUrl', e.target.value)} placeholder="http://whisper.svc:8080" hint="Internal URL keeps it in-VPC" />
          <FormField label="API Key — env var name" value={form.sttApiKeyRef} onChange={(e) => setField('sttApiKeyRef', e.target.value)} placeholder="DEEPGRAM_API_KEY" hint="ENV VAR NAME, never a secret" />
        </div>
      </div>

      {/* LLM */}
      <div style={formSection}>
        <div style={groupLabel()}>
          <Cpu size={13} /> Language Model (LLM)
        </div>
        <div style={formGrid}>
          <FormField as="select" label="Provider" value={form.llmProvider} onChange={(e) => setField('llmProvider', e.target.value)}>
            {LLM_PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </FormField>
          <FormField label="Model" value={form.llmModel} onChange={(e) => setField('llmModel', e.target.value)} placeholder="e.g. llama-3.1-8b-instruct" />
          <FormField label="Base URL" value={form.llmBaseUrl} onChange={(e) => setField('llmBaseUrl', e.target.value)} placeholder="http://vllm.svc:8000/v1" hint="Internal URL keeps it in-VPC" />
          <FormField label="API Key — env var name" value={form.llmApiKeyRef} onChange={(e) => setField('llmApiKeyRef', e.target.value)} placeholder="OPENAI_API_KEY" hint="ENV VAR NAME, never a secret" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 20, marginTop: 16 }}>
          <div>
            <div style={sliderLabel}>
              <span>Temperature</span>
              <span style={sliderValue}>{form.temperature.toFixed(2)}</span>
            </div>
            <input type="range" min={TEMP_MIN} max={TEMP_MAX} step={0.05} value={form.temperature} onChange={(e) => setField('temperature', Number(e.target.value))} style={slider()} />
          </div>
          <div>
            <div style={sliderLabel}>
              <span>Max Tokens</span>
              <span style={sliderValue}>{form.maxTokens}</span>
            </div>
            <input type="range" min={TOKENS_MIN} max={TOKENS_MAX} step={16} value={form.maxTokens} onChange={(e) => setField('maxTokens', Number(e.target.value))} style={slider()} />
          </div>
        </div>
      </div>

      {/* TTS */}
      <div style={formSection}>
        <div style={groupLabel()}>
          <Volume2 size={13} /> Text-to-Speech (TTS)
        </div>
        <div style={formGrid}>
          <FormField as="select" label="Provider" value={form.ttsProvider} onChange={(e) => setField('ttsProvider', e.target.value)}>
            {TTS_PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </FormField>
          <FormField label="Voice" value={form.ttsVoice} onChange={(e) => setField('ttsVoice', e.target.value)} placeholder="e.g. en_US-amy" />
          <FormField label="Model" value={form.ttsModel} onChange={(e) => setField('ttsModel', e.target.value)} placeholder="optional" />
          <FormField label="Base URL" value={form.ttsBaseUrl} onChange={(e) => setField('ttsBaseUrl', e.target.value)} placeholder="http://piper.svc:59125" hint="Internal URL keeps it in-VPC" />
          <FormField label="API Key — env var name" value={form.ttsApiKeyRef} onChange={(e) => setField('ttsApiKeyRef', e.target.value)} placeholder="ELEVENLABS_API_KEY" hint="ENV VAR NAME, never a secret" />
        </div>
      </div>

      {/* Guardrails */}
      <div style={formSection}>
        <div style={groupLabel()}>
          <SlidersHorizontal size={13} /> Behavior &amp; Guardrails
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
          <Toggle checked={form.bargeInEnabled} onChange={() => setField('bargeInEnabled', !form.bargeInEnabled)} title="Barge-in" hint="Let the caller interrupt the agent" />
          <Toggle checked={form.storeTranscript} onChange={() => setField('storeTranscript', !form.storeTranscript)} title="Store transcript" hint="Persist the call transcript" />
        </div>
        <div style={{ ...formGrid, marginTop: 14 }}>
          <FormField
            label="Max Turns"
            type="number"
            min={TURNS_MIN}
            max={TURNS_MAX}
            value={form.maxTurns}
            onChange={(e) => setField('maxTurns', Number(e.target.value))}
          />
          <FormField
            label="Max Duration (seconds)"
            type="number"
            min={DURATION_MIN}
            max={DURATION_MAX}
            value={form.maxDurationSeconds}
            onChange={(e) => setField('maxDurationSeconds', Number(e.target.value))}
          />
        </div>
      </div>

      {/* Tools */}
      <div style={formSection}>
        <div style={groupLabel()}>
          <Wand2 size={13} /> Tools
        </div>
        <ToolsEditor value={form.toolsJson} onChange={(v) => setField('toolsJson', v)} parse={toolsParse} />
      </div>

      <p style={helpNote}>
        API keys are referenced by <strong style={{ color: GLASS.textMuted }}>environment variable name</strong> and resolved at call time — no secret is ever
        stored on the agent or shown here.
      </p>

      {/* Footer */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 2 }}>
        <Button onClick={submit} loading={submitting} disabled={!toolsParse.ok}>
          {submitLabel}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
