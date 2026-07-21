/**
 * SIP Trunking — product guide content (PRODUCTS.md § SIP Trunking).
 */

import { Server } from 'lucide-react';
import type { ProductGuideData } from '../types';
import { GUIDE_ACCENTS } from './registry';
import { P, H3, IC, B, Callout } from '../components/text';
import { NoteCards } from '../components/apiRefs';

const ACCENT = GUIDE_ACCENTS.sipTrunking;

export const sipTrunkingGuide: ProductGuideData = {
  slug: 'sip-trunking',
  icon: Server,
  eyebrow: 'Product Guide',
  title: 'SIP Trunking',
  subtitle: 'Connect your existing phone system (PBX) to the world.',
  accent: ACCENT,

  plainEnglish: (
    <>
      If you already have a phone system — an on-prem PBX or a cloud PBX — SIP Trunking is the pipe that connects
      it to the rest of the world's phone network. Bring your own equipment; we provide the dial tone, the
      numbers, and the carrier connections.
    </>
  ),

  whoItsFor: [
    <>Businesses with an existing PBX (FreePBX, 3CX, Asterisk, Microsoft Teams, and similar).</>,
    <>Teams that want reliable, elastic calling without being locked into a hardware carrier.</>,
  ],

  features: [
    {
      title: 'IP-authenticated trunks',
      body: "Register your PBX's IP and you're connected — no fragile credentials to leak.",
    },
    {
      title: 'Inbound & outbound',
      body: 'Inbound DID routing to your PBX, and outbound calling to any destination.',
    },
    {
      title: 'Elastic capacity',
      body: 'Per-trunk concurrent-channel and calls-per-second controls that scale with your traffic.',
    },
    {
      title: 'Built-in fraud protection',
      body: 'High-risk destination blocking, velocity limits, and automatic carrier failover.',
    },
  ],

  howItWorks: (
    <>
      You tell us the IP address(es) your PBX will send calls from. Inbound calls to your DIDs are delivered to
      your PBX; outbound calls from your PBX are authenticated by IP, checked against your limits and fraud rules,
      and routed out over carrier trunks with failover.
    </>
  ),

  gettingStarted: [
    { title: 'Provision your trunk', body: 'An admin provisions your trunk on the platform.' },
    { title: 'Add your authorized IP(s)', body: "Register the source IP address(es) of your PBX for IP authentication." },
    { title: 'Assign your DIDs', body: 'Have your inbound numbers assigned to the trunk.' },
    { title: 'Point your PBX & test', body: 'Point your PBX at Shale and place a test call in each direction.' },
  ],

  ctaLabel: 'Talk to sales',

  developers: {
    summary: 'IP auth, DID routing, per-trunk limits, and the /v1/trunks API.',
    endpoints: [
      { method: 'GET', path: '/api/v1/trunks', description: 'List trunks for your account.' },
      { method: 'POST', path: '/api/v1/trunks', description: 'Create a trunk (admin-provisioned).' },
      { method: 'POST', path: '/api/v1/trunks/{id}/ips', description: 'Add an authorized source IP to a trunk.' },
      { method: 'POST', path: '/api/v1/trunks/{id}/dids', description: 'Attach an inbound DID to a trunk.' },
    ],
    body: () => (
      <>
        <P>
          A Kamailio-based SBC performs IP authentication against <IC>trunk_auth_ips</IC>; DID routing is driven by{' '}
          <IC>trunk_dids</IC>. Per-trunk CPS and channel limits plus Redis-backed velocity/fraud checks apply on
          the call path. Outbound bridges carry carrier-selection headers with 5xx/422 failover between carrier
          PoPs.
        </P>

        <H3>Authentication model</H3>
        <P>
          Trunks authenticate by <B>source IP</B>, not by SIP digest credentials — there's nothing to leak or
          rotate. Register every egress IP your PBX may present (including NAT/edge addresses). Requests from an
          unregistered IP are rejected at the SBC before they reach routing.
        </P>

        <NoteCards
          accent={ACCENT}
          items={[
            { title: 'Elastic channels', body: 'Concurrent-channel and CPS caps are per-trunk. Raise them as your traffic grows — no re-provisioning of numbers.' },
            { title: 'Carrier failover', body: 'Outbound calls fail over across carrier PoPs on 5xx/422, transparently to your PBX.' },
            { title: 'Fraud gating', body: 'High-risk / premium destinations are gated by policy, and velocity limits blunt toll-fraud bursts.' },
          ]}
        />

        <Callout accent={ACCENT}>
          Managed under <IC>/v1/trunks</IC>. Trunk provisioning (create trunk, authorize IPs, assign DIDs) is an
          admin-assisted workflow.
        </Callout>
      </>
    ),
  },
};
