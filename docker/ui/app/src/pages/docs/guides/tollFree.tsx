/**
 * Toll-Free & Wholesale — product guide content
 * (PRODUCTS.md § Toll-Free & Wholesale).
 */

import { Hash } from 'lucide-react';
import type { ProductGuideData } from '../types';
import { GUIDE_ACCENTS } from './registry';
import { P, H3, IC, B, Callout } from '../components/text';
import { NoteCards } from '../components/apiRefs';

const ACCENT = GUIDE_ACCENTS.tollFree;

export const tollFreeGuide: ProductGuideData = {
  slug: 'toll-free',
  icon: Hash,
  eyebrow: 'Product Guide',
  title: 'Toll-Free & Wholesale',
  subtitle: '8XX numbers, bulk number management, and least-cost routing.',
  accent: ACCENT,

  plainEnglish: (
    <>
      This is the heavy-duty side of the platform: 8XX toll-free numbers, managing thousands of numbers at once,
      and automatically sending each call over the cheapest quality route.
    </>
  ),

  whoItsFor: [
    <>High-volume and wholesale buyers.</>,
    <>Anyone managing a large inventory of numbers or reselling voice.</>,
  ],

  features: [
    {
      title: 'Toll-free / RespOrg',
      body: 'Provision and control 8XX numbers, manage their routing records, and steer them across carriers.',
    },
    {
      title: 'Bulk operations',
      body: 'Import and reassign numbers by the thousands in one action.',
    },
    {
      title: 'Least-Cost Outbound (LCO)',
      body: (
        <>
          Every outbound call is routed over the cheapest carrier that meets your quality bar, with a{' '}
          <B>transparent savings report</B> showing exactly what you saved versus a baseline.
        </>
      ),
    },
    {
      title: 'CNAM & porting',
      body: 'CNAM and porting workflows built for large inventories.',
    },
  ],

  howItWorks: (
    <>
      You manage a toll-free inventory and a per-carrier rate deck. When a call goes out, the routing engine
      longest-prefix-matches the destination against the rate deck and picks the cheapest-first carrier ordering,
      honoring any per-customer carrier preferences — then reports the savings.
    </>
  ),

  gettingStarted: [
    { title: 'Load your numbers', body: 'Wholesale onboarding is admin-assisted: import your toll-free inventory.' },
    { title: 'Load your rate decks', body: 'Provide per-carrier rate decks the routing engine will price against.' },
    { title: 'Set carrier preferences', body: 'Define any per-customer allow/deny and preferred-carrier policy.' },
    { title: 'Route', body: 'Send traffic and watch the savings report versus your baseline.' },
  ],

  ctaLabel: 'Talk to sales',

  developers: {
    summary: 'toll_free_numbers + batch import, carrier rate decks, lco_decide() on the call path, and savings over rated CDRs.',
    endpoints: [
      { method: 'GET', path: '/api/v1/toll-free', description: 'List toll-free numbers in your inventory.' },
      { method: 'POST', path: '/api/v1/toll-free/import', description: 'Batch-import numbers by the thousands.' },
      { method: 'GET', path: '/api/v1/lco/savings', description: 'Savings report computed over rated CDRs.' },
    ],
    body: () => (
      <>
        <P>
          Inventory lives in <IC>toll_free_numbers</IC> with a batch importer. Routing reads a{' '}
          <IC>carrier_rate_decks</IC> table exposed through an <IC>lco_route</IC> view and an <IC>lco_decide()</IC>{' '}
          function that FreeSWITCH consults on the call path. A per-customer allow/deny policy constrains carrier
          selection; savings are computed over rated CDRs.
        </P>

        <H3>How a route is chosen</H3>
        <P>
          For each outbound call, <IC>lco_decide()</IC> longest-prefix-matches the dialed number against every
          carrier's rate deck, filters to carriers that clear your quality bar and your allow/deny policy, then
          orders them cheapest-first. The winning carrier is used; the delta versus a configured baseline rate is
          recorded on the CDR so the savings report is auditable per call.
        </P>

        <NoteCards
          accent={ACCENT}
          items={[
            { title: 'Longest-prefix match', body: 'Destinations match on the most specific rate-deck prefix, so country/region-specific rates win over broad defaults.' },
            { title: 'Quality bar first', body: 'LCO only considers carriers that meet your quality threshold — cheapest that still delivers, not cheapest at any cost.' },
            { title: 'Transparent savings', body: 'Savings are computed over rated CDRs versus a baseline, so every dollar saved traces to specific calls.' },
          ]}
        />

        <Callout accent={ACCENT}>
          Managed under <IC>/v1/toll-free</IC> and <IC>/v1/lco</IC>. Wholesale onboarding (inventory + rate decks +
          carrier preferences) is admin-assisted.
        </Callout>
      </>
    ),
  },
};
