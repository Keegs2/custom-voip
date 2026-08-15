/**
 * API Reference — per-product developer documentation for the Granite CRAG
 * REST API, product-selected via /docs/api/:product? (default rcf) with the
 * same selector rail as the Guides hub.
 *
 * TRUTH CONTRACT: every endpoint, parameter, and sample below mirrors the
 * FastAPI backend (docker/api/src/routers/*). Customer-facing sections never
 * document admin-only writes as self-service — admin-only endpoints that are
 * useful context carry an explicit Admin tag.
 *
 * Styling: shared DAYLIGHT CONSOLE (`dl-*`) + docs primitives (`dlx-`/`dlx8-`).
 * React #310: hooks (useParams/useNavigate) run unconditionally at the top.
 */

import { useNavigate, useParams, Navigate, Link } from 'react-router-dom';
import { Key, Code, Phone, Zap, Server, Activity, ShieldCheck, Hash } from 'lucide-react';

import { C, MONO } from './tokens';
import {
  P, H3, IC, Callout, AccordionSection, CodeBlock, Endpoint, ParamTable,
  ReqRes, DocsHeader,
} from './shared';
import { ProductSelector } from './ProductSelector';
import { API_PRODUCTS, isApiProduct } from './docProducts';

const BLUE = '#2f7df6';
const AMBER = '#b45309';

/* ═══════════════════════════════════════════════════════════
   Shared: authentication + conventions (rendered for every product)
   ═══════════════════════════════════════════════════════════ */

