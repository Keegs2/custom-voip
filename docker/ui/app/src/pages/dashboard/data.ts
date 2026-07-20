/**
 * Static card data for the Dashboard hub.
 *
 * Icons are stored as lucide-react *component references* (not rendered JSX) so
 * this stays a pure data module — no JSX, no component exports — keeping
 * react-refresh/only-export-components happy and the page composition thin.
 */

import {
  Globe,
  Zap,
  Shield,
  Activity,
  PhoneForwarded,
  Phone,
  Webhook,
  Voicemail,
  MessageCircle,
} from 'lucide-react';
import type { CapabilityCardData, ProductCardData } from './types';

export const CAPABILITY_CARDS: CapabilityCardData[] = [
  {
    icon: Globe,
    title: 'Multi-Zone Redundancy',
    description:
      'Three availability zones with active traffic distribution. Calls route to the nearest healthy zone. If a zone becomes unavailable, traffic fails over automatically — no manual intervention, no hardware swap.',
  },
  {
    icon: Zap,
    title: 'Purpose-Built SIP Architecture',
    description:
      'Multi-layer SIP proxy design with sub-10ms latency to signaling endpoints. Intelligent session management handles timer negotiation automatically. SRTP-ready media paths and STIR/SHAKEN attestation on every call.',
  },
  {
    icon: Shield,
    title: '99.999% Uptime Target',
    description:
      'Dual SBC layer fronted by network load balancers with continuous health monitoring. Failed components are detected and bypassed in under 15 seconds. Self-healing by design.',
  },
  {
    icon: Activity,
    title: 'Intelligent Call Routing',
    description:
      'Every call passes through a proprietary routing engine with real-time fraud detection, velocity limiting, and quality analysis. MOS scoring is captured per session for full visibility.',
  },
];

export const PRODUCT_CARDS: ProductCardData[] = [
  {
    icon: PhoneForwarded,
    title: 'Remote Call Forwarding',
    subtitle: 'Intelligent DID forwarding with multi-zone redundancy',
    active: true,
    route: '/rcf',
  },
  {
    icon: Phone,
    title: 'SIP Trunking',
    subtitle: 'Enterprise SIP connectivity',
    active: true,
    route: '/trunks',
  },
  {
    icon: Webhook,
    title: 'Programmable Voice',
    subtitle: 'Program your inbound numbers — webhook-driven call control with TwiML',
    active: true,
    route: '/programmable-voice',
  },
  {
    icon: Voicemail,
    title: 'Voicemail',
    subtitle: 'Visual voicemail with transcription & encrypted storage',
    active: true,
    route: '/voicemail',
  },
  {
    icon: MessageCircle,
    title: 'Unified Comms',
    subtitle: 'Chat, meetings, calendar & documents',
    active: true,
    route: '/communications',
  },
];
