/**
 * Platform: Quality, Tooling & Trust — product guide content
 * (PRODUCTS.md § Platform: quality, tooling, and trust + Security & compliance).
 *
 * This guide also carries the SHARED developer conventions (authentication,
 * base URL, rate limits, HTTP status codes) that the other guides link to, so
 * the auth/error material lives here once rather than repeated per product.
 */

import { ShieldCheck } from 'lucide-react';
import type { ProductGuideData } from '../types';
import { GUIDE_ACCENTS } from './registry';
import { P, H3, IC, B, Callout } from '../components/text';
import { CodeBlock } from '../components/code';
import { ParamTable, StatusTable } from '../components/apiRefs';
import { DOCS, MONO, endpointRow } from '../styles';

const ACCENT = GUIDE_ACCENTS.platform;

/** The shared HTTP status reference rows, rendered inside the dev accordion. */
const HTTP_STATUS_ROWS = [
  { status: '200 OK', meaning: 'Request succeeded. Response body contains the requested data.' },
  { status: '201 Created', meaning: 'Resource created successfully.' },
  { status: '204 No Content', meaning: 'Request succeeded with no response body (used by DELETE).' },
  { status: '400 Bad Request', meaning: 'Request body or query parameters are invalid. Check the detail field.' },
  { status: '401 Unauthorized', meaning: 'No token supplied, or the token has expired. Re-authenticate and retry.' },
  { status: '403 Forbidden', meaning: 'Token is valid but lacks permission for this resource.' },
  { status: '404 Not Found', meaning: 'The requested resource does not exist in your account.' },
  { status: '409 Conflict', meaning: 'Resource already exists. Use PUT to update an existing entry.' },
  { status: '422 Unprocessable', meaning: 'Validation error — parseable body that failed field-level validation.' },
  { status: '429 Too Many Requests', meaning: 'Rate limit hit. Honour the Retry-After header and back off.' },
  { status: '500 Server Error', meaning: 'Unexpected server-side error. Contact Granite support if it persists.' },
];

