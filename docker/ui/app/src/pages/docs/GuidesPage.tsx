/**
 * Guides — the product-aware documentation hub for Granite CRAG.
 *
 * One page, four products (RCF, SIP Trunking, API Calling, Visual Voicemail),
 * selected via the shared ProductSelector and deep-linked through
 * /docs/guides/:product? (default rcf). The RCF guide carries forward the
 * substance of the retired RcfDocsPage, updated to the current portal UI.
 *
 * Styling: shared DAYLIGHT CONSOLE (`dl-*`) + docs primitives (`dlx-`/`dlx8-`).
 * React #310: hooks (useParams/useNavigate) run unconditionally at the top.
 */

import { useNavigate, useParams, Navigate, Link } from 'react-router-dom';
import {
  LogIn, Phone, HelpCircle, Activity, Hash, Network, ClipboardList,
  ShieldCheck, Gauge, Globe, Wrench, Zap, Code, Radio, Voicemail, Inbox,
} from 'lucide-react';

import { C } from './tokens';
import {
  P, H3, IC, UL, Callout, AccordionSection, NoteCards, CodeBlock, DocsHeader,
} from './shared';
import { ProductSelector } from './ProductSelector';
import { GUIDE_PRODUCTS, isGuideProduct } from './docProducts';

const ACCENT = '#2f7df6';
const AMBER = '#b45309';

/* ═══════════════════════════════════════════════════════════
   RCF — carried forward from the retired RcfDocsPage, updated
   to the current expandable-row portal UI.
   ═══════════════════════════════════════════════════════════ */

function RcfGettingStarted() {
  return (
    <AccordionSection
      id="rcf-getting-started"
      icon={<LogIn size={18} />}
      title="Getting started"
      subtitle="Log in and verify your numbers are working."
      defaultOpen
    >
      <P>
        Your administrator provides your login credentials. Sign in at your portal URL and open
        the <strong style={{ color: C.text }}>RCF</strong> page from the sidebar. Confirm your
        numbers are listed, enabled, and forwarding to the correct destinations, then place a
        test call to verify.
      </P>
      <Callout accent={ACCENT}>
        If you need your password reset, contact your administrator or
        email <strong style={{ color: C.text }}>solutions@granitenet.com</strong>.
      </Callout>
    </AccordionSection>
  );
}

function RcfManagingNumbers() {
  return (
    <AccordionSection
      id="rcf-managing"
      icon={<Phone size={18} />}
      title="Managing your numbers"
      subtitle="Forwarding, failover, ring timeout, caller ID — all from the expandable row editor."
    >
      <P>
        The <strong style={{ color: C.text }}>My Numbers</strong> tab lists every RCF number on
        your account. Click any row to expand its configuration panel. Changes take effect within
        seconds — no support tickets required. Calls already in progress are never affected.
      </P>

      <H3>Change a forwarding destination</H3>
      <P>
        Expand the row, type the new destination in E.164 format (<IC>+17745551234</IC>), and
        save. New calls immediately route to the updated number.
      </P>

      <H3>Failover destination</H3>
      <P>
        An optional backup number. If the primary destination does not answer before the ring
        timeout expires, the call automatically redirects to the failover destination. Clear the
        field to remove it.
      </P>

      <H3>Ring timeout</H3>
      <P>
        How long the call rings at the destination before giving up (default 30 seconds, range
        5–120s). If a failover number is configured, unanswered calls redirect there
        automatically.
      </P>

      <H3>Enable or disable a number</H3>
      <P>
        Use the toggle on each row. Disabled numbers stop forwarding but keep all settings
        intact — re-enable anytime and forwarding resumes instantly.
      </P>

      <H3>Caller ID pass-through</H3>
      <P>
        Controls what the destination phone sees when a forwarded call
        arrives. <strong style={{ color: C.text }}>Pass-through</strong> shows the original
        caller&rsquo;s number; <strong style={{ color: C.text }}>show this DID</strong> displays
        your RCF number instead. It&rsquo;s an instant toggle in the row editor.
      </P>

      <H3>Name / label</H3>
      <P>
        Assign a friendly name like &ldquo;Main Office&rdquo; or &ldquo;Boston Sales&rdquo; to any
        line. Labels are for your reference only — they never affect routing.
      </P>

      <Callout accent={ACCENT}>
        Phone numbers use <strong style={{ color: C.text }}>E.164 format</strong>: a <IC>+</IC>{' '}
        followed by country code and number with no spaces. US
        example: <IC>+17745551234</IC>. The maximum concurrent-call limit on a number is set by
        Granite — contact your account team to change it.
      </Callout>
    </AccordionSection>
  );
}

