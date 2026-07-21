/**
 * Remote Call Forwarding — product guide content (PRODUCTS.md § Remote Call
 * Forwarding). Plain-English value up top; the DID→forward_to REST reference
 * lives in the "For developers" accordion.
 */

import { PhoneForwarded } from 'lucide-react';
import type { ProductGuideData } from '../types';
import { GUIDE_ACCENTS } from './registry';
import { P, H3, IC, B, Callout } from '../components/text';
import { CodeBlock, ReqRes } from '../components/code';
import { ParamTable, NoteCards } from '../components/apiRefs';

const ACCENT = GUIDE_ACCENTS.rcf;

export const rcfGuide: ProductGuideData = {
  slug: 'rcf',
  icon: PhoneForwarded,
  eyebrow: 'Product Guide',
  title: 'Remote Call Forwarding',
  subtitle: 'Point any phone number wherever you want, and change it instantly.',
  accent: ACCENT,

  plainEnglish: (
    <>
      RCF gives you a phone number that you can point anywhere — a cell phone, a call center, another office —
      and repoint in seconds whenever you want. Your published number never changes; where it rings is entirely
      up to you.
    </>
  ),

  whoItsFor: [
    <>Businesses with published numbers that must always reach a live destination.</>,
    <>Utilities, multi-location retailers, and service companies.</>,
    <>Anyone who can't afford a number to go dead when a location, vendor, or on-call person changes.</>,
  ],

  features: [
    { title: 'Nationwide numbers', body: 'Phone numbers (DIDs) in the area codes you need.' },
    {
      title: 'Instant forwarding changes',
      body: 'Update the destination and the next call follows the new rule immediately.',
    },
    {
      title: 'Carrier-grade reliability',
      body: 'Every call routes through redundant SBCs and multiple carrier paths, with automatic failover across availability zones. If one zone or carrier has trouble, the call takes another path.',
    },
    {
      title: 'A clean management portal',
      body: 'Manage your numbers, see call activity, and edit forwarding — no support tickets required.',
    },
  ],

  howItWorks: (
    <>
      Shale owns the phone number on a carrier network. When someone dials it, the call enters Shale's session
      border controllers, which look up your forwarding rule and bridge the call out to your destination over a
      carrier trunk — trying multiple SBC and carrier combinations until one connects. You never touch the
      plumbing; you just set "forward to".
    </>
  ),

  gettingStarted: [
    { title: 'Sign up', body: 'Create your account and tell us the area codes you need.' },
    { title: 'Get a number', body: 'Have a number assigned from inventory, or port your own existing number.' },
    {
      title: 'Set the destination',
      body: (
        <>
          Set the number's <B>forward-to</B> destination in the portal in E.164 format (e.g. <IC>+17745551234</IC>).
        </>
      ),
    },
    { title: 'You are live', body: "That's it — the number is live, and you can repoint it any time in seconds." },
  ],

  developers: {
    summary: 'DID → forward_to mapping, ring plans, and the /v1/rcf REST API.',
    endpoints: [
      { method: 'GET', path: '/api/v1/rcf', description: 'List all RCF entries for your account, with optional filters.' },
      { method: 'GET', path: '/api/v1/rcf/{did}', description: 'Retrieve one RCF entry by its (URL-encoded) DID.' },
      { method: 'POST', path: '/api/v1/rcf', description: 'Provision a new RCF forwarding entry.' },
      { method: 'PUT', path: '/api/v1/rcf/{identifier}', description: 'Partially update a forwarding entry — numeric ID or E.164 DID.' },
      { method: 'DELETE', path: '/api/v1/rcf/{identifier}', description: 'Permanently remove a forwarding entry (idempotent).' },
    ],
    body: () => (
      <>
        <P>
          RCF is a DID → <IC>forward_to</IC> mapping with per-number ring timeout, caller-ID passthrough, and
          optional multi-destination ring plans (sequential or simultaneous). Routing is a real-time database
          lookup on every inbound call, followed by a <B>4-attempt SBC × carrier failover bridge</B> with
          sub-second dead-path detection. International/premium destinations are gated by a fraud policy.
        </P>

        <H3>Fields</H3>
        <ParamTable
          params={[
            { name: 'did', type: 'string', required: true, description: 'The inbound DID (E.164) allocated to your account.' },
            { name: 'forward_to', type: 'string', required: true, description: 'Destination to forward calls to (E.164).' },
            { name: 'name', type: 'string', required: false, description: 'A friendly label. Shown only in the portal.' },
            { name: 'pass_caller_id', type: 'boolean', required: false, description: 'Pass the original caller ID through to the destination. Default: true.' },
            { name: 'ring_timeout', type: 'integer', required: false, description: 'Seconds to ring the destination before giving up. Range 5–120. Default: 30.' },
            { name: 'failover_to', type: 'string', required: false, description: 'Backup destination (E.164) called if ring_timeout expires.' },
            { name: 'enabled', type: 'boolean', required: false, description: 'Whether to start forwarding immediately. Default: true.' },
          ]}
        />

        <H3>Change a forwarding destination</H3>
        <P>
          The <IC>identifier</IC> path parameter accepts either a numeric ID or a URL-encoded E.164 DID (encode{' '}
          <IC>+</IC> as <IC>%2B</IC>), so you can update by DID without first fetching the numeric ID. Updates are
          partial — send only the fields you want to change.
        </P>
        <ReqRes
          request={`curl -X PUT "https://your-portal-url/api/v1/rcf/%2B17745554321" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "forward_to": "+16175553333" }'`}
          response={`{
  "did": "+17745554321",
  "forward_to": "+16175553333",
  "enabled": true,
  "pass_caller_id": true,
  "ring_timeout": 25,
  "failover_to": "+18005550000",
  "customer_id": 7,
  "updated_at": "2026-04-23T12:00:00Z"
}`}
        />

        <H3>Delete an entry</H3>
        <CodeBlock
          label="request"
          code={`curl -X DELETE "https://your-portal-url/api/v1/rcf/%2B17745554321" \
  -H "Authorization: Bearer <token>"
# Returns: 204 No Content — no response body`}
        />

        <NoteCards
          accent={ACCENT}
          items={[
            { title: 'Changes are immediate', body: 'New calls route to the updated destination as soon as you save. Calls already in progress are unaffected.' },
            { title: 'DELETE is idempotent', body: 'DELETE returns 204 whether or not the DID existed — always safe to retry after a network timeout.' },
            { title: 'E.164 everywhere', body: 'All numbers use E.164: a leading + followed by country code and subscriber number, no spaces. Example: +17745551234.' },
          ]}
        />

        <Callout accent={ACCENT}>
          Managed under <IC>/v1/rcf</IC>. See the shared authentication + error-handling conventions in the{' '}
          <B>Quality, Tooling &amp; Trust</B> guide's developer section.
        </Callout>
      </>
    ),
  },
};
