/**
 * The canonical product-guide registry — one entry per Shale product, derived
 * from PRODUCTS.md's "products at a glance" table. This is the single source of
 * truth shared by:
 *   - the /docs hub landing grid (order + pitch + best-for + accent),
 *   - the Sidebar "Documentation" nav group,
 *   - each guide page's cross-links.
 *
 * Pure data (no JSX) so it stays a plain module — icons are lucide *component
 * references*. Full guide CONTENT lives in the per-product modules alongside
 * this file (rcf.tsx, programmableVoice.tsx, …).
 */

import {
  PhoneForwarded,
  Webhook,
  Server,
  MessageCircle,
  Bot,
  Hash,
  Wallet,
  ShieldCheck,
} from 'lucide-react';
import type { GuideMeta } from '../types';

/** Per-product accent hues. Blue is the app default; each product gets a hue
 *  that echoes its Sidebar/product identity where one exists. */
export const GUIDE_ACCENTS = {
  rcf: '#4ade80', // RCF green (matches the Sidebar RCF accent)
  programmableVoice: '#c084fc', // API purple
  sipTrunking: '#fbbf24', // trunk amber
  unifiedComms: '#38bdf8', // comms sky
  aiAgents: '#a78bfa', // agent violet
  tollFree: '#f472b6', // toll-free pink
  billing: '#2dd4bf', // billing teal
  platform: '#3b82f6', // app blue
} as const;

/**
 * Ordered guide metadata. Order mirrors PRODUCTS.md: the seven products, then
 * the cross-cutting Platform (quality / tooling / trust) guide last.
 */
export const GUIDES: GuideMeta[] = [
  {
    slug: 'rcf',
    icon: PhoneForwarded,
    title: 'Remote Call Forwarding',
    pitch: 'Point any phone number wherever you want, and change it instantly.',
    bestFor: 'Businesses that need numbers to always reach the right place.',
    accent: GUIDE_ACCENTS.rcf,
  },
  {
    slug: 'programmable-voice',
    icon: Webhook,
    title: 'Programmable Voice',
    pitch: 'Control calls with code — build phone apps and automations.',
    bestFor: 'Developers and product teams.',
    accent: GUIDE_ACCENTS.programmableVoice,
  },
  {
    slug: 'sip-trunking',
    icon: Server,
    title: 'SIP Trunking',
    pitch: 'Connect your existing phone system (PBX) to the world.',
    bestFor: 'Companies with an on-prem or cloud PBX.',
    accent: GUIDE_ACCENTS.sipTrunking,
  },
  {
    slug: 'unified-communications',
    icon: MessageCircle,
    title: 'Unified Communications',
    pitch: 'A full business phone system in your browser and apps.',
    bestFor: 'Teams that want calling, voicemail, chat, and meetings in one place.',
    accent: GUIDE_ACCENTS.unifiedComms,
  },
  {
    slug: 'ai-agents',
    icon: Bot,
    title: 'AI Voice Agents',
    pitch: 'AI that answers and handles calls — and can run entirely inside your own boundary.',
    bestFor: 'Anyone automating phone conversations who cares about privacy.',
    accent: GUIDE_ACCENTS.aiAgents,
  },
  {
    slug: 'toll-free',
    icon: Hash,
    title: 'Toll-Free & Wholesale',
    pitch: '8XX numbers, bulk number management, and least-cost routing.',
    bestFor: 'High-volume and wholesale buyers.',
    accent: GUIDE_ACCENTS.tollFree,
  },
  {
    slug: 'billing',
    icon: Wallet,
    title: 'Billing & Payments',
    pitch: 'Prepaid balance with automatic top-ups — pay only for what you use.',
    bestFor: 'Every customer.',
    accent: GUIDE_ACCENTS.billing,
  },
  {
    slug: 'platform',
    icon: ShieldCheck,
    title: 'Quality, Tooling & Trust',
    pitch: 'Call analytics, self-service tracing, and the security & compliance foundation under every product.',
    bestFor: 'Everyone — the platform every Shale account rides on.',
    accent: GUIDE_ACCENTS.platform,
  },
];