function RcfCallActivity() {
  return (
    <AccordionSection
      id="rcf-activity"
      icon={<Activity size={18} />}
      title="Call activity &amp; quality"
      subtitle="Recent calls, answer rates, and voice-quality scores for your numbers."
    >
      <P>
        Switch to the <strong style={{ color: C.text }}>Call Activity</strong> tab to monitor how
        your numbers are performing:
      </P>
      <UL
        items={[
          <>Recent calls with time, caller, destination, duration, and outcome.</>,
          <><strong style={{ color: C.text }}>ASR%</strong> — answer-seizure ratio, the share of calls that were answered.</>,
          <><strong style={{ color: C.text }}>MOS</strong> — mean opinion score, a 1–5 voice-quality rating measured per call (4.0+ is excellent).</>,
          <>A 7-day performance graph plotting MOS and ASR together, so quality dips are easy to spot.</>,
          <>Search and filtering by number or date to isolate a single line.</>,
        ]}
      />
      <P>
        For deeper analysis — jitter, packet loss, per-call detail — open
        the <strong style={{ color: C.text }}>Call Quality</strong> page from the sidebar.
      </P>
    </AccordionSection>
  );
}

function RcfNumberManagement() {
  return (
    <AccordionSection
      id="rcf-numbers"
      icon={<Hash size={18} />}
      title="Number management"
      subtitle="Request new numbers, track pending requests, and release numbers you no longer need."
    >
      <H3>Your numbers</H3>
      <P>
        The <strong style={{ color: C.text }}>Number Management</strong> tab lists every DID
        assigned to your account with its current status. Active numbers are ready to forward
        calls.
      </P>

      <H3>Requesting a new number</H3>
      <P>
        Browse the <strong style={{ color: C.text }}>Available Numbers</strong> list, filter by
        area code, city, or state, then request the number you want. Each listing shows the city,
        state, and rate center. Requested numbers are reserved for you and reviewed by a Granite
        administrator — once approved, the number appears in your RCF lineup automatically and
        you can configure forwarding right away.
      </P>

      <H3>Releasing a number</H3>
      <P>
        Number release is <strong style={{ color: C.text }}>request-based</strong>. Click{' '}
        <strong style={{ color: C.text }}>Request Release</strong> on the number you want to
        return. The request is routed to Granite engineering for review; the number keeps
        forwarding normally while the release is pending, and you can cancel the request any time
        before it is approved. Once approved, the number is removed from your account.
      </P>

      <Callout accent={ACCENT}>
        Both flows are reviewed by Granite before anything changes hands — you can&rsquo;t lose a
        number by accident. If a request has been pending for an extended period, contact your
        account team.
      </Callout>
    </AccordionSection>
  );
}

function RcfSupport() {
  return (
    <AccordionSection
      id="rcf-support"
      icon={<HelpCircle size={18} />}
      title="Need help?"
      subtitle="Quick checks and support contact."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
        {[
          { q: 'Calls not forwarding?', a: 'Check the toggle is enabled and the forwarding number is correct.' },
          { q: 'Wrong destination?', a: 'Expand the row and edit the forwarding number. Use full E.164 format.' },
          { q: 'Destination not answering?', a: 'Call the forwarding number directly to confirm it works, then check the ring timeout and failover settings.' },
          { q: 'Quality complaints?', a: 'Check the Call Activity tab — a low MOS on specific calls narrows the problem to a time window you can report.' },
        ].map(({ q, a }, i) => (
          <div key={i} className="dlx-item">
            <span style={{ fontSize: '0.83rem', fontWeight: 700, color: C.text }}>{q}</span>{' '}
            <span style={{ fontSize: '0.81rem', color: C.textMuted }}>{a}</span>
          </div>
        ))}
      </div>
      <Callout accent={ACCENT}>
        Email <strong style={{ color: C.text }}>solutions@granitenet.com</strong> with the
        affected number and the approximate time of the issue.
      </Callout>
    </AccordionSection>
  );
}

function RcfGuide() {
  return (
    <>
      <RcfGettingStarted />
      <RcfManagingNumbers />
      <RcfCallActivity />
      <RcfNumberManagement />
      <RcfSupport />
    </>
  );
}

