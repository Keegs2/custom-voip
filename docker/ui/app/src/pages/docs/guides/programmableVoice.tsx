/**
 * Programmable Voice — product guide content (PRODUCTS.md § Programmable Voice).
 * Developer-facing product, so the "For developers" accordion carries the
 * fullest technical detail: the verb engine, REST call control, signed
 * webhooks, media streaming, and the shared auth/rate-limit conventions.
 */

import { Webhook } from 'lucide-react';
import type { ProductGuideData } from '../types';
import { GUIDE_ACCENTS } from './registry';
import { P, H3, IC, B, Callout } from '../components/text';
import { CodeBlock, ReqRes } from '../components/code';
import { NoteCards } from '../components/apiRefs';
import { MONO } from '../styles';

const ACCENT = GUIDE_ACCENTS.programmableVoice;

const VERBS = [
  'Say', 'Play', 'Gather', 'Dial', 'Record', 'Conference', 'Enqueue', 'Stream / Connect',
];

export const programmableVoiceGuide: ProductGuideData = {
  slug: 'programmable-voice',
  icon: Webhook,
  eyebrow: 'Product Guide · For Developers',
  title: 'Programmable Voice',
  subtitle: 'Control calls with code — build phone apps and automations.',
  accent: ACCENT,

  plainEnglish: (
    <>
      Programmable Voice lets you control phone calls with code. When someone calls your number, Shale asks{' '}
      <B>your</B> server what to do — say something, play audio, gather digits, connect the call, record it, run a
      menu — and does it. It's how you build phone apps: appointment reminders, IVRs, click-to-call,
      notifications, surveys.
    </>
  ),

  whoItsFor: [
    <>Developers and product teams who want to add calling to their software.</>,
    <>Teams migrating from another CPaaS — the instruction set is TwiML-compatible, so you're already fluent.</>,
    <>Anyone building appointment reminders, IVRs, click-to-call, notifications, or surveys.</>,
  ],

  features: [
    {
      title: 'Familiar verb set (~14 verbs)',
      body: (
        <>
          A TwiML-compatible instruction set: Say, Play, Gather, Dial, Record, Conference, Enqueue,
          Stream/Connect and more — if you've used other CPaaS platforms, you're already fluent.
        </>
      ),
    },
    {
      title: 'REST call control',
      body: 'Start calls, hang up, transfer, send DTMF, and redirect a live call to new instructions.',
    },
    {
      title: 'Signed webhooks',
      body: (
        <>
          Webhooks for every call event, cryptographically signed (<IC>X-Revup-Signature</IC>, HMAC-SHA256) so
          you can trust they came from us.
        </>
      ),
    },
    {
      title: 'Real-time media streaming',
      body: 'Fork call audio to your own service over WebSocket — the on-ramp for transcription and AI.',
    },
    {
      title: 'Call recording',
      body: 'Record to secure object storage with tokenized playback.',
    },
  ],

  howItWorks: (
    <>
      You point a number's <B>voice URL</B> at your server. When a call comes in, Shale POSTs the call details to
      your URL; you respond with XML instructions; Shale executes them and calls back for the next step. Outbound
      is the mirror image: you originate a call via the REST API and drive it the same way.
    </>
  ),

  gettingStarted: [
    { title: 'Get an API-enabled number', body: 'Provision a programmable number for your account.' },
    {
      title: 'Set its webhook URL',
      body: <>Point the number's voice URL at your server endpoint.</>,
    },
    {
      title: 'Return your first response',
      body: (
        <>
          Answer the incoming webhook with <IC>{'<Response><Say>Hello</Say></Response>'}</IC> and place a test
          call.
        </>
      ),
    },
  ],

  developers: {
    summary: 'Verb engine, REST originate + live in-call update, signed webhooks, and media streaming.',
    endpoints: [
      { method: 'POST', path: '/api/v1/calls', description: 'Originate an outbound call and drive it with your voice URL.' },
      { method: 'POST', path: '/api/v1/calls/{sid}', description: 'Update a live call — redirect it to new instructions.' },
      { method: 'POST', path: '/api/v1/calls/{sid}/hangup', description: 'End a live call.' },
    ],
    body: () => (
      <>
        <P>
          The verb engine supports <IC>{'<Dial>'}</IC> children (<IC>{'<Number>'}</IC>, <IC>{'<Sip>'}</IC>,{' '}
          <IC>{'<Client>'}</IC>, <IC>{'<Conference>'}</IC>, <IC>{'<Queue>'}</IC>), <IC>{'<Gather>'}</IC> with
          speech or DTMF, <IC>{'<Record>'}</IC>, and <IC>{'<Stream>'}</IC> / <IC>{'<Connect><Stream>'}</IC> (via
          mod_audio_stream). TTS (Piper / self-hosted) and STT are pluggable. REST originate and live in-call
          update live at <IC>/v1/calls</IC>. Idempotency and per-customer CPS limits apply.
        </P>

        <H3>The verb set</H3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
          {VERBS.map((v) => (
            <span
              key={v}
              style={{
                fontFamily: MONO,
                fontSize: '0.74rem',
                fontWeight: 700,
                color: ACCENT,
                background: 'rgba(192,132,252,0.1)',
                border: '1px solid rgba(192,132,252,0.28)',
                borderRadius: 6,
                padding: '4px 9px',
              }}
            >
              {`<${v}>`}
            </span>
          ))}
        </div>

        <H3>Answer an inbound call</H3>
        <P>Shale POSTs the call to your voice URL; respond with XML instructions.</P>
        <CodeBlock
          label="your server → xml response"
          code={`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Piper">Thanks for calling. Press 1 for sales, 2 for support.</Say>
  <Gather numDigits="1" action="https://your-app/menu">
    <Say>Please make a selection.</Say>
  </Gather>
</Response>`}
        />

        <H3>Originate an outbound call</H3>
        <ReqRes
          request={`curl -X POST https://your-portal-url/api/v1/calls \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "+17745551234",
    "to": "+16175552222",
    "voice_url": "https://your-app/outbound"
  }'`}
          response={`{
  "call_sid": "CA_9f3c1e...",
  "status": "queued",
  "from": "+17745551234",
  "to": "+16175552222"
}`}
        />

        <H3>Verify webhook signatures</H3>
        <P>
          Every webhook carries an <IC>X-Revup-Signature</IC> header — an HMAC-SHA256 of the raw request body
          keyed by your per-customer signing secret. Recompute it and compare in constant time before trusting
          the payload.
        </P>
        <CodeBlock
          label="python — verify X-Revup-Signature"
          code={`import hmac, hashlib

def verify(raw_body: bytes, signature: str, secret: str) -> bool:
    expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)`}
        />

        <NoteCards
          accent={ACCENT}
          items={[
            { title: 'SSRF-guarded fetch', body: 'Webhook delivery and tool HTTP are fetched through an SSRF guard — internal/link-local targets are refused.' },
            { title: 'Per-customer CPS', body: 'Outbound origination honours a per-customer calls-per-second cap. Batch large campaigns accordingly.' },
            { title: 'Media over WebSocket', body: '<Stream> / <Connect><Stream> forks call audio to your service over a WebSocket — the on-ramp for live transcription and AI agents.' },
          ]}
        />

        <Callout accent={ACCENT}>
          Managed under <IC>/v1/calls</IC>. Shared authentication, rate-limit, and error-handling conventions are
          documented in the <B>Quality, Tooling &amp; Trust</B> guide's developer section.
        </Callout>
      </>
    ),
  },
};
