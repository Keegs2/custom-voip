/**
 * API Reference — comprehensive developer documentation for the Granite CRAG
 * (Call Routing Application Gateway) REST API. Covers authentication, RCF
 * endpoints, CDR/usage, number inventory, and integration patterns.
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` in index.css) plus the
 * docs-only `dlx-*` primitives in src/styles/dl-docs.css.
 */

import {
  Key,
  Code,
  Phone,
  Zap,
  Server,
} from 'lucide-react';

import { C, MONO } from './tokens';
import {
  P,
  H3,
  IC,
  Callout,
  AccordionSection,
  NoteCards,
  CodeBlock,
  Endpoint,
  ParamTable,
  ReqRes,
  DocsHeader,
} from './shared';

/* ─── Accent colours for this page (daylight tokens) ────── */

const BLUE = '#2f7df6';
const AMBER = '#b45309';

/* ─── "Coming Soon" badge ────────────────────────────────── */

function ComingSoonBadge() {
  return (
    <span className="dlx-tag-warn" style={{ marginLeft: 2 }}>
      Coming Soon
    </span>
  );
}

/* ─── Section 1: Getting Started ────────────────────────── */

function ApiGettingStartedSection() {
  return (
    <AccordionSection
      id="api-getting-started"
      icon={<Key size={18} />}
      title="Getting Started"
      subtitle="Authentication, base URL, quick example, rate limits, and error codes."
    >
      <P>
        The CRAG (Call Routing Application Gateway) API is RESTful and JSON-based. Every request to a protected endpoint must include
        an <IC>Authorization</IC> header with a valid JWT bearer token. Tokens are obtained by POSTing
        credentials to the login endpoint and are valid for <strong style={{ color: C.text }}>8 hours</strong>.
      </P>

      {/* ── Authentication ──────────────────────────── */}
      <H3>Authentication</H3>
      <Endpoint method="POST" path="/api/auth/login" description="Exchange email + password for a JWT access token." />

      <ParamTable
        params={[
          { name: 'email',    type: 'string', required: true,  description: 'The email address associated with your CRAG account.' },
          { name: 'password', type: 'string', required: true,  description: 'Your account password.' },
        ]}
      />

      <ReqRes
        request={`curl -X POST https://your-portal-url/api/auth/login \
  -H "Content-Type: application/json" \
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

      <P>
        Include the token in the <IC>Authorization</IC> header on every subsequent request:
      </P>

      <CodeBlock
        label="all authenticated requests"
        code={`curl https://your-portal-url/api/v1/rcf \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."`}
      />

      {/* ── Base URL ─────────────────────────────────── */}
      <H3>Base URL</H3>

      <div className="dlx-endpoint" style={{ alignItems: 'center', marginBottom: 20 }}>
        <Server size={16} style={{ color: BLUE, flexShrink: 0 }} />
        <div>
          <div style={{ fontSize: '0.72rem', fontWeight: 700, color: C.textFaint, marginBottom: 3 }}>Base URL</div>
          <code style={{ color: C.text, fontFamily: MONO, fontSize: '0.82rem', fontWeight: 600 }}>
            https://{'<'}your-portal-url{'>'}/api
          </code>
        </div>
      </div>

      {/* ── Quick example ────────────────────────────── */}
      <H3>Quick example — login then list RCF numbers</H3>
      <CodeBlock
        label="bash"
        code={`# 1. Authenticate and capture the token
TOKEN=$(curl -s -X POST https://your-portal-url/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"your-password"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# 2. List your RCF numbers
curl "https://your-portal-url/api/v1/rcf" \
  -H "Authorization: Bearer $TOKEN"`}
      />

      {/* ── Rate limits ──────────────────────────────── */}
      <H3>Rate limits</H3>
      <P>
        The API enforces a limit of <strong style={{ color: C.text }}>100 requests per minute</strong> per
        token. Exceeding this limit returns <IC>429 Too Many Requests</IC> with a <IC>Retry-After</IC> header
        indicating how many seconds to wait. If you need a higher limit for bulk provisioning workflows,
        contact your Granite account team.
      </P>

      {/* ── Error codes ──────────────────────────────── */}
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
              { status: '200 OK',             meaning: 'Request succeeded. Response body contains the requested data.' },
              { status: '201 Created',        meaning: 'Resource created successfully. Response body contains the new resource.' },
              { status: '204 No Content',     meaning: 'Request succeeded with no response body (used by DELETE).' },
              { status: '400 Bad Request',    meaning: 'Request body or query parameters are invalid. Check the detail field.' },
              { status: '401 Unauthorized',   meaning: 'No token supplied, or the token has expired. Re-authenticate and retry.' },
              { status: '403 Forbidden',      meaning: 'Token is valid but does not have permission to access this resource.' },
              { status: '404 Not Found',      meaning: 'The requested DID or resource does not exist in your account.' },
              { status: '409 Conflict',       meaning: 'DID already exists. Use PUT to update an existing entry.' },
              { status: '422 Unprocessable',  meaning: 'Validation error — request body was parseable but failed field-level validation.' },
              { status: '500 Server Error',   meaning: 'Unexpected server-side error. Contact Granite support if this persists.' },
            ].map(row => (
              <tr key={row.status}>
                <td>
                  <code className="dlx-td-code">{row.status}</code>
                </td>
                <td>{row.meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <P>
        Error responses always include a <IC>detail</IC> field with a human-readable message:
      </P>
      <CodeBlock
        label="error response"
        code={`{
  "detail": "RCF entry +17745554321 not found"
}`}
      />

      {/* ── E.164 note ───────────────────────────────── */}
      <Callout accent={BLUE}>
        <strong style={{ color: C.text }}>Phone number format:</strong> All phone numbers must be
        in E.164 format — a leading <IC>+</IC> followed by country code and subscriber number with
        no spaces or dashes. Example: <IC>+17745551234</IC>. When placing an E.164 number in a URL
        path segment, URL-encode the <IC>+</IC> as <IC>%2B</IC>. For example,{' '}
        <IC>+17745551234</IC> becomes <IC>/api/v1/rcf/%2B17745551234</IC>.
      </Callout>
    </AccordionSection>
  );
}

/* ─── Section 2: RCF Endpoints ──────────────────────────── */

function ApiRcfSection() {
  return (
    <AccordionSection
      id="api-rcf"
      icon={<Code size={18} />}
      title="RCF Endpoints"
      subtitle="Create, read, update, and delete Remote Call Forwarding numbers programmatically."
    >
      <P>
        The RCF API lets you manage your forwarding numbers from any application or script. All
        endpoints are scoped to your customer account — you can only read and modify numbers
        belonging to your organisation. The identifier in update and delete endpoints can be either
        a numeric row ID or an E.164 DID (URL-encoded).
      </P>

      {/* ── List numbers ─────────────────────────────── */}
      <H3>List RCF numbers</H3>
      <Endpoint method="GET" path="/api/v1/rcf" description="Return all RCF entries for your account, with optional filters." />

      <ParamTable
        params={[
          { name: 'customer_id', type: 'integer', required: false, description: 'Filter by customer ID. Defaults to your own account.' },
          { name: 'enabled',     type: 'boolean', required: false, description: 'Pass true to return only enabled numbers, false for disabled only.' },
          { name: 'search',      type: 'string',  required: false, description: 'Free-text search across DID, name, and forward_to fields.' },
        ]}
      />

      <ReqRes
        request={`curl "https://your-portal-url/api/v1/rcf?enabled=true" \
  -H "Authorization: Bearer <token>"`}
        response={`[
  {
    "did": "+17745551234",
    "name": "Main Office Line",
    "forward_to": "+18005559999",
    "enabled": true,
    "pass_caller_id": true,
    "ring_timeout": 30,
    "failover_to": "+18005550000",
    "customer_id": 7,
    "created_at": "2025-01-15T10:00:00Z",
    "updated_at": "2026-03-20T14:22:11Z"
  }
]`}
      />

      {/* ── Get single number ─────────────────────────── */}
      <H3>Get a single RCF number</H3>
      <Endpoint method="GET" path="/api/v1/rcf/{did}" description="Retrieve one RCF entry by its DID." />

      <ParamTable
        params={[
          { name: 'did', type: 'string (path)', required: true, description: 'The DID in E.164 format, URL-encoded. Encode + as %2B. Example: %2B17745551234' },
        ]}
      />

      <ReqRes
        request={`curl "https://your-portal-url/api/v1/rcf/%2B17745551234" \
  -H "Authorization: Bearer <token>"`}
        response={`{
  "did": "+17745551234",
  "name": "Main Office Line",
  "forward_to": "+18005559999",
  "enabled": true,
  "pass_caller_id": true,
  "ring_timeout": 30,
  "failover_to": "+18005550000",
  "customer_id": 7,
  "created_at": "2025-01-15T10:00:00Z",
  "updated_at": "2026-03-20T14:22:11Z"
}`}
      />

      {/* ── Create number ─────────────────────────────── */}
      <H3>Create an RCF entry</H3>
      <Endpoint method="POST" path="/api/v1/rcf" description="Provision a new RCF forwarding entry." />

      <ParamTable
        params={[
          { name: 'customer_id',    type: 'integer', required: true,  description: 'The customer account this number belongs to.' },
          { name: 'did',            type: 'string',  required: true,  description: 'The inbound DID to register. Must be E.164 format and allocated to your account.' },
          { name: 'forward_to',     type: 'string',  required: true,  description: 'The destination to forward calls to. E.164 format.' },
          { name: 'name',           type: 'string',  required: false, description: 'A friendly label for this number. Shown only in the portal.' },
          { name: 'pass_caller_id', type: 'boolean', required: false, description: 'Whether to pass the original caller ID through to the destination. Default: true.' },
          { name: 'ring_timeout',   type: 'integer', required: false, description: 'Seconds to ring the destination before giving up. Range 5–120. Default: 30.' },
          { name: 'failover_to',    type: 'string',  required: false, description: 'Backup destination number (E.164) called if ring_timeout expires. Omit to leave unset.' },
          { name: 'enabled',        type: 'boolean', required: false, description: 'Whether to start forwarding immediately. Default: true.' },
        ]}
      />

      <ReqRes
        request={`curl -X POST https://your-portal-url/api/v1/rcf \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "did": "+17745554321",
    "customer_id": 7,
    "forward_to": "+16175552222",
    "name": "Boston Sales",
    "pass_caller_id": true,
    "ring_timeout": 25,
    "failover_to": "+18005550000",
    "enabled": true
  }'`}
        response={`{
  "did": "+17745554321",
  "name": "Boston Sales",
  "forward_to": "+16175552222",
  "enabled": true,
  "pass_caller_id": true,
  "ring_timeout": 25,
  "failover_to": "+18005550000",
  "customer_id": 7,
  "created_at": "2026-04-23T11:05:00Z",
  "updated_at": "2026-04-23T11:05:00Z"
}`}
      />

      {/* ── Update number ─────────────────────────────── */}
      <H3>Update an RCF entry</H3>
      <Endpoint method="PUT" path="/api/v1/rcf/{identifier}" description="Partially update a forwarding entry — send only the fields you want to change." />

      <P>
        The <IC>identifier</IC> path parameter accepts either a <strong style={{ color: C.text }}>numeric ID</strong> or
        an <strong style={{ color: C.text }}>E.164 DID</strong> (URL-encoded). This lets you update by DID
        without first fetching the numeric ID.
      </P>

      <ParamTable
        params={[
          { name: 'identifier (path)', type: 'string',  required: true,  description: 'Numeric row ID or URL-encoded E.164 DID. Encode + as %2B.' },
          { name: 'name',              type: 'string',  required: false, description: 'Updated friendly label.' },
          { name: 'forward_to',        type: 'string',  required: false, description: 'New forwarding destination in E.164 format.' },
          { name: 'pass_caller_id',    type: 'boolean', required: false, description: 'Update caller ID pass-through behaviour.' },
          { name: 'ring_timeout',      type: 'integer', required: false, description: 'New ring timeout in seconds (5–120).' },
          { name: 'enabled',           type: 'boolean', required: false, description: 'Enable (true) or disable (false) forwarding.' },
          { name: 'failover_to',       type: 'string',  required: false, description: 'New failover destination. Send null to remove.' },
        ]}
      />

      <P>Example: change the forwarding destination on an existing number.</P>
      <ReqRes
        request={`curl -X PUT "https://your-portal-url/api/v1/rcf/%2B17745554321" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "forward_to": "+16175553333"
  }'`}
        response={`{
  "did": "+17745554321",
  "name": "Boston Sales",
  "forward_to": "+16175553333",
  "enabled": true,
  "pass_caller_id": true,
  "ring_timeout": 25,
  "failover_to": "+18005550000",
  "customer_id": 7,
  "created_at": "2026-04-23T11:05:00Z",
  "updated_at": "2026-04-23T12:00:00Z"
}`}
      />

      <P>Example: disable a number without changing any other settings.</P>
      <ReqRes
        request={`curl -X PUT "https://your-portal-url/api/v1/rcf/%2B17745554321" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": false
  }'`}
        response={`{
  "did": "+17745554321",
  "name": "Boston Sales",
  "forward_to": "+16175553333",
  "enabled": false,
  "pass_caller_id": true,
  "ring_timeout": 25,
  "failover_to": "+18005550000",
  "customer_id": 7,
  "created_at": "2026-04-23T11:05:00Z",
  "updated_at": "2026-04-23T12:01:44Z"
}`}
      />

      {/* ── Delete number ─────────────────────────────── */}
      <H3>Delete an RCF entry</H3>
      <Endpoint method="DELETE" path="/api/v1/rcf/{identifier}" description="Permanently remove a forwarding entry. This cannot be undone." />

      <ParamTable
        params={[
          { name: 'identifier (path)', type: 'string', required: true, description: 'Numeric row ID or URL-encoded E.164 DID. Encode + as %2B.' },
        ]}
      />

      <CodeBlock
        label="request"
        code={`curl -X DELETE "https://your-portal-url/api/v1/rcf/%2B17745554321" \
  -H "Authorization: Bearer <token>"
# Returns: 204 No Content — no response body`}
      />

      <Callout accent={BLUE}>
        DELETE is idempotent — if the DID does not exist, the API returns 204 regardless. It is
        always safe to retry a DELETE after a network timeout without checking for duplicates.
      </Callout>
    </AccordionSection>
  );
}

/* ─── Section 3: Number Inventory Endpoints ─────────────── */

function ApiNumbersSection() {
  return (
    <AccordionSection
      id="api-numbers"
      icon={<Phone size={18} />}
      title="Number Inventory Endpoints"
      subtitle="Browse available DIDs, view your assigned numbers, and request new numbers for your account."
    >
      <P>
        The number inventory API lets you discover available DIDs in specific area codes or cities,
        view numbers already assigned to your account, and submit reservation requests for admin review.
      </P>

      {/* ── Available numbers ────────────────────────── */}
      <H3>Browse available numbers</H3>
      <Endpoint method="GET" path="/api/v1/numbers/available" description="Return available DIDs that can be assigned to your account." />

      <ParamTable
        params={[
          { name: 'state',   type: 'string',  required: false, description: 'Two-letter US state code. Example: MA, NY, CA.' },
          { name: 'city',    type: 'string',  required: false, description: 'City name filter (partial match). Example: Boston.' },
          { name: 'search',  type: 'string',  required: false, description: 'Area code or number fragment search. Example: 617.' },
        ]}
      />

      <ReqRes
        request={`curl "https://your-portal-url/api/v1/numbers/available?state=MA&city=Boston" \
  -H "Authorization: Bearer <token>"`}
        response={`[
  { "did": "+16175551001", "city": "Boston", "state": "MA", "rate_center": "BOSTON" },
  { "did": "+16175551002", "city": "Boston", "state": "MA", "rate_center": "BOSTON" },
  { "did": "+16175551003", "city": "Boston", "state": "MA", "rate_center": "BOSTON" }
]`}
      />

      {/* ── My numbers ───────────────────────────────── */}
      <H3>View your assigned numbers</H3>
      <Endpoint method="GET" path="/api/v1/numbers/my" description="Return all DIDs currently assigned to your customer account." />

      <ReqRes
        request={`curl "https://your-portal-url/api/v1/numbers/my" \
  -H "Authorization: Bearer <token>"`}
        response={`[
  {
    "did": "+17745551234",
    "assigned_at": "2025-01-15T10:00:00Z",
    "product_type": "rcf",
    "customer_id": 7
  },
  {
    "did": "+17745558888",
    "assigned_at": "2025-02-01T08:00:00Z",
    "product_type": "rcf",
    "customer_id": 7
  }
]`}
      />

      {/* ── Request a number ─────────────────────────── */}
      <H3>Request a number</H3>
      <Endpoint method="POST" path="/api/v1/numbers/{did}/request" description="Submit a reservation request for an available DID. Pending admin review before assignment." />

      <ParamTable
        params={[
          { name: 'did (path)', type: 'string', required: true, description: 'The E.164 DID to reserve (URL-encoded). Must appear in the available numbers list.' },
        ]}
      />

      <CodeBlock
        label="request"
        code={`curl -X POST "https://your-portal-url/api/v1/numbers/%2B16175551001/request" \
  -H "Authorization: Bearer <token>"
# Returns: 201 Created when the reservation request is submitted`}
      />

      <Callout accent={BLUE}>
        Number requests are reviewed by a Granite administrator before the DID is assigned to your
        account. Once approved, the number will appear in your RCF number list and you can configure
        forwarding via the portal or the API.
      </Callout>
    </AccordionSection>
  );
}

/* ─── Section 5: Integration Patterns ───────────────────── */

function ApiIntegrationSection() {
  return (
    <AccordionSection
      id="api-integration"
      icon={<Zap size={18} />}
      title="Integration Patterns"
      subtitle="Quick start walkthrough, webhook events, error handling with retry, and bulk provisioning."
    >
      {/* ── Quick start ──────────────────────────────── */}
      <H3>Quick start — four steps to your first integration</H3>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
        {[
          {
            step: '1',
            tag: 'Auth',
            title: 'Authenticate',
            body: 'POST to /api/auth/login with your email and password. Store the returned access_token securely — treat it like a password. Tokens expire after 8 hours.',
          },
          {
            step: '2',
            tag: 'Read',
            title: 'List your numbers',
            body: 'GET /api/v1/rcf to retrieve all RCF entries for your account. Confirm the did, forward_to, enabled, and ring_timeout values for each number.',
          },
          {
            step: '3',
            tag: 'Write',
            title: 'Update forwarding',
            body: 'PUT /api/v1/rcf/{identifier} to change a forwarding destination, enable/disable a number, or adjust ring_timeout and failover_to. Partial updates — send only the fields you want to change.',
          },
          {
            step: '4',
            tag: 'Verify',
            title: 'Verify with a test call',
            body: 'Place a test call and verify it reaches the forwarding destination.',
          },
        ].map(({ step, tag, title, body }) => (
          <div key={step} className="dlx-item" style={{ display: 'flex', gap: 16, padding: '16px 18px' }}>
            <div className="dlx-step-num">{step}</div>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5 }}>
                <div style={{ fontSize: '0.87rem', fontWeight: 700, color: C.text }}>{title}</div>
                <span className="dl-tag">{tag}</span>
              </div>
              <div style={{ fontSize: '0.82rem', color: C.textMuted, lineHeight: 1.7 }}>{body}</div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Webhooks ──────────────────────────────────── */}
      <H3>
        Webhook integration{' '}
        <ComingSoonBadge />
      </H3>

      <Callout accent={AMBER}>
        Webhook support is currently in development. The event schema below reflects the planned
        interface — subscribe to release notes for availability updates.
      </Callout>

      <P>
        Webhooks allow CRAG to push call event data to your systems in real time rather than
        requiring your application to poll the CDR API. When enabled, the platform will POST to your
        registered HTTPS endpoint with a JSON payload for each of the following events:
      </P>

      <div className="dlx-notegrid" style={{ marginBottom: 20 }}>
        {[
          {
            event: 'call.started',
            desc: 'Fires when an inbound call is received on a DID and forwarding begins. Includes caller number, DID, and forward_to destination.',
          },
          {
            event: 'call.answered',
            desc: 'Fires when the forwarding destination picks up. Includes answer timestamp and destination number.',
          },
          {
            event: 'call.ended',
            desc: 'Fires when a call disconnects. Includes call metadata and quality summary.',
          },
          {
            event: 'call.failover',
            desc: 'Fires when ring timeout expires and the call is redirected to the failover destination. Includes both primary and failover numbers.',
          },
        ].map(({ event, desc }) => (
          <div key={event} className="dlx-notecard dlx-notecard-warn">
            <div className="dlx-notecard-title">{event}</div>
            <div className="dlx-notecard-body">{desc}</div>
          </div>
        ))}
      </div>

      {/* ── Error handling & retry ────────────────────── */}
      <H3>Error handling &amp; retry</H3>

      <P>
        Production integrations must account for transient failures and rate limits. The table below
        classifies which status codes are safe to retry and which require intervention.
      </P>

      <div className="dlx-table-wrap">
        <table className="dlx-table">
          <thead>
            <tr>
              {['Status', 'Retryable', 'Action'].map(h => (
                <th key={h} className="dl-th">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              { status: '400 Bad Request',   retry: 'no',     action: 'Fix the request — invalid parameters or body. Check the detail field.' },
              { status: '401 Unauthorized',  retry: 'reauth', action: 'Re-authenticate via /auth/login to obtain a fresh token, then retry.' },
              { status: '403 Forbidden',     retry: 'no',     action: 'Token lacks permission. Contact your admin — do not retry.' },
              { status: '404 Not Found',     retry: 'no',     action: 'Resource does not exist. Verify the DID or ID in your request.' },
              { status: '409 Conflict',      retry: 'no',     action: 'DID already exists. Use PUT to update the existing entry.' },
              { status: '429 Too Many Reqs', retry: 'backoff', action: 'Rate limit hit. Honour the Retry-After header and use exponential backoff.' },
              { status: '500 Server Error',  retry: 'backoff', action: 'Transient server error. Retry with exponential backoff up to 3 times.' },
              { status: '503 Unavailable',   retry: 'backoff', action: 'Platform temporarily unavailable. Retry after 30s, then 60s, then 120s.' },
            ].map(row => {
              const retryClass =
                row.retry === 'no'
                  ? 'dl-tag dl-tag-slate'
                  : row.retry === 'reauth'
                  ? 'dl-tag'
                  : 'dlx-tag-warn';
              return (
                <tr key={row.status}>
                  <td>
                    <code className="dlx-td-code">{row.status}</code>
                  </td>
                  <td>
                    <span className={retryClass}>
                      {row.retry === 'no' ? 'no' : row.retry === 'reauth' ? 'reauth' : 'backoff'}
                    </span>
                  </td>
                  <td>{row.action}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <P>
        For retryable errors, use exponential backoff with jitter to avoid thundering-herd effects
        when multiple instances of your integration retry simultaneously:
      </P>

      <CodeBlock
        label="python — exponential backoff with jitter"
        code={`import time, random, requests

def api_request_with_retry(method, url, **kwargs):
    max_retries = 4
    base_delay  = 1.0  # seconds

    for attempt in range(max_retries):
        resp = requests.request(method, url, **kwargs)

        if resp.status_code in (200, 201, 204):
            return resp

        # Rate limited — honour Retry-After if present
        if resp.status_code == 429:
            delay = int(resp.headers.get("Retry-After", base_delay * (2 ** attempt)))
            time.sleep(delay)
            continue

        # Transient server errors — exponential backoff
        if resp.status_code in (500, 503) and attempt < max_retries - 1:
            time.sleep(base_delay * (2 ** attempt) + random.uniform(0, 0.5))
            continue

        resp.raise_for_status()  # non-retryable

    raise RuntimeError(f"Request failed after {max_retries} attempts")`}
      />

      <NoteCards
        items={[
          {
            title: 'Check before create',
            body: 'Before POSTing a new DID, first GET /api/v1/rcf/{did} to check if it already exists. If you get 200, use PUT to update instead — POST will return 409 Conflict.',
          },
          {
            title: 'DELETE is always safe to retry',
            body: 'DELETE returns 204 whether or not the resource existed. Retrying a DELETE after a timeout is always safe — no error is returned if already deleted.',
          },
          {
            title: 'Token expiry strategy',
            body: 'Track token issue time in your integration. Re-authenticate proactively a few minutes before the 8-hour expiry rather than waiting for a 401.',
          },
          {
            title: 'Store token securely',
            body: 'Never commit tokens to source control. Use environment variables or a secrets manager. Treat a token with the same sensitivity as a password.',
          },
        ]}
      />

      {/* ── Bulk provisioning ─────────────────────────── */}
      <H3>
        Bulk provisioning{' '}
        <ComingSoonBadge />
      </H3>

      <Callout accent={AMBER}>
        Bulk CSV provisioning is planned for a future release. The schema described here reflects
        the intended API design.
      </Callout>

      <P>
        For deployments with large DID inventories, the planned bulk endpoint accepts a CSV file
        with multiple RCF entries in a single API call. The platform will process the file
        asynchronously and return a job ID you can poll for status.
      </P>

      <P>CSV column order and format:</P>

      <CodeBlock
        label="bulk-provision.csv"
        code={`did,customer_id,forward_to,name,pass_caller_id,ring_timeout,failover_to,enabled
+17745551001,7,+18005559001,Boston HQ,true,30,+18005550000,true
+17745551002,7,+18005559002,Boston Sales,true,25,,true
+17745551003,7,+16175553001,Cambridge Office,false,30,+18005550000,true`}
      />

      <P>
        All phone numbers must be in E.164 format. Boolean fields accept <IC>true</IC> or <IC>false</IC>.
        Leave <IC>failover_to</IC> empty to provision without a failover destination.
      </P>

      <Endpoint method="POST" path="/api/v1/rcf/bulk" description="Upload a CSV file (multipart/form-data) to provision multiple RCF entries. Returns a job_id." />
      <Endpoint method="GET" path="/api/v1/rcf/bulk/{job_id}" description="Poll the status of a bulk provisioning job. Includes counts of succeeded, failed, and pending rows." />
    </AccordionSection>
  );
}

/* ─── Page root ──────────────────────────────────────────── */

export function ApiDocsPage() {
  return (
    <div className="dl-scope">
      <div className="dl-shell">
        <DocsHeader
          crumb="API Reference"
          title="API Reference"
          subtitle="RESTful API documentation for programmatic access to the Granite CRAG (Call Routing Application Gateway) platform"
        />

        <div className="dlx-docs-col dl-stack fx-load fx-load-d1">
          <ApiGettingStartedSection />
          <ApiRcfSection />
          <ApiNumbersSection />
          <ApiIntegrationSection />
        </div>
      </div>
    </div>
  );
}