/* ═══════════════════════════════════════════════════════════
   SIP Trunking
   ═══════════════════════════════════════════════════════════ */

function TrunkHowItWorks() {
  return (
    <AccordionSection
      id="trunk-how"
      icon={<Network size={18} />}
      title="How IP-authenticated trunking works"
      subtitle="No registration, no passwords on the wire — your source IP is your identity."
      defaultOpen
    >
      <P>
        Granite CRAG trunks use <strong style={{ color: C.text }}>IP peering</strong>: you tell
        us the public signaling IP addresses of your PBX or SBC, and the platform accepts SIP
        traffic from exactly those addresses on your trunk. There is no SIP REGISTER and no
        credential exchange — a call is authorized because it arrives from an IP you control.
      </P>
      <UL
        items={[
          <><strong style={{ color: C.text }}>Outbound:</strong> your PBX sends INVITEs to the platform from an authorized IP; calls are matched to your trunk and delivered to the PSTN.</>,
          <><strong style={{ color: C.text }}>Inbound:</strong> calls to the DIDs on your trunk are delivered to your PBX at its signaling address.</>,
          <>Unknown source IPs are rejected at the edge — keeping your authorized-IP list current is the one operational duty this model asks of you.</>,
        ]}
      />
      <Callout accent={ACCENT}>
        Because there are no credentials to steal, IP peering removes the most common trunk-fraud
        vector. The trade-off: if your site&rsquo;s public IP changes (new ISP, new firewall,
        failover circuit), calls stop until the new address is added to the trunk.
      </Callout>
    </AccordionSection>
  );
}

function TrunkProvisioning() {
  return (
    <AccordionSection
      id="trunk-provisioning"
      icon={<ClipboardList size={18} />}
      title="Getting provisioned"
      subtitle="Intake form to first call — what your account team needs from you."
    >
      <P>
        Trunks are provisioned by your Granite account team from your intake submission. To size
        and build the trunk we need:
      </P>
      <UL
        items={[
          <><strong style={{ color: C.text }}>Signaling IPs (1–10)</strong> — the public IP addresses (or small CIDR blocks) your PBX/SBC sends SIP from. These are mandatory: the platform is IP-peering only.</>,
          <><strong style={{ color: C.text }}>Concurrent call paths</strong> — how many simultaneous calls the trunk should carry (see the call-paths section below for sizing).</>,
          <><strong style={{ color: C.text }}>PBX or SBC vendor</strong> — optional, but helps us flag known interop settings.</>,
          <><strong style={{ color: C.text }}>DIDs needed</strong> — new numbers, ported numbers, or both.</>,
        ]}
      />
      <P>
        Once the trunk is built you&rsquo;ll see it on the{' '}
        <strong style={{ color: C.text }}>SIP Trunking</strong> page of the portal with its
        authorized IPs, DIDs, and live status. Point your PBX at the platform, place a test call
        in each direction, and you&rsquo;re in production.
      </P>
    </AccordionSection>
  );
}

function TrunkManagingIps() {
  return (
    <AccordionSection
      id="trunk-ips"
      icon={<ShieldCheck size={18} />}
      title="Managing authorized IPs"
      subtitle="Self-service — add or remove your trunk's source addresses in the portal."
    >
      <P>
        The <strong style={{ color: C.text }}>Authorized source IPs</strong> section of your
        trunk page lists every address allowed to send calls. You can manage this list yourself:
      </P>
      <UL
        items={[
          <><strong style={{ color: C.text }}>Add an IP</strong> — enter the address (e.g. <IC>203.0.113.50</IC>) with an optional description like &ldquo;HQ firewall&rdquo;. It takes effect immediately.</>,
          <><strong style={{ color: C.text }}>Remove an IP</strong> — calls from that address are rejected as soon as it is deleted, so remove old addresses only after traffic has moved.</>,
          <>Planning a firewall or ISP change? Add the new address <em>before</em> cutover so there is no gap in service.</>,
        ]}
      />
      <Callout accent={ACCENT}>
        Treat the IP list like a security control — it is one. Keep it to addresses you actually
        operate, and remove decommissioned sites promptly.
      </Callout>
    </AccordionSection>
  );
}

