/**
 * Integration Guide — step-by-step guides for integrating Granite Keystone
 * with external systems.
 *
 * Covers: Quick Start, Webhook Integration, SIP Trunk Integration,
 * Bulk Provisioning, Error Handling & Retry.
 */

import {
  Zap,
  Webhook,
  Network,
  Upload,
  ShieldAlert,
  ArrowRight,
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
  PageHeaderCard,
} from './shared';

/* ─── Accent colour for this page ───────────────────────── */

const AMBER = '#f59e0b';

/* ─── "Coming soon" badge ────────────────────────────────── */

function ComingSoonBadge() {
  return (
    <span
      style={{
        display: 'inline-block',
        marginLeft: 10,
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: '0.58rem',
        fontWeight: 700,
        letterSpacing: '0.07em',
        textTransform: 'uppercase',
        color: AMBER,
        background: `${AMBER}18`,
        border: `1px solid ${AMBER}35`,
        verticalAlign: 'middle',
        lineHeight: 1.8,
      }}
    >
      Coming Soon
    </span>
  );
}

/* ─── Section 1: Quick Start ─────────────────────────────── */

function QuickStartSection() {
  return (
    <AccordionSection
      id="quick-start"
      accent={AMBER}
      icon={<Zap size={18} />}
      title="Quick Start"
      subtitle="Get your first programmatic integration up and running in four steps."
      defaultOpen
    >
      <P>
        The Keystone API is RESTful, JSON-based, and secured with JWT bearer tokens. Integration takes
        minutes for simple use cases — get credentials, configure your first DID, set forwarding, and
        verify with a test call.
      </P>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
        {[
          {
            step: '1',
            title: 'Get API credentials',
            body: 'Log in to the portal, navigate to Account settings, and note your email address. Your API token is obtained by POST-ing to /api/v1/auth/login with your email and password. Store the returned access_token securely — treat it like a password.',
            tag: 'Auth',
          },
          {
            step: '2',
            title: 'Configure your first DID',
            body: 'POST to /api/v1/rcf with your DID in E.164 format (+1XXXXXXXXXX), the customer_id for your account, and the forward_to destination number. The API returns the created RCF entry immediately.',
            tag: 'Provision',
          },
          {
            step: '3',
            title: 'Set up forwarding rules',
            body: 'Update ring_timeout, failover_to, and pass_caller_id as needed for your deployment using PUT /api/v1/rcf/{did}. Partial updates are supported — only send the fields you want to change.',
            tag: 'Configure',
          },
          {
            step: '4',
            title: 'Verify with a test call',
            body: 'Place a call to your DID from a real phone and confirm it reaches the forwarding destination. Then query GET /api/v1/cdrs to confirm the call record was captured with the expected quality metrics.',
            tag: 'Verify',
          },
        ].map(({ step, title, body, tag }) => (
          <div
            key={step}
            style={{
              display: 'flex',
              gap: 16,
              padding: '18px 20px',
              borderRadius: 12,
              background: 'rgba(13,17,23,0.45)',
              border: `1px solid ${C.borderSubtle}`,
              position: 'relative',
            }}
          >
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: `${AMBER}18`,
                border: `1px solid ${AMBER}40`,
                color: AMBER,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '0.82rem',
                fontWeight: 800,
                flexShrink: 0,
                fontFamily: 'monospace',
              }}
            >
              {step}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <div style={{ fontSize: '0.9rem', fontWeight: 700, color: C.text }}>
                  {title}
                </div>
                <span
                  style={{
                    fontSize: '0.6rem',
                    fontWeight: 700,
                    letterSpacing: '0.07em',
                    textTransform: 'uppercase',
                    color: AMBER,
                    background: `${AMBER}14`,
                    border: `1px solid ${AMBER}28`,
                    borderRadius: 4,
                    padding: '1px 6px',
                  }}
                >
                  {tag}
                </span>
              </div>
              <div style={{ fontSize: '0.83rem', color: C.textMuted, lineHeight: 1.7 }}>
                {body}
              </div>
            </div>
          </div>
        ))}
      </div>

      <Callout accent={AMBER}>
        <strong style={{ color: C.text }}>See the API Reference</strong> for complete endpoint
        documentation including request/response examples and parameter tables. The{' '}
        <ArrowRight size={12} style={{ verticalAlign: 'middle', display: 'inline' }} />{' '}
        <strong style={{ color: C.text }}>API Reference</strong> page in the Documentation group
        covers Authentication, RCF Endpoints, and CDR/Usage in full detail.
      </Callout>

      <H3>Minimal working example</H3>
      <CodeBlock
        label="bash — provision a DID in one request"
        code={`# 1. Authenticate
TOKEN=$(curl -s -X POST https://your-portal.example.com/api/v1/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{"email":"you@example.com","password":"your-password"}' \\
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# 2. Provision the DID
curl -X POST https://your-portal.example.com/api/v1/rcf \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "did": "+17745551234",
    "customer_id": 7,
    "forward_to": "+18005559999",
    "name": "Main Line",
    "ring_timeout": 30,
    "failover_to": "+18005550000",
    "enabled": true
  }'`}
      />
    </AccordionSection>
  );
}

