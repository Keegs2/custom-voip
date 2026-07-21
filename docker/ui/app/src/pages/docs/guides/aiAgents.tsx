/**
 * AI Voice Agents — product guide content (PRODUCTS.md § AI Voice Agents).
 * The differentiator (in-boundary privacy) is foregrounded in plain English.
 */

import { Bot } from 'lucide-react';
import type { ProductGuideData } from '../types';
import { GUIDE_ACCENTS } from './registry';
import { P, H3, IC, B, Callout } from '../components/text';
import { CodeBlock } from '../components/code';
import { NoteCards } from '../components/apiRefs';

const ACCENT = GUIDE_ACCENTS.aiAgents;

export const aiAgentsGuide: ProductGuideData = {
  slug: 'ai-agents',
  icon: Bot,
  eyebrow: 'Product Guide',
  title: 'AI Voice Agents',
  subtitle: 'AI that answers and handles calls — and can run entirely inside your own boundary.',
  accent: ACCENT,

  plainEnglish: (
    <>
      AI Voice Agents are AI assistants that can answer and handle phone calls for you — take a message, route
      the caller, answer questions, book something, escalate to a human. The Shale twist: an agent can run{' '}
      <B>entirely inside your own boundary</B>, so the caller's conversation never leaves your infrastructure.
      That's a privacy guarantee the big cloud platforms structurally can't make.
    </>
  ),

  whoItsFor: [
    <>Anyone automating phone conversations — reception, triage, after-hours, high-volume Q&amp;A.</>,
    <>
      Regulated industries (healthcare, government, utilities) where call content can't leave your walls.
    </>,
  ],

  features: [
    {
      title: 'Build an agent in minutes',
      body: 'A name, a greeting, a personality/system prompt, a voice, and the "tools" it is allowed to use.',
    },
    {
      title: 'In-boundary by default',
      body: (
        <>
          Speech-to-text, the language model, and text-to-speech can all be self-hosted, so no call audio or
          transcript leaves your VPC. The console shows a live <B>"in-boundary" compliance badge</B> when every
          layer is self-hosted — and a clear warning if you opt into a cloud provider.
        </>
      ),
    },
    {
      title: 'Real actions via tool-calling',
      body: 'Transfer to a human, send touch-tones, capture structured data, look things up — all guarded so a caller can\'t talk the agent into dialing a premium number.',
    },
    {
      title: 'Pay per use',
      body: 'Metered usage (see Billing) — including the ability for a customer\'s own agents to pay per request.',
    },
  ],

  howItWorks: (
    <>
      You configure an agent and point a phone number or a Call Flow at it. When a call reaches the agent, Shale
      streams the caller's audio to speech-to-text, feeds the transcript plus your prompt and tools to a language
      model, speaks the reply back with text-to-speech, and executes any actions the model chooses — all in a
      live loop with barge-in.
    </>
  ),

  gettingStarted: [
    { title: 'Create an agent', body: 'In the console, give your agent a name, greeting, personality, and voice.' },
    {
      title: 'Choose your providers',
      body: 'Pick self-hosted STT/LLM/TTS for in-boundary operation, or a cloud provider if you prefer.',
    },
    { title: 'Define its tools', body: 'Grant the specific actions the agent may take (transfer, capture data, look up).' },
    { title: 'Attach it', body: 'Point a phone number or a Call Flow at the agent and place a test call.' },
  ],

  developers: {
    summary: 'Pluggable STT/LLM/TTS, OpenAI-style tool schema, mod_audio_stream media, and guardrails.',
    endpoints: [
      { method: 'GET', path: '/api/v1/ai-agents', description: 'List configured agents.' },
      { method: 'POST', path: '/api/v1/ai-agents', description: 'Create an agent (providers, prompt, voice, tools).' },
      { method: 'GET', path: '/api/v1/ai-agents/{id}/runtime-config', description: 'Report whether the agent is fully in-boundary.' },
    ],
    body: () => (
      <>
        <P>
          STT, LLM, and TTS are pluggable providers behind one interface. The LLM sees an <B>OpenAI-style tool
          schema</B> that maps to real call actions; media arrives over the <IC>mod_audio_stream</IC> WebSocket.
          Guardrails include an env-name allow-list for keys, SSRF-guarded tool HTTP, and a fraud gate on
          transfers. <IC>runtime-config</IC> reports whether the agent is fully in-boundary.
        </P>

        <H3>The in-boundary badge</H3>
        <P>
          When every layer (STT, LLM, TTS) resolves to a self-hosted provider, <IC>runtime-config</IC> reports
          the agent as fully in-boundary and the console shows a green compliance badge. Opting any single layer
          into a cloud provider flips the badge to a warning — the guarantee is only as strong as its weakest
          leg, and the UI says so plainly.
        </P>
        <CodeBlock
          label="GET /api/v1/ai-agents/{id}/runtime-config"
          code={`{
  "in_boundary": true,
  "stt": { "provider": "self-hosted", "in_boundary": true },
  "llm": { "provider": "self-hosted", "in_boundary": true },
  "tts": { "provider": "self-hosted", "in_boundary": true }
}`}
        />

        <H3>Tool schema</H3>
        <P>
          Tools are declared as an OpenAI-style JSON schema. The model may only invoke the tools you grant, and
          every invocation passes back through Shale's guards before touching the call.
        </P>
        <CodeBlock
          label="tool declaration"
          code={`{
  "name": "transfer_to_human",
  "description": "Hand the caller to a live agent",
  "parameters": {
    "type": "object",
    "properties": {
      "department": { "type": "string", "enum": ["sales", "support"] }
    },
    "required": ["department"]
  }
}`}
        />

        <NoteCards
          accent={ACCENT}
          items={[
            { title: 'Key allow-list', body: 'Provider API keys are referenced by an env-name allow-list — an agent config can never smuggle in an arbitrary secret name.' },
            { title: 'Guarded transfers', body: 'Transfers run through the same fraud gate as the rest of the platform, so a caller can\'t coax the agent into a premium destination.' },
            { title: 'Barge-in', body: 'The audio loop supports barge-in: the caller can interrupt TTS and the agent yields immediately.' },
          ]}
        />

        <Callout accent={ACCENT}>
          Managed under <IC>/v1/ai-agents</IC>. Agents can be paid for per request — see the <B>Billing &amp;
          Payments</B> guide's machine-payments section.
        </Callout>
      </>
    ),
  },
};
