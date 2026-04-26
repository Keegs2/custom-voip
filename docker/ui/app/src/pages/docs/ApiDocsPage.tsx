/**
 * API Reference page — RESTful API documentation for programmatic access
 * to the Granite Keystone platform.
 *
 * Covers: Authentication, RCF Endpoints, CDR / Usage.
 */

import {
  Key,
  Code,
  Database,
  Server,
} from 'lucide-react';

import {
  C,
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
  PageHeaderCard,
} from './shared';

/* ─── Accent colour for this page ───────────────────────── */

const BLUE = '#3b82f6';

/* ─── Section 1: Authentication ─────────────────────────── */

function ApiAuthSection() {
  return (
    <AccordionSection
      id="api-auth"
      accent={BLUE}
      icon={<Key size={18} />}
      title="Authentication"
      subtitle="Obtain a JWT token and authenticate every API request with a Bearer header."
      defaultOpen
    >
      <P>
        The Keystone API uses JSON Web Tokens (JWT) for authentication. Every request to a protected
        endpoint must include an <IC>Authorization</IC> header containing a valid token. Tokens are
        obtained by POSTing credentials to the login endpoint.
      </P>

      <H3>Obtain a token</H3>
      <Endpoint method="POST" path="/api/v1/auth/login" description="Exchange email + password for a JWT access token." />

      <ParamTable
        params={[
          { name: 'email',    type: 'string', required: true,  description: 'The email address associated with your Keystone account.' },
          { name: 'password', type: 'string', required: true,  description: 'Your account password.' },
        ]}
      />

      <ReqRes
        request={`curl -X POST https://your-portal.example.com/api/v1/auth/login \\
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

      <H3>Using the token</H3>
      <P>
        Include the token in the <IC>Authorization</IC> header on every subsequent request. The
        value must be prefixed with the word <IC>Bearer</IC> followed by a single space.
      </P>

      <CodeBlock
        label="all authenticated requests"
        code={`curl https://your-portal.example.com/api/v1/rcf \\
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."`}
      />

      <H3>Token lifetime and refresh</H3>
      <P>
        Tokens are valid for <strong style={{ color: C.text }}>24 hours</strong> from the time of
        issue. After expiry the API returns <IC>401 Unauthorized</IC>. There is no refresh endpoint
        — simply POST to <IC>/api/v1/auth/login</IC> again to obtain a new token. Store the token
        securely in your application (environment variable or secrets manager — never in source
        control).
      </P>

      <Callout accent={BLUE}>
        All API endpoints below require a valid Bearer token. A request without a token, or with an
        expired token, returns <IC>401 Unauthorized</IC>. A token belonging to a user who does not
        have access to the requested resource returns <IC>403 Forbidden</IC>.
      </Callout>
    </AccordionSection>
  );
}

/* ─── Section 2: RCF Endpoints ──────────────────────────── */

function ApiRcfSection() {
  return (
    <AccordionSection
      id="api-rcf"
      accent={BLUE}
      icon={<Code size={18} />}
      title="RCF Endpoints"
      subtitle="Create, read, update, and delete Remote Call Forwarding numbers programmatically."
    >
      <P>
        The RCF API lets you manage your forwarding numbers from any application or script. All
        endpoints are scoped to your customer account — you can only read and modify numbers
        belonging to your organisation.
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
        request={`curl "https://your-portal.example.com/api/v1/rcf?enabled=true" \\
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
  },
  {
    "did": "+17745558888",
    "name": "Sales Line",
    "forward_to": "+16175551111",
    "enabled": true,
    "pass_caller_id": false,
    "ring_timeout": 20,
    "failover_to": null,
    "customer_id": 7,
    "created_at": "2025-02-01T08:00:00Z",
    "updated_at": "2026-04-01T09:11:05Z"
  }
]`}
      />

      {/* ── Get single number ─────────────────────────── */}
      <H3>Get a single RCF number</H3>
      <Endpoint method="GET" path="/api/v1/rcf/{did}" description="Retrieve one RCF entry by its DID." />

      <ParamTable
        params={[
          { name: 'did', type: 'string (path)', required: true, description: 'The DID in E.164 format, URL-encoded. The + sign must be encoded as %2B. Example: %2B17745551234' },
        ]}
      />

      <ReqRes
        request={`curl "https://your-portal.example.com/api/v1/rcf/%2B17745551234" \\
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
      <H3>Create an RCF number</H3>
      <Endpoint method="POST" path="/api/v1/rcf" description="Provision a new RCF forwarding entry." />

      <ParamTable
        params={[
          { name: 'did',            type: 'string',  required: true,  description: 'The inbound DID to register. Must be E.164 format and already allocated to your account.' },
          { name: 'customer_id',    type: 'integer', required: true,  description: 'The customer account this number belongs to.' },
          { name: 'forward_to',     type: 'string',  required: true,  description: 'The destination to forward calls to. E.164 format.' },
          { name: 'name',           type: 'string',  required: false, description: 'A friendly label for this number. Shown only in the portal.' },
          { name: 'pass_caller_id', type: 'boolean', required: false, description: 'Whether to pass the original caller ID through to the destination. Default: true.' },
          { name: 'ring_timeout',   type: 'integer', required: false, description: 'Seconds to ring the destination before giving up. Range 5–120. Default: 30.' },
          { name: 'failover_to',    type: 'string',  required: false, description: 'Backup destination number (E.164) called if ring_timeout expires. Omit to leave unset.' },
          { name: 'enabled',        type: 'boolean', required: false, description: 'Whether to start forwarding immediately. Default: true.' },
        ]}
      />

      <ReqRes
        request={`curl -X POST https://your-portal.example.com/api/v1/rcf \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
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
      <H3>Update an RCF number</H3>
      <Endpoint method="PUT" path="/api/v1/rcf/{did}" description="Partially update a forwarding entry — only send the fields you want to change." />

      <ParamTable
        params={[
          { name: 'did (path)',     type: 'string',  required: true,  description: 'URL-encoded DID of the number to update. Encode + as %2B.' },
          { name: 'forward_to',    type: 'string',  required: false, description: 'New forwarding destination in E.164 format.' },
          { name: 'name',          type: 'string',  required: false, description: 'Updated friendly label.' },
          { name: 'ring_timeout',  type: 'integer', required: false, description: 'New ring timeout in seconds (5–120).' },
          { name: 'failover_to',   type: 'string',  required: false, description: 'New failover destination. Send null to remove.' },
          { name: 'enabled',       type: 'boolean', required: false, description: 'Enable (true) or disable (false) forwarding.' },
          { name: 'pass_caller_id',type: 'boolean', required: false, description: 'Update caller ID pass-through behaviour.' },
        ]}
      />

      <P>Example: change the forwarding destination on an existing number.</P>
      <ReqRes
        request={`curl -X PUT "https://your-portal.example.com/api/v1/rcf/%2B17745554321" \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
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
        request={`curl -X PUT "https://your-portal.example.com/api/v1/rcf/%2B17745554321" \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
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
      <H3>Delete an RCF number</H3>
      <Endpoint method="DELETE" path="/api/v1/rcf/{did}" description="Permanently remove a forwarding entry. This cannot be undone." />

      <ParamTable
        params={[
          { name: 'did (path)', type: 'string', required: true, description: 'URL-encoded DID of the number to delete. Encode + as %2B.' },
        ]}
      />

      <CodeBlock
        label="request"
        code={`curl -X DELETE "https://your-portal.example.com/api/v1/rcf/%2B17745554321" \\
  -H "Authorization: Bearer <token>"
# Returns: 204 No Content — no response body`}
      />

      <Callout accent={BLUE}>
        URL-encode the <IC>+</IC> sign in E.164 numbers when placing them in URL path segments.
        Replace <IC>+</IC> with <IC>%2B</IC>. For example, <IC>+17745551234</IC> becomes{' '}
        <IC>/api/v1/rcf/%2B17745551234</IC>. Query parameters (like <IC>?search=+177...</IC>)
        follow the same rule.
      </Callout>

      <H3>Health check</H3>
      <Endpoint method="GET" path="/api/v1/health" description="Verify the API is reachable and all platform components are operational." />

      <ReqRes
        request={`curl https://your-portal.example.com/api/v1/health \\
  -H "Authorization: Bearer <token>"`}
        response={`{
  "status": "healthy",
  "timestamp": "2026-04-23T11:00:00Z",
  "components": {
    "database": "healthy",
    "sip_platform": "healthy"
  }
}`}
      />
    </AccordionSection>
  );
}

/* ─── Section 3: CDR / Usage ─────────────────────────────── */

function ApiCdrSection() {
  return (
    <AccordionSection
      id="api-cdrs"
      accent={BLUE}
      icon={<Database size={18} />}
      title="CDR / Usage"
      subtitle="Query call detail records and aggregated usage statistics for your RCF numbers."
    >
      <P>
        The CDR API provides access to raw call records and aggregated summary statistics for all
        calls that have passed through your RCF numbers. Use it to build usage dashboards, generate
        billing reconciliation reports, or investigate individual calls.
      </P>

      {/* ── Search CDRs ──────────────────────────────── */}
      <H3>Search call records</H3>
      <Endpoint method="GET" path="/api/v1/cdrs" description="Return paginated call detail records matching the specified filters." />

      <ParamTable
        params={[
          { name: 'customer_id', type: 'integer', required: false, description: 'Scope results to a specific customer. Defaults to your own account.' },
          { name: 'start_date',  type: 'string',  required: false, description: 'ISO 8601 datetime (UTC). Only return calls starting on or after this time. Example: 2026-04-01T00:00:00Z' },
          { name: 'end_date',    type: 'string',  required: false, description: 'ISO 8601 datetime (UTC). Only return calls starting before this time.' },
          { name: 'did',         type: 'string',  required: false, description: 'Filter to a specific inbound DID in E.164 format.' },
          { name: 'direction',   type: 'string',  required: false, description: 'Call direction: inbound or outbound.' },
          { name: 'limit',       type: 'integer', required: false, description: 'Maximum number of records to return. Default 50, max 500.' },
          { name: 'offset',      type: 'integer', required: false, description: 'Number of records to skip for pagination. Default 0.' },
        ]}
      />

      <ReqRes
        request={`curl "https://your-portal.example.com/api/v1/cdrs\\
?start_date=2026-04-01T00:00:00Z\\
&end_date=2026-04-08T00:00:00Z\\
&limit=2" \\
  -H "Authorization: Bearer <token>"`}
        response={`{
  "items": [
    {
      "id": "cdr-001",
      "did": "+17745551234",
      "caller": "+16175559999",
      "forward_to": "+18005559999",
      "direction": "inbound",
      "duration": 142,
      "answered": true,
      "start_time": "2026-04-02T14:30:00Z",
      "end_time": "2026-04-02T14:32:22Z",
      "mos": 4.2,
      "jitter": 12.4,
      "packet_loss": 0.3,
      "r_factor": 88
    },
    {
      "id": "cdr-002",
      "did": "+17745551234",
      "caller": "+17815558888",
      "forward_to": "+18005559999",
      "direction": "inbound",
      "duration": 0,
      "answered": false,
      "start_time": "2026-04-02T16:10:05Z",
      "end_time": "2026-04-02T16:10:35Z",
      "mos": null,
      "jitter": null,
      "packet_loss": null,
      "r_factor": null
    }
  ],
  "total": 418,
  "offset": 0,
  "limit": 2
}`}
      />

      {/* ── CDR summary ──────────────────────────────── */}
      <H3>Usage summary</H3>
      <Endpoint method="GET" path="/api/v1/cdrs/summary" description="Return aggregated call statistics for the specified date range." />

      <ParamTable
        params={[
          { name: 'customer_id', type: 'integer', required: false, description: 'Scope summary to a specific customer account.' },
          { name: 'start_date',  type: 'string',  required: false, description: 'Start of the summary period (ISO 8601, UTC).' },
          { name: 'end_date',    type: 'string',  required: false, description: 'End of the summary period (ISO 8601, UTC).' },
          { name: 'did',         type: 'string',  required: false, description: 'Narrow the summary to a single DID.' },
        ]}
      />

      <ReqRes
        request={`curl "https://your-portal.example.com/api/v1/cdrs/summary\\
?start_date=2026-04-01T00:00:00Z\\
&end_date=2026-05-01T00:00:00Z" \\
  -H "Authorization: Bearer <token>"`}
        response={`{
  "total_calls": 1842,
  "answered_calls": 1671,
  "unanswered_calls": 171,
  "asr": 90.7,
  "total_duration_seconds": 237924,
  "acd_seconds": 142,
  "avg_mos": 4.18,
  "avg_jitter": 14.2,
  "avg_packet_loss": 0.4,
  "avg_r_factor": 87.3,
  "period_start": "2026-04-01T00:00:00Z",
  "period_end": "2026-05-01T00:00:00Z"
}`}
      />

      <NoteCards
        accent={BLUE}
        items={[
          {
            title: 'ASR — Answer Seizure Ratio',
            body: 'The percentage of calls that were answered (connected). ASR = (answered / total) × 100. A healthy RCF deployment typically shows ASR above 85%.',
          },
          {
            title: 'ACD — Average Call Duration',
            body: 'The mean duration in seconds of all answered calls. Unanswered calls (duration 0) are excluded from the ACD calculation.',
          },
          {
            title: 'Quality fields may be null',
            body: 'MOS, jitter, packet loss, and R-factor are only populated when RTP quality data is captured. Short or unanswered calls typically have null quality metrics.',
          },
          {
            title: 'Date ranges',
            body: 'Both start_date and end_date are optional. Omitting them returns all available records. For large accounts, always specify a date range to keep response times fast.',
          },
        ]}
      />

      <Callout accent={BLUE}>
        CDR data is retained for <strong style={{ color: C.text }}>90 days</strong>. For long-term
        record keeping, export CDRs periodically using the summary or detail endpoints and store
        them in your own data warehouse.
      </Callout>

      {/* ── Base URL + error codes ────────────────────── */}
      <H3>Base URL and error responses</H3>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 18px',
          borderRadius: 8,
          background: 'rgba(10,13,22,0.55)',
          border: '1px solid rgba(59,130,246,0.18)',
          marginBottom: 20,
        }}
      >
        <Server size={16} style={{ color: BLUE, flexShrink: 0 }} />
        <div>
          <div style={{ fontSize: '0.78rem', fontWeight: 700, color: C.textMuted, marginBottom: 3 }}>Base URL</div>
          <code style={{ color: '#93c5fd', fontFamily: 'monospace', fontSize: '0.82rem' }}>
            https://{'<'}your-portal-domain{'>'}/api/v1
          </code>
        </div>
      </div>

      <div
        style={{
          borderRadius: 8,
          overflow: 'hidden',
          border: '1px solid rgba(59,130,246,0.18)',
          marginBottom: 16,
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
          <thead>
            <tr style={{ background: 'rgba(10,13,22,0.7)' }}>
              {['Status', 'Meaning'].map(h => (
                <th
                  key={h}
                  style={{
                    padding: '9px 14px',
                    textAlign: 'left',
                    color: '#475569',
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    fontSize: '0.67rem',
                    textTransform: 'uppercase',
                    borderBottom: '1px solid rgba(59,130,246,0.15)',
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              { status: '200 OK',              meaning: 'Request succeeded. Response body contains the requested data.' },
              { status: '201 Created',         meaning: 'Resource created successfully. Response body contains the new resource.' },
              { status: '204 No Content',      meaning: 'Request succeeded with no response body (used by DELETE).' },
              { status: '400 Bad Request',     meaning: 'Request body or query parameters are invalid. Check the detail field in the error response.' },
              { status: '401 Unauthorized',    meaning: 'No token supplied, or the token has expired. Re-authenticate and retry.' },
              { status: '403 Forbidden',       meaning: 'Token is valid but does not have permission to access this resource.' },
              { status: '404 Not Found',       meaning: 'The requested DID or resource does not exist in your account.' },
              { status: '422 Unprocessable',   meaning: 'Validation error — the request body was parseable but failed field-level validation.' },
              { status: '500 Server Error',    meaning: 'Unexpected server-side error. Contact Granite support if this persists.' },
            ].map((row, i) => (
              <tr key={row.status} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(10,13,22,0.28)' }}>
                <td style={{ padding: '9px 14px', borderBottom: '1px solid rgba(42,47,69,0.3)', whiteSpace: 'nowrap' }}>
                  <code style={{ color: '#60a5fa', fontFamily: 'monospace', fontSize: '0.8rem', fontWeight: 700 }}>
                    {row.status}
                  </code>
                </td>
                <td style={{ padding: '9px 14px', borderBottom: '1px solid rgba(42,47,69,0.3)', color: C.textMuted, lineHeight: 1.55 }}>
                  {row.meaning}
                </td>
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
    </AccordionSection>
  );
}

/* ─── Page root ──────────────────────────────────────────── */

export function ApiDocsPage() {
  return (
    <div style={{ paddingTop: 20 }}>
      <PageHeaderCard
        eyebrow="Developer Reference"
        title="API Reference"
        subtitle="RESTful API documentation for programmatic access to the Granite Keystone platform"
        accent={BLUE}
      />

      <div style={{ padding: '0 0 60px' }}>
        <div style={{ maxWidth: 1080, margin: '0 auto' }}>
          <ApiAuthSection />
          <ApiRcfSection />
          <ApiCdrSection />
        </div>
      </div>
    </div>
  );
}