function AuthSection() {
  return (
    <AccordionSection
      id="api-auth"
      icon={<Key size={18} />}
      title="Authentication &amp; conventions"
      subtitle="JWT bearer tokens, base URL, number format, and error semantics — shared by every product."
    >
      <H3>Authentication</H3>
      <Endpoint method="POST" path="/api/v1/auth/login" description="Exchange email + password for a JWT access token. Tokens are valid for 8 hours." />
      <ParamTable
        params={[
          { name: 'email',    type: 'string', required: true, description: 'The email address associated with your CRAG account.' },
          { name: 'password', type: 'string', required: true, description: 'Your account password.' },
        ]}
      />
      <ReqRes
        request={`curl -X POST https://your-portal-url/api/v1/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{
    "email": "you@example.com",
    "password": "your-password"
  }'`}
        response={`{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "bearer",
  "user": {
    "id": 42,
    "email": "you@example.com",
    "name": "Jane Smith",
    "role": "user",
    "account_type": "rcf",
    "customer_id": 7
  }
}`}
      />
      <P>Include the token in the <IC>Authorization</IC> header on every subsequent request:</P>
      <CodeBlock
        label="all authenticated requests"
        code={`curl https://your-portal-url/api/v1/rcf \\
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."`}
      />

      <H3>Base URL</H3>
      <div className="dlx-endpoint" style={{ alignItems: 'center', marginBottom: 20 }}>
        <Server size={16} style={{ color: BLUE, flexShrink: 0 }} />
        <div>
          <div style={{ fontSize: '0.72rem', fontWeight: 700, color: C.textFaint, marginBottom: 3 }}>Base URL</div>
          <code style={{ color: C.text, fontFamily: MONO, fontSize: '0.82rem', fontWeight: 600 }}>
            https://{'<'}your-portal-url{'>'}/api/v1
          </code>
        </div>
      </div>

      <H3>Tenant scoping</H3>
      <P>
        Every endpoint is scoped to your customer account. Reads only return your own resources,
        and a resource belonging to another account behaves exactly like one that does not
        exist — you get <IC>404 Not Found</IC>, never a hint that it exists. Endpoints marked{' '}
        <span className="dlx8-tag-admin">Admin</span> require the admin role and are operated by
        Granite.
      </P>

      <H3>HTTP status codes</H3>
      <div className="dlx-table-wrap">
        <table className="dlx-table">
          <thead>
            <tr>
              {['Status', 'Meaning'].map(h => (
                <th key={h} className="dl-th">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              { status: '200 OK',            meaning: 'Request succeeded. Response body contains the requested data.' },
              { status: '400 Bad Request',   meaning: 'Request is invalid — e.g. an empty update body or an unknown action. Check the detail field.' },
              { status: '401 Unauthorized',  meaning: 'No token supplied, or the token has expired. Re-authenticate and retry.' },
              { status: '403 Forbidden',     meaning: 'Token is valid but the field or endpoint requires the admin role (e.g. changing max_channels).' },
              { status: '404 Not Found',     meaning: 'The resource does not exist in your account.' },
              { status: '409 Conflict',      meaning: 'The resource is in a state that blocks the request (e.g. a number that is not available, or a release already pending).' },
              { status: '422 Unprocessable', meaning: 'Validation error — the body parsed but failed field-level validation (e.g. a malformed phone number).' },
              { status: '429 Too Many Requests', meaning: 'Call origination only — your calls-per-second tier limit was exceeded. The detail object includes your current tier and limit.' },
              { status: '500 Server Error',  meaning: 'Unexpected server-side error. Retry with backoff; contact Granite support if it persists.' },
            ].map(row => (
              <tr key={row.status}>
                <td><code className="dlx-td-code">{row.status}</code></td>
                <td>{row.meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <P>Error responses always include a <IC>detail</IC> field with a human-readable message:</P>
      <CodeBlock
        label="error response"
        code={`{
  "detail": "RCF number not found"
}`}
      />

      <Callout accent={BLUE}>
        <strong style={{ color: C.text }}>Phone number format:</strong> phone numbers are E.164 —
        a leading <IC>+</IC>, country code, and subscriber number with no spaces or dashes
        (US example <IC>+17745551234</IC>). When a number appears in a URL path, URL-encode
        the <IC>+</IC> as <IC>%2B</IC>: <IC>/api/v1/rcf/%2B17745551234</IC>. Store tokens like
        passwords, re-authenticate before the 8-hour expiry, and retry <IC>429</IC>/<IC>5xx</IC>{' '}
        with exponential backoff.
      </Callout>
    </AccordionSection>
  );
}

/* ═══════════════════════════════════════════════════════════
   RCF
   ═══════════════════════════════════════════════════════════ */

function RcfEndpointsSection() {
  return (
    <AccordionSection
      id="ref-rcf"
      icon={<Code size={18} />}
      title="RCF numbers"
      subtitle="List, read, and update your forwarding numbers. Provisioning is Granite-managed."
      defaultOpen
    >
      <P>
        The RCF API manages the forwarding configuration of numbers already assigned to your
        account. You can list, read, and update entries;{' '}
        <strong style={{ color: C.text }}>creating and deleting entries is done by Granite</strong>{' '}
        as part of number assignment — to add or remove numbers, use the number lifecycle
        endpoints in the next section.
      </P>

      <H3>List your RCF numbers</H3>
      <Endpoint method="GET" path="/v1/rcf" description="Return the RCF entries on your account (up to 100, newest first)." />
      <ParamTable
        params={[
          { name: 'enabled', type: 'boolean', required: false, description: 'true returns only enabled numbers, false only disabled ones.' },
          { name: 'customer_id', type: 'integer', required: false, description: 'Admin only — non-admin requests are always scoped to their own account and this parameter is ignored.' },
        ]}
      />
      <ReqRes
        request={`curl "https://your-portal-url/api/v1/rcf?enabled=true" \\
  -H "Authorization: Bearer <token>"`}
        response={`[
  {
    "id": 118,
    "did": "+17745551234",
    "name": "Main Office Line",
    "forward_to": "+18005559999",
    "pass_caller_id": true,
    "enabled": true,
    "ring_timeout": 30,
    "failover_to": "+18005550000",
    "max_channels": 0,
    "customer_id": 7,
    "customer_name": "Acme Utilities"
  }
]`}
      />

      <H3>Get a single number</H3>
      <Endpoint method="GET" path="/v1/rcf/{did}" description="Retrieve one RCF entry by its DID (URL-encoded E.164)." />
      <CodeBlock
        label="request"
        code={`curl "https://your-portal-url/api/v1/rcf/%2B17745551234" \\
  -H "Authorization: Bearer <token>"`}
      />

      <H3>Update a number</H3>
      <Endpoint method="PATCH" path="/v1/rcf/{identifier}" description="Partial update — send only the fields you want to change." />
      <Endpoint method="PUT" path="/v1/rcf/{identifier}" description="Identical behavior to PATCH (both perform partial updates)." />
      <P>
        The <IC>identifier</IC> path parameter accepts either the{' '}
        <strong style={{ color: C.text }}>numeric id</strong> or the{' '}
        <strong style={{ color: C.text }}>E.164 DID</strong> (URL-encoded), so you can update by
        DID without first fetching the id.
      </P>
      <ParamTable
        params={[
          { name: 'forward_to',     type: 'string',  required: false, description: 'New forwarding destination — E.164, or a 3–6 digit local PBX extension.' },
          { name: 'failover_to',    type: 'string',  required: false, description: 'Backup destination used when ring_timeout expires — E.164 or a 3–6 digit extension.' },
          { name: 'ring_timeout',   type: 'integer', required: false, description: 'Seconds to ring the destination before failover/give-up. Range 5–120.' },
          { name: 'pass_caller_id', type: 'boolean', required: false, description: 'true passes the original caller ID through; false shows your DID instead.' },
          { name: 'enabled',        type: 'boolean', required: false, description: 'Enable (true) or disable (false) forwarding.' },
          { name: 'name',           type: 'string',  required: false, description: 'Friendly label, shown only in the portal.' },
          { name: 'max_channels',   type: 'integer', required: false, description: 'Max concurrent calls on this DID (0 = unlimited). Set by Granite — non-admin requests including this field receive 403.' },
        ]}
      />
      <P>Example — change the forwarding destination:</P>
      <ReqRes
        request={`curl -X PATCH "https://your-portal-url/api/v1/rcf/%2B17745551234" \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "forward_to": "+16175553333"
  }'`}
        response={`{
  "id": 118,
  "did": "+17745551234",
  "name": "Main Office Line",
  "forward_to": "+16175553333",
  "pass_caller_id": true,
  "enabled": true,
  "ring_timeout": 30,
  "failover_to": "+18005550000",
  "max_channels": 0,
  "customer_id": 7,
  "customer_name": "Acme Utilities"
}`}
      />
      <Callout accent={BLUE}>
        Updates take effect on the very next call — the platform invalidates its routing cache
        the moment the change commits. Calls already in progress are unaffected.
      </Callout>

      <H3>Provisioning (Granite-managed)</H3>
      <P>
        These exist on the API but require the admin role — they are how Granite provisions and
        deprovisions entries. Customer requests to them receive <IC>403</IC>.
      </P>
      <Endpoint method="POST" path="/v1/rcf" admin description="Create an RCF entry (performed during number assignment)." />
      <Endpoint method="DELETE" path="/v1/rcf/{identifier}" admin description="Delete an RCF entry (performed when an approved release completes)." />
    </AccordionSection>
  );
}

function NumberLifecycleSection() {
  return (
    <AccordionSection
      id="ref-numbers"
      icon={<Phone size={18} />}
      title="Number lifecycle"
      subtitle="Your inventory, available numbers, and the request / release review flows."
    >
      <P>
        Numbers move through a <strong style={{ color: C.text }}>request-and-review</strong>{' '}
        lifecycle: you request an available number (it is reserved for you pending Granite
        review), and you release a number by requesting release (reviewed by Granite engineering
        before removal). Nothing is assigned or removed without review.
      </P>

      <H3>Your assigned numbers</H3>
      <Endpoint method="GET" path="/v1/numbers/my" description="Every DID on your account across products, with its lifecycle status." />
      <ReqRes
        request={`curl "https://your-portal-url/api/v1/numbers/my" \\
  -H "Authorization: Bearer <token>"`}
        response={`[
  {
    "did": "+17745551234",
    "product_type": "rcf",
    "status": "assigned",
    "city": "Worcester",
    "state": "MA",
    "assigned_at": "2026-01-15T10:00:00+00:00",
    "notes": null,
    "customer_id": 7,
    "customer_name": "Acme Utilities"
  }
]`}
      />
      <P>
        <IC>status</IC> is one of <IC>assigned</IC>, <IC>reserved</IC> (request awaiting
        review), or <IC>release_requested</IC> (release awaiting review — the number still
        forwards normally).
      </P>

      <H3>Browse available numbers</H3>
      <Endpoint method="GET" path="/v1/numbers/available" description="Available DIDs you can request, with location filters and pagination." />
      <ParamTable
        params={[
          { name: 'state',     type: 'string',  required: false, description: 'Two-letter US state code. Example: MA.' },
          { name: 'city',      type: 'string',  required: false, description: 'City name filter (partial match). Example: Boston.' },
          { name: 'area_code', type: 'string',  required: false, description: 'Three-digit area code. Example: 617.' },
          { name: 'search',    type: 'string',  required: false, description: 'Substring match on the number itself.' },
          { name: 'limit',     type: 'integer', required: false, description: 'Page size, 1–500. Default 50.' },
          { name: 'offset',    type: 'integer', required: false, description: 'Pagination offset. Default 0.' },
        ]}
      />
      <ReqRes
        request={`curl "https://your-portal-url/api/v1/numbers/available?state=MA&area_code=617&limit=3" \\
  -H "Authorization: Bearer <token>"`}
        response={`{
  "items": [
    { "did": "+16175551001", "city": "Boston", "state": "MA", "rate_center": "BOSTON" },
    { "did": "+16175551002", "city": "Boston", "state": "MA", "rate_center": "BOSTON" },
    { "did": "+16175551003", "city": "Boston", "state": "MA", "rate_center": "BOSTON" }
  ],
  "total": 214,
  "limit": 3,
  "offset": 0
}`}
      />

      <H3>Request a number</H3>
      <Endpoint method="POST" path="/v1/numbers/{did}/request" description="Reserve an available DID for your account, pending Granite review." />
      <ParamTable
        params={[
          { name: 'product_type', type: 'string', required: true,  description: "Which product the number is for: 'rcf', 'trunk', or 'api'." },
          { name: 'notes',        type: 'string', required: false, description: 'Optional note for the reviewing administrator.' },
        ]}
      />
      <ReqRes
        request={`curl -X POST "https://your-portal-url/api/v1/numbers/%2B16175551001/request" \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "product_type": "rcf",
    "notes": "Second line for the Boston office"
  }'`}
        response={`{
  "status": "reserved",
  "did": "+16175551001",
  "customer_id": 7,
  "product_type": "rcf",
  "message": "Number reserved. An administrator will review and complete the assignment."
}`}
      />
      <P>
        A number that is not currently available returns <IC>409</IC> with its current status in
        the <IC>detail</IC> message.
      </P>

      <H3>Release a number (request-based)</H3>
      <Endpoint method="POST" path="/v1/numbers/{did}/request-release" description="Ask Granite engineering to release an assigned DID. The number keeps forwarding until approved." />
      <Endpoint method="POST" path="/v1/numbers/{did}/cancel-release" description="Withdraw a pending release request — the number returns to normal assigned status." />
      <ParamTable
        params={[
          { name: 'notes', type: 'string', required: false, description: 'Optional note appended to the audit trail on the request or cancellation.' },
        ]}
      />
      <ReqRes
        request={`curl -X POST "https://your-portal-url/api/v1/numbers/%2B17745551234/request-release" \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "notes": "Office closed - no longer needed"
  }'`}
        response={`{
  "status": "release_requested",
  "did": "+17745551234",
  "customer_id": 7,
  "product_type": "rcf",
  "message": "Release requested. An administrator will review and complete the release."
}`}
      />
      <Callout accent={BLUE}>
        <IC>request-release</IC> returns <IC>409</IC> if the number is not currently{' '}
        <IC>assigned</IC> (including when a release is already pending), and{' '}
        <IC>cancel-release</IC> returns <IC>409</IC> if there is no pending release to cancel —
        so the flows are safe to drive from automation.
      </Callout>
    </AccordionSection>
  );
}

function RcfReference() {
  return (
    <>
      <RcfEndpointsSection />
      <NumberLifecycleSection />
    </>
  );
}

/* ═══════════════════════════════════════════════════════════
   SIP Trunking
   ═══════════════════════════════════════════════════════════ */

function TrunkEndpointsSection() {
  return (
    <AccordionSection
      id="ref-trunks"
      icon={<Code size={18} />}
      title="Trunks &amp; live stats"
      subtitle="Read your trunks and their real-time channel usage."
      defaultOpen
    >
      <P>
        Trunk reads are scoped to your account. Trunk creation, capacity changes, and DID
        assignment are provisioning actions performed by Granite; your self-service surface is
        reading trunk state and managing authorized IPs.
      </P>

      <H3>List your trunks</H3>
      <Endpoint method="GET" path="/v1/trunks" description="Trunks on your account, with IP/DID counts and the assigned call-path package." />
      <ParamTable
        params={[
          { name: 'enabled', type: 'boolean', required: false, description: 'Filter by enabled state.' },
          { name: 'limit',   type: 'integer', required: false, description: 'Page size. Default 100.' },
          { name: 'offset',  type: 'integer', required: false, description: 'Pagination offset. Default 0.' },
        ]}
      />
      <ReqRes
        request={`curl "https://your-portal-url/api/v1/trunks" \\
  -H "Authorization: Bearer <token>"`}
        response={`[
  {
    "id": 12,
    "trunk_name": "hq-primary",
    "customer_id": 7,
    "max_channels": 23,
    "cps_limit": 5,
    "auth_type": "ip",
    "tech_prefix": null,
    "enabled": true,
    "created_at": "2026-02-01T15:30:00+00:00",
    "customer_name": "Acme Utilities",
    "package_name": "CP-23",
    "call_paths": 23,
    "ip_count": 2,
    "did_count": 15
  }
]`}
      />

      <H3>Trunk detail</H3>
      <Endpoint method="GET" path="/v1/trunks/{trunk_id}" description="One trunk with its full configuration." />

      <H3>Real-time stats</H3>
      <Endpoint method="GET" path="/v1/trunks/{trunk_id}/stats" description="Live channel count from the media layer plus last-hour call aggregates." />
      <ReqRes
        request={`curl "https://your-portal-url/api/v1/trunks/12/stats" \\
  -H "Authorization: Bearer <token>"`}
        response={`{
  "trunk_id": 12,
  "current_channels": 6,
  "max_channels": 23,
  "channel_utilization": "26.1%",
  "cps_limit": 5,
  "last_hour": {
    "total_calls": 141,
    "answered_calls": 92,
    "asr": "65.2%",
    "avg_duration_sec": 187.4,
    "total_cost": 3.42
  }
}`}
      />
      <Callout accent={BLUE}>
        <IC>current_channels</IC> is read live from the media layer, so this endpoint is ideal
        for a wallboard — poll it at a modest interval (the portal refreshes every 15 seconds).
      </Callout>
    </AccordionSection>
  );
}

function TrunkIpsSection() {
  return (
    <AccordionSection
      id="ref-trunk-ips"
      icon={<ShieldCheck size={18} />}
      title="Authorized IPs"
      subtitle="Self-service management of your trunk's source addresses."
    >
      <P>
        The authorized-IP list is your trunk&rsquo;s access control — calls are accepted only
        from these addresses. You manage the list yourself; changes take effect immediately.
      </P>
      <Endpoint method="GET" path="/v1/trunks/{trunk_id}/ips" description="List the trunk's authorized source IPs." />
      <Endpoint method="POST" path="/v1/trunks/{trunk_id}/ips" description="Add an authorized IP. Duplicate addresses return 409." />
      <Endpoint method="DELETE" path="/v1/trunks/{trunk_id}/ips/{ip_id}" description="Remove an authorized IP — calls from it are rejected immediately." />
      <ParamTable
        params={[
          { name: 'ip_address',  type: 'string', required: true,  description: 'The public IPv4/IPv6 address your PBX or SBC sends SIP from.' },
          { name: 'description', type: 'string', required: false, description: "Label for your records, e.g. 'HQ firewall'." },
        ]}
      />
      <ReqRes
        request={`curl -X POST "https://your-portal-url/api/v1/trunks/12/ips" \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "ip_address": "203.0.113.50",
    "description": "HQ firewall"
  }'`}
        response={`{
  "id": 31,
  "ip_address": "203.0.113.50",
  "description": "HQ firewall"
}`}
      />
    </AccordionSection>
  );
}

function TrunkDidsSection() {
  return (
    <AccordionSection
      id="ref-trunk-dids"
      icon={<Hash size={18} />}
      title="Trunk DIDs &amp; provisioning"
      subtitle="Read the DIDs on your trunk; assignment and capacity changes are Granite-managed."
    >
      <H3>DIDs on your trunk</H3>
      <Endpoint method="GET" path="/v1/trunks/{trunk_id}/dids" description="List the inbound numbers assigned to this trunk." />
      <Endpoint method="GET" path="/v1/trunks/call-paths" description="List the available call-path packages (capacity tiers)." />
      <P>
        To add numbers, use the number lifecycle endpoints (
        <Link to="/docs/api/rcf" style={{ color: BLUE, fontWeight: 600 }}>documented under RCF</Link>
        ) with <IC>product_type: "trunk"</IC> — the same request-and-review flow applies.
      </P>

      <H3>Provisioning (Granite-managed)</H3>
      <Endpoint method="POST" path="/v1/trunks" admin description="Create a trunk (capacity from your purchased tier)." />
      <Endpoint method="PUT" path="/v1/trunks/{trunk_id}" admin description="Update trunk configuration." />
      <Endpoint method="PUT" path="/v1/trunks/{trunk_id}/call-paths" admin description="Assign a call-path package (resize capacity)." />
      <Endpoint method="POST" path="/v1/trunks/{trunk_id}/dids" admin description="Assign a DID to the trunk (completes an approved number request)." />
    </AccordionSection>
  );
}

function TrunkReference() {
  return (
    <>
      <TrunkEndpointsSection />
      <TrunkIpsSection />
      <TrunkDidsSection />
    </>
  );
}

/* ═══════════════════════════════════════════════════════════
   API Calling — early access
   ═══════════════════════════════════════════════════════════ */

function CallsReference() {
  return (
    <>
      <Callout accent={AMBER}>
        <strong style={{ color: C.text }}>Early access.</strong> API Calling is live for enrolled
        accounts. Endpoints below are stable; pushed webhook delivery is still maturing — build
        on status polling and CDRs (see the note at the end of this section).
      </Callout>

      <AccordionSection
        id="ref-calls"
        icon={<Zap size={18} />}
        title="Place &amp; control calls"
        subtitle="Originate outbound calls from your API numbers and control them live."
        defaultOpen
      >
        <H3>Place a call</H3>
        <Endpoint method="POST" path="/v1/calls" description="Originate an outbound call from one of your API-enabled numbers. CPS-limited per your tier." />
        <ParamTable
          params={[
            { name: 'from_did',    type: 'string',  required: true,  description: 'One of your API numbers (E.164). Must be enabled on your account.' },
            { name: 'to',          type: 'string',  required: true,  description: 'Destination — E.164, or a 3–6 digit local extension.' },
            { name: 'timeout',     type: 'integer', required: false, description: 'Origination timeout in seconds. Default 60.' },
            { name: 'webhook_url', type: 'string',  required: false, description: "Event callback URL for this call. Falls back to the number's configured voice URL. See the early-access note on delivery." },
            { name: 'caller_id',   type: 'string',  required: false, description: 'Reserved — accepted but not yet honored during early access (calls present the from_did).' },
            { name: 'status_callback', type: 'string', required: false, description: 'Reserved — accepted but not yet honored during early access.' },
          ]}
        />
        <ReqRes
          request={`curl -X POST https://your-portal-url/api/v1/calls \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "from_did": "+16175551001",
    "to": "+17745556789",
    "timeout": 45
  }'`}
          response={`{
  "call_id": "b0a4f1e2-6f3c-4b1a-9be2-1c8d1c1a7e55",
  "status": "initiated",
  "from": "+16175551001",
  "to": "+17745556789",
  "tier": "api_basic",
  "per_call_fee": 0.01
}`}
        />

        <H3>CPS tiers</H3>
        <P>
          Origination throughput is enforced per account by a sliding-window calls-per-second
          limit. Exceeding it returns <IC>429</IC> with your current usage in the{' '}
          <IC>detail</IC> object:
        </P>
        <div className="dlx-table-wrap">
          <table className="dlx-table">
            <thead>
              <tr>
                {['Tier', 'CPS limit', 'Per-call fee'].map(h => (
                  <th key={h} className="dl-th">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[
                { tier: 'api_basic',    cps: '5',  fee: '$0.010' },
                { tier: 'api_standard', cps: '8',  fee: '$0.008' },
                { tier: 'api_premium',  cps: '15', fee: '$0.005' },
              ].map(row => (
                <tr key={row.tier}>
                  <td><code className="dlx-td-code">{row.tier}</code></td>
                  <td>{row.cps}</td>
                  <td>{row.fee}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <CodeBlock
          label="429 response"
          code={`{
  "detail": {
    "error": "CPS limit exceeded",
    "current_cps": 5,
    "cps_limit": 5,
    "tier": "api_basic",
    "upgrade_message": "Your current plan (Basic) allows 5 CPS. ..."
  }
}`}
        />

        <H3>Get call status</H3>
        <Endpoint method="GET" path="/v1/calls/{call_id}" description="Live state while the call is up; the completed record (duration, hangup cause) afterward." />
        <ReqRes
          request={`# While live:
curl "https://your-portal-url/api/v1/calls/b0a4f1e2-..." \\
  -H "Authorization: Bearer <token>"`}
          response={`{
  "call_id": "b0a4f1e2-...",
  "status": "ACTIVE",
  "direction": "outbound",
  "from": "+16175551001",
  "to": "+17745556789",
  "start_time": "2026-08-11 14:02:11+00:00",
  "answer_time": "2026-08-11 14:02:19+00:00"
}`}
        />
        <CodeBlock
          label="completed call response"
          code={`{
  "call_id": "b0a4f1e2-...",
  "status": "completed",
  "direction": "outbound",
  "from": "+16175551001",
  "to": "+17745556789",
  "start_time": "2026-08-11 14:02:11+00:00",
  "end_time": "2026-08-11 14:05:47+00:00",
  "duration_seconds": 216.4,
  "hangup_cause": "NORMAL_CLEARING"
}`}
        />

        <H3>Control a live call</H3>
        <Endpoint method="POST" path="/v1/calls/{call_id}/update" description="Hang up, transfer, or send DTMF on an active call. 404 once the call has ended." />
        <ParamTable
          params={[
            { name: 'action', type: 'string', required: true,  description: "'hangup', 'transfer', or 'dtmf'." },
            { name: 'target', type: 'string', required: false, description: "Transfer destination — required when action is 'transfer'." },
            { name: 'digits', type: 'string', required: false, description: "DTMF digit string — required when action is 'dtmf'." },
          ]}
        />
        <ReqRes
          request={`curl -X POST "https://your-portal-url/api/v1/calls/b0a4f1e2-.../update" \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "action": "transfer",
    "target": "+18005550123"
  }'`}
          response={`{
  "call_id": "b0a4f1e2-...",
  "action": "transfer",
  "target": "+18005550123",
  "status": "success"
}`}
        />

        <H3>Webhook events</H3>
        <Callout accent={AMBER}>
          A <IC>webhook_url</IC> is accepted per call and stored with it, but pushed event
          delivery is still maturing during early access — do not build your only integration
          path on it yet. Status polling and CDRs (see{' '}
          <Link to="/docs/api/telemetry" style={{ color: BLUE, fontWeight: 600 }}>CDRs &amp; Telemetry</Link>
          ) are the reliable interfaces today.
        </Callout>
      </AccordionSection>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════
   CDRs & Telemetry
   ═══════════════════════════════════════════════════════════ */

function TelemetryReference() {
  return (
    <AccordionSection
      id="ref-cdrs"
      icon={<Activity size={18} />}
      title="Call records &amp; quality metrics"
      subtitle="Query CDRs across every product on your account, with per-call voice-quality data."
      defaultOpen
    >
      <P>
        Every call on your account — RCF forwards, trunk calls, API calls — produces a call
        detail record within seconds of hangup, including per-call quality metrics captured on
        the media path. The CDR endpoints are shared across products and scoped to your account.
      </P>

      <H3>Query CDRs</H3>
      <Endpoint method="GET" path="/v1/cdrs" description="Search your call records with filters. Defaults to the last 24 hours, newest first." />
      <ParamTable
        params={[
          { name: 'start_date',   type: 'datetime', required: false, description: 'ISO 8601 window start. Default: 24 hours ago.' },
          { name: 'end_date',     type: 'datetime', required: false, description: 'ISO 8601 window end. Default: now.' },
          { name: 'product_type', type: 'string',   required: false, description: "Filter by product: 'rcf', 'trunk', or 'api'." },
          { name: 'direction',    type: 'string',   required: false, description: "'inbound' or 'outbound'." },
          { name: 'destination',  type: 'string',   required: false, description: 'Destination prefix match, e.g. +1617.' },
          { name: 'trunk_id',     type: 'integer',  required: false, description: 'Limit to one of your trunks.' },
          { name: 'rated_only',   type: 'boolean',  required: false, description: 'true returns only records that have been cost-rated.' },
          { name: 'limit',        type: 'integer',  required: false, description: 'Page size, max 1000. Default 100.' },
          { name: 'offset',       type: 'integer',  required: false, description: 'Pagination offset. Default 0.' },
        ]}
      />
      <ReqRes
        request={`curl "https://your-portal-url/api/v1/cdrs?product_type=rcf&limit=1" \\
  -H "Authorization: Bearer <token>"`}
        response={`{
  "cdrs": [
    {
      "uuid": "9c1e7a3d-...",
      "customer_id": 7,
      "product_type": "rcf",
      "direction": "inbound",
      "caller_id": "+16175550100",
      "destination": "+18005559999",
      "start_time": "2026-08-11T13:58:02+00:00",
      "answer_time": "2026-08-11T13:58:09+00:00",
      "end_time": "2026-08-11T14:01:44+00:00",
      "duration_seconds": 222.1,
      "billable_seconds": 215.0,
      "hangup_cause": "NORMAL_CLEARING",
      "sip_code": "200",
      "mos": 4.38,
      "r_factor": 88.6,
      "jitter_avg_ms": 3.2,
      "packet_loss_pct": 0.04,
      "read_codec": "PCMU",
      "write_codec": "PCMU"
    }
  ],
  "count": 1,
  "offset": 0,
  "limit": 1
}`}
      />
      <Callout accent={BLUE}>
        <strong style={{ color: C.text }}>Quality fields:</strong> each record
        carries <IC>mos</IC> (1–5 voice-quality score; 4.0+ is excellent), <IC>r_factor</IC>{' '}
        (0–93 transmission rating), jitter (<IC>jitter_min_ms</IC>/<IC>avg</IC>/<IC>max</IC>),
        and packet loss (<IC>packet_loss_count</IC>, <IC>packet_loss_pct</IC>), plus codec and
        RTP byte/packet counters — the response above is trimmed for brevity.
      </Callout>

      <H3>Summary statistics</H3>
      <Endpoint method="GET" path="/v1/cdrs/summary" description="Aggregated call counts, answer rates, duration, and cost. Defaults to the last 7 days." />
      <ParamTable
        params={[
          { name: 'group_by',   type: 'string',   required: false, description: "'day' (default — split by product and direction), 'hour', or 'destination' (top prefixes)." },
          { name: 'start_date', type: 'datetime', required: false, description: 'ISO 8601 window start. Default: 7 days ago.' },
          { name: 'end_date',   type: 'datetime', required: false, description: 'ISO 8601 window end. Default: now.' },
          { name: 'customer_id', type: 'integer', required: false, description: 'Restrict to one customer account (yours).' },
        ]}
      />
      <ReqRes
        request={`curl "https://your-portal-url/api/v1/cdrs/summary?group_by=day&customer_id=7" \\
  -H "Authorization: Bearer <token>"`}
        response={`{
  "summary": [
    {
      "date": "2026-08-11",
      "product_type": "rcf",
      "direction": "inbound",
      "total_calls": 412,
      "answered_calls": 361,
      "total_duration_sec": 61240,
      "total_cost": 14.86
    }
  ],
  "group_by": "day"
}`}
      />

      <H3>Single call detail</H3>
      <Endpoint method="GET" path="/v1/cdrs/{uuid}" description="One CDR with the complete RTP metric set — every jitter, loss, and byte counter captured for the call." />
      <CodeBlock
        label="request"
        code={`curl "https://your-portal-url/api/v1/cdrs/9c1e7a3d-..." \\
  -H "Authorization: Bearer <token>"`}
      />
    </AccordionSection>
  );
}

/* ═══════════════════════════════════════════════════════════
   Page root
   ═══════════════════════════════════════════════════════════ */

const PRODUCT_INTRO: Record<(typeof API_PRODUCTS)[number], string> = {
  rcf: 'Manage forwarding on your numbers and drive the number request / release lifecycle programmatically.',
  trunking: 'Read trunk state and live channel stats, and self-manage your authorized source IPs.',
  calling: 'Place outbound calls from your Granite numbers and control them live — early access.',
  telemetry: 'Pull call records and per-call voice-quality metrics for every product on your account.',
};

const API_CONTENT: Record<(typeof API_PRODUCTS)[number], () => React.ReactNode> = {
  rcf: RcfReference,
  trunking: TrunkReference,
  calling: CallsReference,
  telemetry: TelemetryReference,
};

export function ApiDocsPage() {
  // Hooks unconditionally at the top (React #310).
  const { product } = useParams<{ product: string }>();
  const navigate = useNavigate();

  // Unknown slug in the URL → clean up to the default.
  if (product !== undefined && !isApiProduct(product)) {
    return <Navigate to="/docs/api" replace />;
  }

  const active = isApiProduct(product) ? product : 'rcf';
  const Content = API_CONTENT[active];

  return (
    <div className="dl-scope">
      <div className="dl-shell">
        <DocsHeader
          crumb="API Reference"
          title="API Reference"
          subtitle="REST endpoints for programmatic access to Granite CRAG — authenticated with a JWT bearer token"
        />

        <div className="dlx-docs-col fx-load fx-load-d1">
          <ProductSelector
            products={API_PRODUCTS}
            active={active}
            onSelect={p => navigate(`/docs/api/${p}`)}
          />

          <div className="dl-stack">
            <div className="dlx-item" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <Key size={15} style={{ color: BLUE, flexShrink: 0 }} />
              <span style={{ fontSize: '0.82rem', color: C.textMuted, lineHeight: 1.6 }}>
                {PRODUCT_INTRO[active]} Authenticate every request with a bearer token
                from <IC>POST /v1/auth/login</IC>, base URL <IC>/api/v1</IC> — details below.
              </span>
            </div>

            <AuthSection />

            {/* Keyed by product so accordion open-state resets on switch;
                display:contents keeps children as direct dl-stack items */}
            <div key={active} style={{ display: 'contents' }}>
              <Content />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