function TrunkDids() {
  return (
    <AccordionSection
      id="trunk-dids"
      icon={<Hash size={18} />}
      title="DIDs on your trunk"
      subtitle="Inbound numbers that deliver to your PBX."
    >
      <P>
        DIDs assigned to your trunk ring straight through to your PBX — the called number arrives
        in the SIP Request-URI so your PBX can route it to the right extension, queue, or
        auto-attendant.
      </P>
      <UL
        items={[
          <>Your trunk page lists every DID currently assigned.</>,
          <>Need more numbers? Request them from the available inventory (same request-and-review flow as RCF) or ask your account team about porting existing numbers in.</>,
          <>Releasing a number is request-based and reviewed by Granite engineering — nothing is removed until approved.</>,
        ]}
      />
    </AccordionSection>
  );
}

function TrunkCallPaths() {
  return (
    <AccordionSection
      id="trunk-callpaths"
      icon={<Gauge size={18} />}
      title="Concurrent call paths"
      subtitle="What they mean and how to size them."
    >
      <P>
        A <strong style={{ color: C.text }}>call path</strong> is one simultaneous call —
        inbound or outbound. A trunk with 23 call paths can carry 23 concurrent conversations;
        the 24th attempt is declined until a path frees up. Your call-path count is the capacity
        you&rsquo;ve purchased, and it is enforced by the platform.
      </P>
      <H3>Sizing</H3>
      <UL
        items={[
          <>Size for your <strong style={{ color: C.text }}>busy hour</strong>, not your average. A common starting point for general office traffic is one path per 8–10 users; call-heavy teams (sales desks, dispatch, contact centers) need closer to one path per 2–3 agents.</>,
          <>Watch the live utilization gauge on your trunk page — sustained peaks near 100% mean callers are getting busy signals and it&rsquo;s time to add paths.</>,
          <>Call paths are sold in packages; your account team can resize the trunk without any change on your PBX.</>,
        ]}
      />
    </AccordionSection>
  );
}

function TrunkMonitoring() {
  return (
    <AccordionSection
      id="trunk-monitoring"
      icon={<Activity size={18} />}
      title="Live activity &amp; stats"
      subtitle="Real-time channel usage plus rolling quality metrics."
    >
      <P>Your trunk page shows a live panel that refreshes automatically:</P>
      <UL
        items={[
          <><strong style={{ color: C.text }}>Active channels</strong> — calls in progress right now, against your call-path ceiling, with a utilization percentage.</>,
          <><strong style={{ color: C.text }}>Last hour</strong> — total calls, answered calls, ASR, and average duration.</>,
          <>The <strong style={{ color: C.text }}>Call Quality</strong> page adds per-call MOS, jitter, and packet loss across your whole account.</>,
        ]}
      />
      <P>
        The same numbers are available programmatically — see the{' '}
        <Link to="/docs/api/trunking" style={{ color: ACCENT, fontWeight: 600 }}>SIP Trunking API reference</Link>.
      </P>
    </AccordionSection>
  );
}

function TrunkRedundancy() {
  return (
    <AccordionSection
      id="trunk-redundancy"
      icon={<Globe size={18} />}
      title="Redundancy &amp; failover"
      subtitle="Multi-region inbound delivery with automatic health-based routing."
    >
      <P>
        The platform runs in three independent US regions (East, West, and Central), each a
        complete voice stack with redundant session border controllers. Inbound calls to your
        DIDs enter at the healthy region nearest the caller — the failure of a single node, or
        even a whole region, does not take your numbers down.
      </P>
      <UL
        items={[
          <>Inside each region, paired SBCs share load and cover for each other automatically.</>,
          <>DNS-based failover steers your outbound traffic to a healthy entry point — follow the DNS target from your provisioning packet rather than pinning a single IP where your PBX supports it.</>,
          <>For site-level resilience on your side, add the signaling IPs of a backup site or circuit to the trunk in advance so failover needs no provisioning change.</>,
        ]}
      />
    </AccordionSection>
  );
}

