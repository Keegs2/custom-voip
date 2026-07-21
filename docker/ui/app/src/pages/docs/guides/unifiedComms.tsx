/**
 * Unified Communications (UCaaS) — product guide content
 * (PRODUCTS.md § Unified Communications).
 */

import { MessageCircle } from 'lucide-react';
import type { ProductGuideData } from '../types';
import { GUIDE_ACCENTS } from './registry';
import { P, H3, IC, B, Callout } from '../components/text';
import { NoteCards } from '../components/apiRefs';

const ACCENT = GUIDE_ACCENTS.unifiedComms;

export const unifiedCommsGuide: ProductGuideData = {
  slug: 'unified-communications',
  icon: MessageCircle,
  eyebrow: 'Product Guide',
  title: 'Unified Communications',
  subtitle: 'A full business phone system in your browser and apps.',
  accent: ACCENT,

  plainEnglish: (
    <>
      Unified Communications is a complete business phone system that lives in your browser and apps — no desk
      phones required. Make and take calls, get visual voicemail with transcripts, chat with your team, hold
      video meetings, run call queues, and share a calendar and documents, all in one place.
    </>
  ),

  whoItsFor: [
    <>Teams and offices that want to replace — or skip — a traditional phone system.</>,
    <>Organizations that want something modern, mobile, and all-in-one.</>,
  ],

  features: [
    { title: 'Softphone', body: 'A WebRTC calling client right in the browser, with secure, encrypted media.' },
    {
      title: 'Visual voicemail',
      body: (
        <>
          See messages as a list, play them, and read transcripts. Messages are <B>encrypted at rest</B> with
          per-message keys and a customer-verifiable "erase" — a genuine per-mailbox privacy feature most business
          phone systems don't offer.
        </>
      ),
    },
    { title: 'Team chat & presence', body: 'See who is available and message your team in real time.' },
    { title: 'Meetings & conferencing', body: 'Audio/video rooms with scheduling and invites.' },
    { title: 'Call queues', body: 'Route inbound callers to the right group with hold treatment.' },
    {
      title: 'Calendar & shared documents',
      body: 'Read-only calendar integration (Google / Microsoft) and a shared document library for your organization.',
    },
  ],

  howItWorks: (
    <>
      You log in and your extension is live in the browser softphone. Calls to your DID ring your softphone;
      unanswered calls fall to encrypted voicemail and notify you. Chat, presence, meetings, and queues are
      real-time features layered on the same account.
    </>
  ),

  gettingStarted: [
    { title: 'Enable Unified Communications', body: 'Have UCaaS turned on for your account and your extension provisioned.' },
    { title: 'Set your voicemail greeting', body: 'Record or upload a greeting for your encrypted mailbox.' },
    { title: 'Start calling', body: 'Place your first call straight from the browser softphone.' },
  ],

  developers: {
    summary: 'WebRTC (mod_verto + TURN), envelope-encrypted voicemail, Redis pub/sub chat, and account-type gating.',
    body: () => (
      <>
        <P>
          WebRTC is delivered via FreeSWITCH <IC>mod_verto</IC> (over TLS) with a coturn TURN relay. Voicemail
          uses <B>envelope encryption</B> — a per-object AES-256-GCM data key wrapped by a KMS key — with
          tokenized playback. Chat and presence run over Redis pub/sub + WebSockets; conferencing via{' '}
          <IC>mod_conference</IC>; queues via <IC>mod_fifo</IC>.
        </P>

        <H3>Encrypted voicemail</H3>
        <P>
          Each message is encrypted at rest under its own data key; a customer-verifiable crypto-erase makes
          deletion provable rather than a soft flag. Playback is served through short-lived, tokenized URLs so
          audio is never exposed by a bare object path.
        </P>

        <NoteCards
          accent={ACCENT}
          items={[
            { title: 'Encrypted media', body: 'Softphone media is DTLS-SRTP; signaling is mod_verto over TLS with a TURN relay for NAT traversal.' },
            { title: 'Real-time fabric', body: 'Chat, presence, and typing indicators ride Redis pub/sub bridged to browser WebSockets.' },
            { title: 'Enforced by account type', body: 'UCaaS features are gated by account type at the API, not just the UI — an RCF-only account can never reach them.' },
          ]}
        />

        <Callout accent={ACCENT}>
          Feature access is enforced by account type at the API. UCaaS surfaces are <B>not</B> shown to RCF-only
          accounts — the gate is server-side, so a direct URL request is refused too.
        </Callout>
      </>
    ),
  },
};