/* ─── Section 2: Webhook Integration ────────────────────── */

function WebhookSection() {
  return (
    <AccordionSection
      id="webhooks"
      accent={AMBER}
      icon={<Webhook size={18} />}
      title={<>Webhook Integration <ComingSoonBadge /></>}
      subtitle="Real-time push notifications for call events, CDR delivery, and failover alerts."
    >
      <Callout accent={AMBER}>
        Webhook support is currently in development. The payload schemas below reflect the planned
        interface — subscribe to release notes for availability updates.
      </Callout>

      <P>
        Webhooks allow Keystone to push call event data to your systems in real time rather than
        requiring your application to poll the CDR API. When a call event occurs, the platform makes
        an HTTP POST to your registered endpoint with a JSON payload describing the event.
      </P>

      <H3>Planned webhook events</H3>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 24 }}>
        {[
          {
            event: 'call.started',
            desc: 'Fires when an inbound call is received on a DID and forwarding begins. Includes the caller number, DID, and forward_to destination.',
          },
          {
            event: 'call.answered',
            desc: 'Fires when the forwarding destination picks up. Includes answer timestamp and destination number.',
          },
          {
            event: 'call.ended',
            desc: 'Fires when a call disconnects. Includes full CDR data: duration, MOS, jitter, packet loss, and R-factor.',
          },
          {
            event: 'call.failover',
            desc: 'Fires when ring timeout expires and the call is redirected to the failover destination. Includes both the primary and failover numbers.',
          },
        ].map(({ event, desc }) => (
          <div
            key={event}
            style={{
              padding: '14px 16px',
              borderRadius: 10,
              background: `${AMBER}06`,
              border: `1px solid ${AMBER}20`,
            }}
          >
            <div
              style={{
                fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                fontSize: '0.75rem',
                fontWeight: 700,
                color: AMBER,
                marginBottom: 8,
              }}
            >
              {event}
            </div>
            <div style={{ fontSize: '0.81rem', color: C.textMuted, lineHeight: 1.6 }}>
              {desc}
            </div>
          </div>
        ))}
      </div>

      <H3>Example webhook payload — call.ended</H3>
      <CodeBlock
        label="POST to your endpoint"
        code={`{
  "event": "call.ended",
  "event_id": "evt_7f3a2c1b-9e4d-4a8f-b1c2-3d5e6f7a8b9c",
  "timestamp": "2026-04-23T14:32:22Z",
  "api_version": "v1",
  "data": {
    "id": "cdr-001",
    "did": "+17745551234",
    "caller": "+16175559999",
    "forward_to": "+18005559999",
    "direction": "inbound",
    "duration": 142,
    "answered": true,
    "start_time": "2026-04-23T14:30:00Z",
    "end_time": "2026-04-23T14:32:22Z",
    "mos": 4.2,
    "jitter": 12.4,
    "packet_loss": 0.3,
    "r_factor": 88,
    "failover_used": false
  }
}`}
      />

      <H3>Webhook delivery and reliability</H3>

      <NoteCards
        accent={AMBER}
        items={[
          {
            title: 'HTTPS required',
            body: 'Your webhook endpoint must be reachable over HTTPS. HTTP-only endpoints will be rejected during registration.',
          },
          {
            title: 'Signature verification',
            body: 'Each request will include an X-Keystone-Signature header containing an HMAC-SHA256 signature of the payload. Verify this before processing.',
          },
          {
            title: 'Retry on failure',
            body: 'If your endpoint returns anything other than 2xx, the platform will retry up to 5 times with exponential backoff (1s, 2s, 4s, 8s, 16s).',
          },
          {
            title: 'Idempotency',
            body: 'Each event includes a unique event_id. Your endpoint should be idempotent — re-processing the same event_id must be safe in case of delivery retries.',
          },
        ]}
      />
    </AccordionSection>
  );
}