function TrunkTroubleshooting() {
  return (
    <AccordionSection
      id="trunk-troubleshooting"
      icon={<Wrench size={18} />}
      title="Troubleshooting basics"
      subtitle="What to check before opening a ticket."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
        {[
          { q: 'All calls rejected?', a: 'Check the authorized-IP list first. Has your public IP changed (ISP failover, new firewall)? Confirm the exact address your PBX egresses from.' },
          { q: 'Outbound fails, inbound works?', a: 'Verify the dialed format — destinations should be E.164 (+1...). Check whether you have hit your concurrent call-path ceiling on the live stats panel.' },
          { q: 'Inbound fails, outbound works?', a: 'Confirm your PBX is reachable at its signaling address and answering SIP on the expected port; check any firewall rules in front of it.' },
          { q: 'One-way or poor audio?', a: 'Usually NAT or firewall RTP handling on the PBX side. Check the Call Quality page for packet loss and jitter on the affected calls.' },
        ].map(({ q, a }, i) => (
          <div key={i} className="dlx-item">
            <span style={{ fontSize: '0.83rem', fontWeight: 700, color: C.text }}>{q}</span>{' '}
            <span style={{ fontSize: '0.81rem', color: C.textMuted }}>{a}</span>
          </div>
        ))}
      </div>
      <Callout accent={ACCENT}>
        When you do open a ticket, include an example call: the from and to numbers and the
        approximate time. One concrete call lets engineering pull the full SIP trace immediately.
      </Callout>
    </AccordionSection>
  );
}

function TrunkGuide() {
  return (
    <>
      <TrunkHowItWorks />
      <TrunkProvisioning />
      <TrunkManagingIps />
      <TrunkDids />
      <TrunkCallPaths />
      <TrunkMonitoring />
      <TrunkRedundancy />
      <TrunkTroubleshooting />
    </>
  );
}

/* ═══════════════════════════════════════════════════════════
   API Calling — early access
   ═══════════════════════════════════════════════════════════ */

function CallingWhatItIs() {
  return (
    <AccordionSection
      id="calling-what"
      icon={<Zap size={18} />}
      title="What API Calling is"
      subtitle="Programmable outbound voice on Granite's own network — currently in early access."
      defaultOpen
    >
      <P>
        API Calling lets your software place and control phone calls over REST. Your application
        POSTs a request with one of your Granite numbers and a destination; the platform
        originates the call directly on the network — no third-party CPaaS in the path — and
        every call lands in the same CDR and quality telemetry as the rest of your account.
      </P>
      <UL
        items={[
          <>Place outbound calls from your assigned API numbers.</>,
          <>Control live calls — hang up, transfer, or send DTMF.</>,
          <>Poll call status in real time and pull full call records afterward.</>,
          <>Throughput is governed by your calls-per-second tier, enforced per account.</>,
        ]}
      />
      <H3>Requesting access</H3>
      <P>
        API Calling is in <strong style={{ color: C.text }}>early access</strong>. To enroll,
        select API Calling on the onboarding form or contact your account team with your use
        case and expected call volume; we&rsquo;ll assign numbers and a CPS tier sized to it.
      </P>
    </AccordionSection>
  );
}

function CallingQuickstart() {
  return (
    <AccordionSection
      id="calling-quickstart"
      icon={<Code size={18} />}
      title="Quickstart"
      subtitle="Authenticate, place a call, check its status."
    >
      <P>
        Three requests take you from zero to a completed call. Authenticate to get a bearer
        token, place the call from one of your API numbers, then poll its status.
      </P>
      <CodeBlock
        label="bash"
        code={`# 1. Authenticate and capture the token
TOKEN=$(curl -s -X POST https://your-portal-url/api/v1/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{"email":"you@example.com","password":"your-password"}' \\
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# 2. Place a call from your API number
curl -X POST https://your-portal-url/api/v1/calls \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"from_did": "+16175551001", "to": "+17745556789"}'
# -> {"call_id": "5f0c...", "status": "initiated", ...}

# 3. Check the call's status (live, then completed with duration + hangup cause)
CALL_ID="<call_id from step 2>"
curl "https://your-portal-url/api/v1/calls/$CALL_ID" \\
  -H "Authorization: Bearer $TOKEN"`}
      />
      <P>
        Full request/response schemas, the live-call control endpoint, and CPS-limit behavior are
        in the{' '}
        <Link to="/docs/api/calling" style={{ color: ACCENT, fontWeight: 600 }}>API Calling reference</Link>.
      </P>
    </AccordionSection>
  );
}

function CallingEvents() {
  return (
    <AccordionSection
      id="calling-events"
      icon={<Radio size={18} />}
      title="Events &amp; telemetry"
      subtitle="What you can observe today, and what's still maturing in early access."
    >
      <P>
        Two observation paths are fully available today:
      </P>
      <UL
        items={[
          <><strong style={{ color: C.text }}>Status polling</strong> — <IC>GET /v1/calls/{'{call_id}'}</IC> returns live state while the call is up, and the completed record (duration, hangup cause) afterward.</>,
          <><strong style={{ color: C.text }}>CDRs</strong> — every API call produces a full call record with quality metrics, available seconds after hangup via <IC>GET /v1/cdrs</IC>.</>,
        ]}
      />
      <Callout accent={AMBER}>
        <strong style={{ color: C.text }}>Early access note:</strong> a <IC>webhook_url</IC> can
        be attached to each call, but pushed webhook event delivery is still maturing and should
        not yet be your only integration path. Build on status polling and CDRs today; your
        account team will flag when webhook events are ready to rely on.
      </Callout>
    </AccordionSection>
  );
}