export const platformGuide: ProductGuideData = {
  slug: 'platform',
  icon: ShieldCheck,
  eyebrow: 'Platform',
  title: 'Quality, Tooling & Trust',
  subtitle: 'The analytics, self-service tracing, and security foundation under every product.',
  accent: ACCENT,

  plainEnglish: (
    <>
      Beyond the products, every Shale account rides on the same platform: analytics that prove your call
      quality, self-service tools to trace a specific call, a visual builder for call handling, and a security &amp;
      compliance foundation built in — not bolted on. This is why you can trust that Shale is real and
      carrier-grade.
    </>
  ),

  whoItsFor: [
    <>Everyone — these capabilities come with every account, on every product.</>,
    <>Ops and support teams who need to prove and troubleshoot audio quality.</>,
    <>Buyers in regulated industries who need real security and compliance guarantees.</>,
  ],

  features: [
    {
      title: 'Call Quality analytics',
      body: 'MOS, jitter, packet loss, and R-factor per call, with trends and a call-detail drill-down — so you can prove and troubleshoot audio quality.',
    },
    {
      title: 'Troubleshooting (SIP ladder)',
      body: 'A native, per-call signaling ladder with packet inspection and cross-leg correlation — self-service call tracing more detailed than what most carriers expose.',
    },
    {
      title: 'Call Flow Builder',
      body: 'A visual, drag-and-drop editor to design call handling (menus, schedules, routing) for any product, with simulate and version history.',
    },
    {
      title: 'STIR/SHAKEN',
      body: 'Call authentication (as the carrier of record) to fight spoofing and keep your calls trusted.',
    },
    {
      title: 'E911',
      body: "Dispatchable location and Kari's Law notification for outbound-capable products — a life-safety requirement treated as a launch gate.",
    },
    {
      title: 'Encryption at rest',
      body: 'Voicemail, recordings, and chat use envelope encryption with a customer-verifiable crypto-erase.',
    },
    {
      title: 'Strict tenant isolation',
      body: 'Your data is scoped to your account on every endpoint, with a durable admin audit trail.',
    },
    {
      title: 'Fraud controls',
      body: 'International/premium destination gating, plus per-customer concurrency and rate caps.',
    },
  ],

  howItWorks: (
    <>
      Quality metrics are captured per session and rolled into trends and per-call drill-downs. The SIP ladder
      reconstructs a call's signaling across every hop and correlates the A-leg and B-leg into one view. Security
      controls — STIR/SHAKEN attestation, encryption at rest, tenant scoping, fraud gating — run on the call path
      and at every API endpoint, so trust is a property of the platform rather than an add-on.
    </>
  ),

  gettingStarted: [
    { title: 'It is already on', body: 'Quality analytics, tracing, STIR/SHAKEN, encryption, and tenant isolation apply to every account automatically.' },
    { title: 'Open Call Quality', body: 'Review MOS/jitter/packet-loss trends and drill into any call.' },
    { title: 'Trace a call', body: 'Use Troubleshooting to pull a specific call\'s SIP ladder and inspect packets.' },
  ],

  ctaLabel: 'Request access',

  developers: {
    summary: 'Shared API conventions: authentication, base URL, rate limits, and HTTP status codes.',
    body: () => (
      <>
        <P>
          The Shale API is RESTful and JSON-based. Every request to a protected endpoint includes an{' '}
          <IC>Authorization</IC> header with a valid JWT bearer token, obtained by POSTing credentials to the
          login endpoint. Tokens are valid for <B>8 hours</B>. These conventions apply to every product API
          (RCF, Programmable Voice, Trunks, AI Agents, Toll-Free, Billing).
        </P>

        <H3>Authenticate</H3>
        <ParamTable
          params={[
            { name: 'email', type: 'string', required: true, description: 'The email associated with your Shale account.' },
            { name: 'password', type: 'string', required: true, description: 'Your account password.' },
          ]}
        />
        <CodeBlock
          label="POST /api/auth/login → then use the token"
          code={`# 1. Authenticate and capture the token
TOKEN=$(curl -s -X POST https://your-portal-url/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"your-password"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# 2. Call any product endpoint with the bearer token
curl "https://your-portal-url/api/v1/rcf" \
  -H "Authorization: Bearer $TOKEN"`}
        />

        <H3>Base URL</H3>
        <div style={endpointRow}>
          <div>
            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: DOCS.textMuted, marginBottom: 3 }}>Base URL</div>
            <code style={{ color: DOCS.code.path, fontFamily: MONO, fontSize: '0.82rem' }}>
              https://{'<'}your-portal-url{'>'}/api
            </code>
          </div>
        </div>

        <H3>Rate limits</H3>
        <P>
          The API enforces <B>100 requests per minute</B> per token. Exceeding it returns{' '}
          <IC>429 Too Many Requests</IC> with a <IC>Retry-After</IC> header. For bulk provisioning, contact your
          Granite account team about a higher limit.
        </P>

        <H3>HTTP status codes</H3>
        <StatusTable rows={HTTP_STATUS_ROWS} />

        <P>Error responses always include a human-readable <IC>detail</IC> field:</P>
        <CodeBlock label="error response" code={`{ "detail": "RCF entry +17745554321 not found" }`} />

        <Callout accent={ACCENT}>
          <B>Phone number format:</B> all numbers are E.164 — a leading <IC>+</IC>, country code, subscriber
          number, no spaces. In a URL path, encode <IC>+</IC> as <IC>%2B</IC> (e.g.{' '}
          <IC>/api/v1/rcf/%2B17745551234</IC>).
        </Callout>

        <Callout accent={ACCENT}>
          Compliance items needing external provisioning or legal sign-off — STIR/SHAKEN certificate issuance,
          per-line E911 location, and holding funds — are explicit gates before the relevant feature goes live.
        </Callout>
      </>
    ),
  },
};