/* ─── Section 3: SIP Trunk Integration ──────────────────── */

function SipTrunkSection() {
  return (
    <AccordionSection
      id="sip-trunk"
      accent={AMBER}
      icon={<Network size={18} />}
      title={<>SIP Trunk Integration <ComingSoonBadge /></>}
      subtitle="Connect your PBX or softswitch directly to the Keystone platform via SIP trunking."
    >
      <Callout accent={AMBER}>
        SIP trunk provisioning is available for accounts with <IC>account_type: trunk</IC> or{' '}
        <IC>hybrid</IC>. Contact your Granite account team to enable SIP trunking on your account.
      </Callout>

      <P>
        SIP trunking gives your PBX or softswitch a direct IP-authenticated path to the Keystone
        platform for both inbound and outbound calls. Unlike RCF (which is fully hosted), SIP
        trunking requires configuration on both the Keystone side and your own equipment.
      </P>

      <H3>Prerequisites</H3>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }}>
        {[
          {
            title: 'Static public IP address',
            body: 'Your PBX must be reachable from the internet on a static IP. Dynamic IP addresses are not supported for IP authentication.',
          },
          {
            title: 'SIP-compatible PBX or softswitch',
            body: 'Compatible systems include Asterisk, FreePBX, 3CX, Cisco CUCM, Avaya Aura, and any standards-compliant SIP UA. RFC 3261 compliance required.',
          },
          {
            title: 'UDP or TCP port 5060 open outbound',
            body: 'Your firewall must allow outbound SIP traffic on port 5060 (UDP and/or TCP) to the Keystone SBC IP range. RTP media ports 10000–20000 UDP must also be permitted.',
          },
        ].map(({ title, body }, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              gap: 14,
              padding: '14px 16px',
              borderRadius: 8,
              background: 'rgba(13,17,23,0.45)',
              border: `1px solid ${C.borderSubtle}`,
            }}
          >
            <div
              style={{
                width: 20,
                height: 20,
                borderRadius: '50%',
                background: `${AMBER}18`,
                border: `1px solid ${AMBER}35`,
                color: AMBER,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '0.65rem',
                fontWeight: 800,
                flexShrink: 0,
                marginTop: 1,
              }}
            >
              {i + 1}
            </div>
            <div>
              <div style={{ fontSize: '0.84rem', fontWeight: 700, color: C.text, marginBottom: 4 }}>
                {title}
              </div>
              <div style={{ fontSize: '0.81rem', color: C.textMuted, lineHeight: 1.65 }}>
                {body}
              </div>
            </div>
          </div>
        ))}
      </div>

      <H3>Configuration steps</H3>

      <NoteCards
        accent={AMBER}
        items={[
          {
            title: '1 — Request trunk provisioning',
            body: 'Contact your Granite account team or submit a provisioning request through the admin portal. Specify the number of concurrent call channels and your DID range.',
          },
          {
            title: '2 — Whitelist your IP',
            body: 'Provide your static public IP to your Granite representative. The Keystone SBC will be updated to accept SIP registrations or invite requests from your IP.',
          },
          {
            title: '3 — Configure your PBX',
            body: 'Create a SIP trunk pointing to the Keystone SBC address (provided by your rep). Set the transport to UDP, port 5060. No SIP registration is required — auth is IP-based.',
          },
          {
            title: '4 — Configure codec preference',
            body: 'The platform supports G.711 (PCMU/PCMA), G.729, and G.722. Set your preferred codec order in your PBX trunk configuration. G.711u is recommended for lowest latency.',
          },
        ]}
      />

      <H3>Test call procedure</H3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
        {[
          'Place an inbound test call to one of your allocated DIDs from an external PSTN phone.',
          'Verify the call routes correctly to your PBX extension.',
          'Place an outbound test call through the trunk to an external PSTN number.',
          'Query GET /api/v1/cdrs to confirm both call records were captured.',
          'Review MOS and jitter metrics in the Call Quality page — target MOS above 4.0.',
        ].map((step, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
              padding: '10px 14px',
              borderRadius: 8,
              background: 'rgba(13,17,23,0.35)',
              border: `1px solid ${C.borderSubtle}`,
              fontSize: '0.82rem',
              color: C.textMuted,
              lineHeight: 1.6,
            }}
          >
            <span
              style={{
                minWidth: 20,
                height: 20,
                borderRadius: '50%',
                background: `${AMBER}14`,
                color: AMBER,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '0.65rem',
                fontWeight: 800,
                flexShrink: 0,
                marginTop: 1,
              }}
            >
              {i + 1}
            </span>
            {step}
          </div>
        ))}
      </div>
    </AccordionSection>
  );
}