function CallingGuide() {
  return (
    <>
      <CallingWhatItIs />
      <CallingQuickstart />
      <CallingEvents />
    </>
  );
}

/* ═══════════════════════════════════════════════════════════
   Visual Voicemail — roadmap only, clearly labeled
   ═══════════════════════════════════════════════════════════ */

function VoicemailGuide() {
  return (
    <>
      <Callout accent={AMBER}>
        <strong style={{ color: C.text }}>Roadmap preview.</strong> Visual Voicemail is in
        development and not yet available — everything below describes what&rsquo;s coming, not
        what you can configure today.
      </Callout>

      <AccordionSection
        id="vvm-coming"
        icon={<Voicemail size={18} />}
        title="What's coming"
        subtitle="Voicemail you manage like email — designed into the platform, not bolted on."
        defaultOpen
      >
        <NoteCards
          items={[
            { title: 'Automatic transcription', body: 'Every message arrives with searchable text alongside the audio — read it in seconds instead of dialing in.' },
            { title: 'Instant delivery', body: 'Messages appear in the portal moments after the caller hangs up, playable from any browser or device.' },
            { title: 'Works with your numbers', body: 'Mailboxes attach to the numbers you already have — no new numbers, no porting, no dial-in menus.' },
            { title: 'Per-mailbox controls', body: 'Greetings, notification preferences, and retention set individually on each mailbox.' },
            { title: 'Private by design', body: 'Message content is encrypted at rest; access follows the same account permissions as the rest of the portal.' },
            { title: 'API access', body: 'Mailboxes and messages will be readable over the same REST API and auth you use today.' },
          ]}
        />
      </AccordionSection>

      <AccordionSection
        id="vvm-mailboxes"
        icon={<Inbox size={18} />}
        title="How mailboxes will attach"
        subtitle="Add voicemail to existing numbers — RCF lines, trunk DIDs, or new numbers."
      >
        <P>
          A mailbox is attached to a number, not a separate product you migrate to. When a
          forwarded or delivered call goes unanswered past your ring timeout, it will roll to the
          number&rsquo;s mailbox instead of ringing out. You&rsquo;ll choose which numbers get
          mailboxes — one line or your whole inventory — and manage them from the portal.
        </P>
        <Callout accent={ACCENT}>
          Want in early? Email <strong style={{ color: C.text }}>solutions@granitenet.com</strong>{' '}
          to join the pilot list — pilot customers get first access and help shape the mailbox
          controls.
        </Callout>
      </AccordionSection>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════
   Page root
   ═══════════════════════════════════════════════════════════ */

const GUIDE_CONTENT: Record<(typeof GUIDE_PRODUCTS)[number], () => React.ReactNode> = {
  rcf: RcfGuide,
  trunking: TrunkGuide,
  calling: CallingGuide,
  voicemail: VoicemailGuide,
};

export function GuidesPage() {
  // Hooks unconditionally at the top (React #310).
  const { product } = useParams<{ product: string }>();
  const navigate = useNavigate();

  // Unknown slug in the URL → clean up to the hub default.
  if (product !== undefined && !isGuideProduct(product)) {
    return <Navigate to="/docs/guides" replace />;
  }

  const active = isGuideProduct(product) ? product : 'rcf';
  const Content = GUIDE_CONTENT[active];

  return (
    <div className="dl-scope">
      <div className="dl-shell">
        <DocsHeader
          crumb="Guides"
          title="Guides"
          subtitle="How to set up and run each Granite CRAG product — pick a product to get started"
        />

        <div className="dlx-docs-col fx-load fx-load-d1">
          <ProductSelector
            products={GUIDE_PRODUCTS}
            active={active}
            onSelect={p => navigate(`/docs/guides/${p}`)}
          />

          {/* Keyed by product so accordion open-state resets on switch */}
          <div key={active} className="dl-stack">
            <Content />
          </div>
        </div>
      </div>
    </div>
  );
}