/* ─── Section 4: Bulk Provisioning ──────────────────────── */

function BulkProvisioningSection() {
  return (
    <AccordionSection
      id="bulk-provisioning"
      accent={AMBER}
      icon={<Upload size={18} />}
      title={<>Bulk Provisioning <ComingSoonBadge /></>}
      subtitle="Provision hundreds of DIDs in a single operation using CSV upload."
    >
      <Callout accent={AMBER}>
        Bulk CSV provisioning is planned for a future release. The schema and workflow described
        here reflect the intended API design.
      </Callout>

      <P>
        For deployments with large DID inventories, manually provisioning numbers one-by-one via
        the API is impractical. Bulk provisioning lets you prepare a CSV file with all your DID
        configurations and submit it in a single API call. The platform processes the file
        asynchronously and returns a job ID you can poll for status.
      </P>

      <H3>CSV format</H3>
      <P>
        Each row in the CSV represents one RCF entry. The first row must be the header. All
        phone numbers must be in E.164 format. Boolean fields accept <IC>true</IC> or <IC>false</IC>.
      </P>

      <CodeBlock
        label="bulk-provision.csv"
        code={`did,customer_id,forward_to,name,pass_caller_id,ring_timeout,failover_to,enabled
+17745551001,7,+18005559001,Boston HQ,true,30,+18005550000,true
+17745551002,7,+18005559002,Boston Sales,true,25,,true
+17745551003,7,+16175553001,Cambridge Office,false,30,+18005550000,true
+17745551004,7,+16175553002,Cambridge Backup,true,45,,false
+16175555001,12,+18005559003,NYC Main,true,30,+18005550001,true`}
      />

      <H3>Column reference</H3>

      <div
        style={{
          borderRadius: 8,
          overflow: 'hidden',
          border: `1px solid ${AMBER}25`,
          marginBottom: 20,
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
          <thead>
            <tr style={{ background: 'rgba(10,13,22,0.7)' }}>
              {['Column', 'Required', 'Description'].map(h => (
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
                    borderBottom: `1px solid ${AMBER}20`,
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              { col: 'did',            req: true,  desc: 'Inbound DID in E.164 format. Must be allocated to the specified customer account.' },
              { col: 'customer_id',    req: true,  desc: 'Integer ID of the customer account this DID belongs to.' },
              { col: 'forward_to',     req: true,  desc: 'Forwarding destination in E.164 format.' },
              { col: 'name',           req: false, desc: 'Friendly label. Shown in the portal for reference only. Defaults to empty.' },
              { col: 'pass_caller_id', req: false, desc: 'true or false. Whether to pass the original caller ID. Default: true.' },
              { col: 'ring_timeout',   req: false, desc: 'Integer 5–120. Seconds before redirecting to failover. Default: 30.' },
              { col: 'failover_to',    req: false, desc: 'Failover destination in E.164. Leave empty for no failover.' },
              { col: 'enabled',        req: false, desc: 'true or false. Whether forwarding starts immediately. Default: true.' },
            ].map((row, i) => (
              <tr key={row.col} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(10,13,22,0.28)' }}>
                <td style={{ padding: '9px 14px', borderBottom: `1px solid rgba(42,47,69,0.3)`, whiteSpace: 'nowrap' }}>
                  <code style={{ color: '#60a5fa', fontFamily: 'monospace', fontSize: '0.8rem', fontWeight: 700 }}>
                    {row.col}
                  </code>
                </td>
                <td style={{ padding: '9px 14px', borderBottom: `1px solid rgba(42,47,69,0.3)`, whiteSpace: 'nowrap' }}>
                  <span
                    style={{
                      display: 'inline-block',
                      padding: '2px 7px',
                      borderRadius: 4,
                      fontSize: '0.67rem',
                      fontWeight: 700,
                      background: row.req ? 'rgba(59,130,246,0.12)' : 'rgba(71,85,105,0.2)',
                      color: row.req ? '#60a5fa' : '#475569',
                    }}
                  >
                    {row.req ? 'required' : 'optional'}
                  </span>
                </td>
                <td style={{ padding: '9px 14px', borderBottom: `1px solid rgba(42,47,69,0.3)`, color: C.textMuted, lineHeight: 1.55 }}>
                  {row.desc}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <H3>Provisioning workflow</H3>

      <NoteCards
        accent={AMBER}
        items={[
          {
            title: '1 — Prepare CSV',
            body: 'Build your CSV file following the schema above. Validate phone number formats before upload to avoid partial-success scenarios.',
          },
          {
            title: '2 — Upload via API',
            body: 'POST the CSV as multipart/form-data to /api/v1/rcf/bulk. The API returns a job_id and estimated completion time.',
          },
          {
            title: '3 — Poll for status',
            body: 'GET /api/v1/rcf/bulk/{job_id} to check progress. The response includes counts of succeeded, failed, and pending rows.',
          },
          {
            title: '4 — Review errors',
            body: 'The completed job response includes a per-row error list for any rows that failed validation or provisioning. Fix and re-upload just the failed rows.',
          },
        ]}
      />
    </AccordionSection>
  );
}

/* ─── Section 5: Error Handling & Retry ─────────────────── */

function ErrorHandlingSection() {
  return (
    <AccordionSection
      id="error-handling"
      accent={AMBER}
      icon={<ShieldAlert size={18} />}
      title="Error Handling & Retry"
      subtitle="HTTP status codes, retry strategy, and rate limiting — build integrations that fail gracefully."
    >
      <P>
        Production integrations must account for transient failures, rate limits, and validation
        errors. This section covers the full HTTP status code surface of the Keystone API and
        recommended patterns for resilient integration code.
      </P>

      <H3>HTTP status code reference</H3>

      <div
        style={{
          borderRadius: 8,
          overflow: 'hidden',
          border: `1px solid ${AMBER}25`,
          marginBottom: 24,
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
          <thead>
            <tr style={{ background: 'rgba(10,13,22,0.7)' }}>
              {['Status', 'Retryable', 'Action'].map(h => (
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
                    borderBottom: `1px solid ${AMBER}20`,
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              { status: '200 OK',           retryable: false, retry: 'no',  action: 'Request succeeded. Parse response body.' },
              { status: '201 Created',       retryable: false, retry: 'no',  action: 'Resource created. Store the returned ID for future updates.' },
              { status: '204 No Content',    retryable: false, retry: 'no',  action: 'Success with empty body (DELETE). No parsing needed.' },
              { status: '400 Bad Request',   retryable: false, retry: 'no',  action: 'Fix the request — invalid parameters or body. Check the detail field.' },
              { status: '401 Unauthorized',  retryable: true,  retry: 'auth', action: 'Re-authenticate via /auth/login to obtain a fresh token, then retry.' },
              { status: '403 Forbidden',     retryable: false, retry: 'no',  action: 'Token is valid but lacks permission. Contact your admin — do not retry.' },
              { status: '404 Not Found',     retryable: false, retry: 'no',  action: 'Resource does not exist. Verify the DID or ID in your request.' },
              { status: '409 Conflict',      retryable: false, retry: 'no',  action: 'DID already exists. Use PUT to update an existing entry instead of POST.' },
              { status: '429 Too Many Reqs', retryable: true,  retry: 'backoff', action: 'Rate limit hit. Honour the Retry-After header and use exponential backoff.' },
              { status: '500 Server Error',  retryable: true,  retry: 'backoff', action: 'Transient server error. Retry with exponential backoff up to 3 times.' },
              { status: '503 Unavailable',   retryable: true,  retry: 'backoff', action: 'Platform temporarily unavailable. Retry after 30s, then 60s, then 120s.' },
            ].map((row, i) => {
              const retryColor = row.retry === 'no'
                ? { color: '#475569', bg: 'rgba(71,85,105,0.15)' }
                : row.retry === 'auth'
                  ? { color: '#c084fc', bg: 'rgba(168,85,247,0.12)' }
                  : { color: AMBER, bg: `${AMBER}14` };

              return (
                <tr key={row.status} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(10,13,22,0.28)' }}>
                  <td style={{ padding: '9px 14px', borderBottom: `1px solid rgba(42,47,69,0.3)`, whiteSpace: 'nowrap' }}>
                    <code style={{ color: '#60a5fa', fontFamily: 'monospace', fontSize: '0.8rem', fontWeight: 700 }}>
                      {row.status}
                    </code>
                  </td>
                  <td style={{ padding: '9px 14px', borderBottom: `1px solid rgba(42,47,69,0.3)`, whiteSpace: 'nowrap' }}>
                    <span
                      style={{
                        display: 'inline-block',
                        padding: '2px 7px',
                        borderRadius: 4,
                        fontSize: '0.67rem',
                        fontWeight: 700,
                        background: retryColor.bg,
                        color: retryColor.color,
                      }}
                    >
                      {row.retry === 'no' ? 'no' : row.retry === 'auth' ? 'reauth' : 'backoff'}
                    </span>
                  </td>
                  <td style={{ padding: '9px 14px', borderBottom: `1px solid rgba(42,47,69,0.3)`, color: C.textMuted, lineHeight: 1.55 }}>
                    {row.action}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <H3>Exponential backoff strategy</H3>
      <P>
        For retryable errors (401 after re-auth, 429, 500, 503), use exponential backoff with jitter
        to avoid thundering-herd effects when multiple instances of your integration retry
        simultaneously.
      </P>

      <CodeBlock
        label="python — exponential backoff with jitter"
        code={`import time
import random
import requests

def api_request_with_retry(method, url, **kwargs):
    max_retries = 4
    base_delay = 1.0  # seconds

    for attempt in range(max_retries):
        try:
            resp = requests.request(method, url, **kwargs)

            if resp.status_code in (200, 201, 204):
                return resp

            # Rate limited — honour Retry-After if present
            if resp.status_code == 429:
                retry_after = int(resp.headers.get("Retry-After", base_delay * (2 ** attempt)))
                time.sleep(retry_after)
                continue

            # Transient server errors
            if resp.status_code in (500, 503):
                if attempt < max_retries - 1:
                    delay = base_delay * (2 ** attempt) + random.uniform(0, 0.5)
                    time.sleep(delay)
                    continue

            # Non-retryable — raise immediately
            resp.raise_for_status()

        except requests.exceptions.ConnectionError:
            if attempt < max_retries - 1:
                delay = base_delay * (2 ** attempt) + random.uniform(0, 0.5)
                time.sleep(delay)
            else:
                raise

    raise RuntimeError(f"Request failed after {max_retries} attempts")`}
      />

      <Callout accent={AMBER}>
        <strong style={{ color: C.text }}>Rate limit: 100 requests per minute</strong> per API
        token. Bulk operations (CDR exports, large list queries) count toward this limit. If you need
        a higher limit for automated provisioning workflows, contact your Granite account team to
        discuss a rate limit increase.
      </Callout>

      <H3>Idempotency for safe retries</H3>
      <P>
        POST requests to <IC>/api/v1/rcf</IC> are <strong style={{ color: C.text }}>not idempotent</strong>{' '}
        by default — retrying a failed POST may create duplicate entries. To avoid this:
      </P>

      <NoteCards
        accent={AMBER}
        items={[
          {
            title: 'Check before create',
            body: 'Before POSTing a new DID, first GET /api/v1/rcf/{did} to check if it already exists. If you get 200, use PUT to update instead.',
          },
          {
            title: 'Use the Idempotency-Key header',
            body: 'Include a unique Idempotency-Key UUID header on POST requests. The platform will return the same response for duplicate requests with the same key within 24 hours.',
          },
          {
            title: '409 Conflict on duplicate',
            body: 'If you POST a DID that already exists and do not include an Idempotency-Key, the API returns 409 Conflict. Handle this by switching to a PUT request.',
          },
          {
            title: 'DELETE is always safe to retry',
            body: 'DELETE returns 204 whether or not the resource existed. Retrying a DELETE after a timeout is always safe — you will not get an error if the resource was already deleted.',
          },
        ]}
      />
    </AccordionSection>
  );
}

/* ─── Page root ──────────────────────────────────────────── */

export function IntegrationDocsPage() {
  return (
    <div style={{ paddingTop: 20 }}>
      <PageHeaderCard
        eyebrow="Integration Guide"
        title="Integration Guide"
        subtitle="Step-by-step guides for integrating Granite Keystone with your systems"
        accent={AMBER}
      />

      <div style={{ padding: '0 0 60px' }}>
        <div style={{ maxWidth: 1080, margin: '0 auto' }}>
          <QuickStartSection />
          <WebhookSection />
          <SipTrunkSection />
          <BulkProvisioningSection />
          <ErrorHandlingSection />
        </div>
      </div>
    </div>
  );
}
