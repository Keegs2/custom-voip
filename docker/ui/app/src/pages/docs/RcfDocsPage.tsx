/**
 * RCF User Guide — customer-facing documentation for Granite Keystone RCF.
 *
 * Covers: Getting Started, Managing Numbers, Forwarding, Enable/Disable,
 * Caller ID, Ring Timeout/Failover, Call Quality, Troubleshooting.
 */

import {
  Phone,
  ToggleLeft,
  UserCheck,
  PhoneOff,
  BarChart2,
  HelpCircle,
  LogIn,
} from 'lucide-react';

import {
  C,
  P,
  H3,
  IC,
  Callout,
  AccordionSection,
  NoteCards,
  PageHeaderCard,
} from './shared';

/* ─── Accent colour for this page ───────────────────────── */

const GREEN = '#4ade80';

/* ─── Getting Started ────────────────────────────────────── */

function GettingStartedSection() {
  return (
    <AccordionSection
      id="getting-started"
      accent={GREEN}
      icon={<LogIn size={18} />}
      title="Getting Started"
      subtitle="What Granite Keystone RCF is, how to log in, and a quick start checklist."
      defaultOpen
    >
      <P>
        Granite Keystone Remote Call Forwarding lets you route inbound calls from your business numbers to any destination. Manage forwarding rules, monitor call quality, and troubleshoot — all from one portal.
      </P>

      <H3>How to log in</H3>
      <P>
        Your administrator provides your credentials (email address and password). Navigate to your portal URL in a web browser and sign in. If you have forgotten your password, contact your administrator or Granite support to have it reset.
      </P>

      <H3>Portal overview</H3>
      <P>
        The left sidebar gives you access to all features. For RCF customers, the available pages are:
      </P>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 20 }}>
        {[
          {
            icon: <Phone size={15} />,
            title: 'RCF',
            body: 'Manage your call forwarding numbers — view, edit destinations, enable/disable, and configure ring timeout and failover.',
          },
          {
            icon: <BarChart2 size={15} />,
            title: 'Call Quality',
            body: 'Monitor MOS scores, jitter, packet loss, and R-factor across your calls. Identify quality trends and investigate complaints.',
          },
          {
            icon: <HelpCircle size={15} />,
            title: 'Troubleshooting',
            body: 'Access the built-in Homer SIP capture tool for packet-level inspection of call signaling when issues need deep investigation.',
          },
          {
            icon: <UserCheck size={15} />,
            title: 'Account',
            body: 'Update your display name and password. Accessible from the user profile area at the bottom of the sidebar.',
          },
        ].map(({ icon, title, body }) => (
          <div
            key={title}
            style={{
              padding: '14px 16px',
              borderRadius: 10,
              background: `${GREEN}08`,
              border: `1px solid ${GREEN}20`,
            }}
          >
            <div style={{ color: GREEN, marginBottom: 8 }}>{icon}</div>
            <div style={{ fontSize: '0.84rem', fontWeight: 700, color: C.text, marginBottom: 5 }}>
              {title}
            </div>
            <div style={{ fontSize: '0.81rem', color: C.textMuted, lineHeight: 1.6 }}>
              {body}
            </div>
          </div>
        ))}
      </div>

      <H3>Quick start checklist</H3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
        {[
          { step: '1', text: 'Log in with the credentials provided by your administrator.' },
          { step: '2', text: 'Navigate to the RCF page using the left sidebar.' },
          { step: '3', text: 'Confirm your numbers are listed and the Status column shows them as enabled.' },
          { step: '4', text: 'Verify the Forward To column shows the correct destination for each number.' },
          { step: '5', text: 'Place a test call to one of your DIDs and confirm it reaches the expected destination.' },
        ].map(({ step, text }) => (
          <div
            key={step}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
              padding: '12px 16px',
              borderRadius: 8,
              background: 'rgba(13,17,23,0.45)',
              border: `1px solid ${C.borderSubtle}`,
            }}
          >
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                background: `${GREEN}18`,
                border: `1px solid ${GREEN}35`,
                color: GREEN,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '0.72rem',
                fontWeight: 800,
                flexShrink: 0,
                fontFamily: 'monospace',
              }}
            >
              {step}
            </div>
            <div style={{ fontSize: '0.83rem', color: C.textMuted, lineHeight: 1.65, paddingTop: 2 }}>
              {text}
            </div>
          </div>
        ))}
      </div>

      <Callout accent={GREEN}>
        All features described in this guide are accessible from the left sidebar. Use <strong style={{ color: C.text }}>RCF</strong> to manage your numbers, <strong style={{ color: C.text }}>Call Quality</strong> to monitor performance, and <strong style={{ color: C.text }}>Troubleshooting</strong> for deep SIP diagnostics.
      </Callout>
    </AccordionSection>
  );
}

/* ─── Managing Your Numbers ──────────────────────────────── */

function ManagingNumbersSection() {
  return (
    <AccordionSection
      id="managing-numbers"
      accent={GREEN}
      icon={<Phone size={18} />}
      title="Managing Your Numbers"
      subtitle="View and understand your RCF number inventory — what each column means and how to find the number you need."
      defaultOpen
    >
      <P>
        The <strong style={{ color: C.text }}>RCF page</strong> (accessible from the sidebar) shows all of your Remote Call Forwarding numbers in one place. Each row represents a single phone number that is configured to forward calls to a destination of your choice.
      </P>

      <H3>Understanding the columns</H3>

      <div
        style={{
          borderRadius: 8,
          overflow: 'hidden',
          border: `1px solid ${C.borderSubtle}`,
          marginBottom: 20,
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.83rem' }}>
          <thead>
            <tr style={{ background: 'rgba(13,17,23,0.7)' }}>
              {['Column', 'What it means'].map(h => (
                <th
                  key={h}
                  style={{
                    padding: '10px 16px',
                    textAlign: 'left',
                    color: C.textFaint,
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    fontSize: '0.67rem',
                    textTransform: 'uppercase',
                    borderBottom: `1px solid ${C.borderSubtle}`,
                  }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              {
                col: 'DID',
                desc: 'Your inbound phone number — the number callers dial to reach you. Shown in E.164 format (e.g. +17745551234).',
              },
              {
                col: 'Name',
                desc: 'A friendly label you assign to help identify the number. For example: "Main Office Line" or "Boston Sales". This label is for your reference only.',
              },
              {
                col: 'Forward To',
                desc: 'The destination where calls to this DID are sent. This is the number or extension that actually rings when someone calls your DID.',
              },
              {
                col: 'Status',
                desc: 'Whether this number is currently forwarding calls. Green (enabled) means calls are being forwarded. Grey (disabled) means calls are not being forwarded.',
              },
              {
                col: 'Pass Caller ID',
                desc: "Whether the original caller's number is passed through to the forwarding destination. See the Caller ID Settings section below for a full explanation.",
              },
              {
                col: 'Ring Timeout',
                desc: 'How many seconds the forwarded call rings at the destination before giving up or redirecting to the failover number.',
              },
            ].map((row, i) => (
              <tr
                key={row.col}
                style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(13,17,23,0.25)' }}
              >
                <td style={{ padding: '10px 16px', borderBottom: `1px solid ${C.borderSubtle}`, whiteSpace: 'nowrap' }}>
                  <code style={{ color: '#79c0ff', fontFamily: 'monospace', fontSize: '0.82rem', fontWeight: 700 }}>
                    {row.col}
                  </code>
                </td>
                <td style={{ padding: '10px 16px', borderBottom: `1px solid ${C.borderSubtle}`, color: C.textMuted, lineHeight: 1.6 }}>
                  {row.desc}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <H3>Searching and filtering</H3>
      <P>
        Use the search bar at the top of the RCF page to filter numbers by DID, name, or forwarding destination. This is useful when you manage a large number of lines and need to locate a specific one quickly.
      </P>

      <Callout accent={GREEN}>
        Phone numbers in this portal use <strong style={{ color: C.text }}>E.164 format</strong> — the international standard for phone numbers. This means a leading plus sign followed by the country code and subscriber number with no spaces or dashes. For US numbers: <IC>+17745551234</IC>.
      </Callout>
    </AccordionSection>
  );
}

/* ─── Changing a Forwarding Destination ─────────────────── */

function ForwardingSection() {
  return (
    <AccordionSection
      id="forwarding"
      accent={GREEN}
      icon={<Phone size={18} />}
      title="Changing a Forwarding Destination"
      subtitle="How to update where calls to your RCF number are sent — changes take effect within seconds."
    >
      <P>
        You can change where any of your numbers forwards to directly from the RCF page. No support tickets required — changes take effect within seconds.
      </P>

      <H3>Step-by-step</H3>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
        {[
          {
            step: '1',
            title: 'Find your number',
            body: 'Locate the DID you want to update in the RCF page. Use the search bar to filter if you have many numbers.',
          },
          {
            step: '2',
            title: 'Click the pencil icon',
            body: 'In the Forward To column, click the pencil (edit) icon that appears when you hover over the row. The field will become an editable text input.',
          },
          {
            step: '3',
            title: 'Enter the new destination',
            body: 'Type the full phone number including country code. For US numbers, include +1 followed by the 10-digit number. Example: +17745551234. Do not include spaces or dashes.',
          },
          {
            step: '4',
            title: 'Save the change',
            body: 'Click Save (or press Enter). The new destination is applied immediately. Test the change by placing a call to your DID.',
          },
        ].map(({ step, title, body }) => (
          <div
            key={step}
            style={{
              display: 'flex',
              gap: 16,
              padding: '16px 18px',
              borderRadius: 10,
              background: 'rgba(13,17,23,0.45)',
              border: `1px solid ${C.borderSubtle}`,
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: '50%',
                background: `${GREEN}18`,
                border: `1px solid ${GREEN}35`,
                color: GREEN,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '0.78rem',
                fontWeight: 800,
                flexShrink: 0,
                fontFamily: 'monospace',
              }}
            >
              {step}
            </div>
            <div>
              <div style={{ fontSize: '0.86rem', fontWeight: 700, color: C.text, marginBottom: 4 }}>
                {title}
              </div>
              <div style={{ fontSize: '0.82rem', color: C.textMuted, lineHeight: 1.65 }}>
                {body}
              </div>
            </div>
          </div>
        ))}
      </div>

      <Callout accent={GREEN}>
        <strong style={{ color: C.text }}>Phone number format:</strong> Always enter the full number including country code, starting with a <IC>+</IC>. For US numbers: <IC>+1</IC> followed by area code and number. Example: <IC>+17745551234</IC>. If you omit the country code, the system may reject the number or route it incorrectly.
      </Callout>

      <H3>What happens after you save</H3>
      <P>
        The platform updates the forwarding configuration in real time. Within a few seconds, all new calls to your DID will be directed to the new destination. Calls already in progress are not affected — only new calls placed after the save will use the new forwarding target.
      </P>
    </AccordionSection>
  );
}

/* ─── Enabling and Disabling Numbers ────────────────────── */

function EnableDisableSection() {
  return (
    <AccordionSection
      id="enable-disable"
      accent={GREEN}
      icon={<ToggleLeft size={18} />}
      title="Enabling and Disabling Numbers"
      subtitle="Temporarily suspend or reactivate forwarding on any number with a single toggle — no waiting, no tickets."
    >
      <P>
        Every RCF number has an enabled/disabled toggle on its row. This is the fastest way to temporarily take a number out of service without deleting it or changing its forwarding configuration.
      </P>

      <NoteCards
        accent={GREEN}
        items={[
          {
            title: 'When a number is enabled',
            body: 'Calls arriving at that DID are forwarded normally to the configured destination. The toggle indicator is lit (active).',
          },
          {
            title: 'When a number is disabled',
            body: 'Calls to that DID are not forwarded. Callers typically receive a busy signal or a network announcement depending on your carrier treatment.',
          },
          {
            title: 'Re-enabling is instant',
            body: 'Turning a number back on takes effect within seconds. The forwarding destination and all other settings are preserved exactly as you left them.',
          },
          {
            title: 'Common use cases',
            body: 'Disable during scheduled maintenance windows, office closures, or when troubleshooting an issue. No configuration is lost when a number is disabled.',
          },
        ]}
      />

      <Callout accent={GREEN}>
        Disabling a number does <strong style={{ color: C.text }}>not</strong> delete it. All settings — forwarding destination, ring timeout, failover, and caller ID — are preserved and will resume exactly as configured when you re-enable it.
      </Callout>
    </AccordionSection>
  );
}

/* ─── Caller ID Settings ─────────────────────────────────── */

function CallerIdSection() {
  return (
    <AccordionSection
      id="caller-id"
      accent={GREEN}
      icon={<UserCheck size={18} />}
      title="Caller ID Settings"
      subtitle="Control what phone number appears on the destination's screen when a forwarded call arrives."
    >
      <P>
        When a call is forwarded through your RCF number, you can choose what the person at the destination sees as the incoming caller ID. This is configured per number using the <strong style={{ color: C.text }}>Pass Caller ID</strong> toggle.
      </P>

      <H3>Pass Caller ID — on vs off</H3>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
        <div
          style={{
            padding: '18px',
            borderRadius: 10,
            background: `${GREEN}08`,
            border: `1px solid ${GREEN}25`,
          }}
        >
          <div style={{ fontSize: '0.8rem', fontWeight: 700, color: GREEN, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <UserCheck size={14} />
            Pass Caller ID: ON
          </div>
          <div style={{ fontSize: '0.83rem', color: C.textMuted, lineHeight: 1.65 }}>
            The destination phone sees the <strong style={{ color: C.text }}>original caller's number</strong>. If a customer calls your main line from (774) 555-1234, the person at your forwarding destination sees (774) 555-1234.
          </div>
          <div style={{ marginTop: 10, fontSize: '0.78rem', color: C.textFaint }}>
            Best for: most general forwarding scenarios where you want transparency about who is calling.
          </div>
        </div>

        <div
          style={{
            padding: '18px',
            borderRadius: 10,
            background: 'rgba(13,17,23,0.45)',
            border: `1px solid ${C.borderSubtle}`,
          }}
        >
          <div style={{ fontSize: '0.8rem', fontWeight: 700, color: C.textMuted, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <PhoneOff size={14} />
            Pass Caller ID: OFF
          </div>
          <div style={{ fontSize: '0.83rem', color: C.textMuted, lineHeight: 1.65 }}>
            The destination phone sees <strong style={{ color: C.text }}>your RCF DID number</strong> as the caller ID. The original caller's number is masked. Useful when you want the destination to know which line was called.
          </div>
          <div style={{ marginTop: 10, fontSize: '0.78rem', color: C.textFaint }}>
            Best for: call tracking numbers, marketing campaigns, or when your agents need to see which DID was dialed.
          </div>
        </div>
      </div>

      <Callout accent={GREEN}>
        Caller ID pass-through is configured per number. You can have some numbers pass through the original caller ID and others display the RCF DID — it depends on your workflow and how your team handles incoming calls.
      </Callout>
    </AccordionSection>
  );
}

/* ─── Ring Timeout and Failover ──────────────────────────── */

function FailoverSection() {
  return (
    <AccordionSection
      id="failover"
      accent={GREEN}
      icon={<PhoneOff size={18} />}
      title="Ring Timeout and Failover"
      subtitle="Configure how long calls ring before giving up, and where they go if nobody answers."
    >
      <P>
        Two settings work together to make sure calls are never silently dropped: <strong style={{ color: C.text }}>Ring Timeout</strong> and <strong style={{ color: C.text }}>Failover To</strong>. Understanding how these work together helps ensure every caller reaches someone.
      </P>

      <H3>Ring Timeout</H3>
      <P>
        The ring timeout is how long the forwarded call rings at the destination before the platform gives up. The default is 30 seconds. You can configure this anywhere from 5 to 120 seconds.
      </P>
      <P>
        If your primary destination often takes time to answer — for example, a mobile number that always goes to voicemail after a delay — you may want to shorten the timeout so callers are transferred to your failover faster.
      </P>

      <H3>Failover Destination</H3>
      <P>
        The failover destination is a backup phone number that receives the call if the primary forwarding destination does not answer within the ring timeout.
      </P>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 0, marginBottom: 20 }}>
        {[
          {
            dot: GREEN,
            text: 'Caller dials your DID. The platform immediately forwards to your primary destination.',
            radius: { borderTopLeftRadius: 8, borderTopRightRadius: 8 },
            bg: 'rgba(13,17,23,0.55)',
            borderBottom: 'none',
          },
          {
            dot: C.textFaint,
            text: 'If the primary destination does not answer within the ring timeout (e.g. 30 seconds), the call is redirected.',
            radius: {},
            bg: 'rgba(13,17,23,0.45)',
            borderBottom: 'none',
          },
          {
            dot: GREEN,
            dotOpacity: 0.5,
            text: 'The call rings the failover destination. If no failover is set, the caller receives a standard busy or no-answer treatment.',
            radius: { borderBottomLeftRadius: 8, borderBottomRightRadius: 8 },
            bg: 'rgba(13,17,23,0.35)',
            borderBottom: undefined,
          },
        ].map(({ dot, dotOpacity, text, radius, bg, borderBottom }, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '14px 18px',
              background: bg,
              ...radius,
              border: `1px solid ${C.borderSubtle}`,
              borderBottom: borderBottom ?? `1px solid ${C.borderSubtle}`,
            }}
          >
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: dot, flexShrink: 0, opacity: dotOpacity }} />
            <div style={{ fontSize: '0.83rem', color: C.textMuted, lineHeight: 1.6 }}>
              {text}
            </div>
          </div>
        ))}
      </div>

      <Callout accent={GREEN}>
        Setting a failover destination is strongly recommended for any business-critical number. It ensures no call goes unanswered simply because one person or location is unavailable. Common failover destinations include a mobile number, a colleague's extension, or a general reception line.
      </Callout>

      <NoteCards
        accent={GREEN}
        items={[
          {
            title: 'No failover configured',
            body: 'When ring timeout expires and no failover is set, the caller receives the default platform treatment — typically a busy signal or a carrier-level no-answer announcement.',
          },
          {
            title: 'Failover configured',
            body: 'When ring timeout expires, the platform immediately dials the failover number. The caller experiences a seamless redirect with no re-dialing required on their part.',
          },
          {
            title: 'Ring timeout range',
            body: 'Valid values are 5 to 120 seconds. The default is 30 seconds. Setting it too short may redirect calls before the destination has time to answer.',
          },
          {
            title: 'Failover number format',
            body: 'The failover destination must be a valid phone number in E.164 format, just like the primary forwarding destination. Example: +18005551234.',
          },
        ]}
      />
    </AccordionSection>
  );
}

/* ─── Call Quality Monitoring ────────────────────────────── */

function CallQualitySection() {
  return (
    <AccordionSection
      id="call-quality"
      accent={GREEN}
      icon={<BarChart2 size={18} />}
      title="Call Quality Monitoring"
      subtitle="Understand your call quality metrics — what MOS, jitter, and packet loss mean and how to read them."
    >
      <P>
        The <strong style={{ color: C.text }}>Call Quality</strong> page (accessible from the sidebar) gives you a real-time and historical view of the quality of calls flowing through your RCF numbers. You can use this to spot trends, investigate complaints, and verify that a quality issue has been resolved.
      </P>

      <H3>Key metrics explained</H3>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
        {[
          {
            metric: 'MOS Score',
            range: '1 – 5 scale',
            what: 'Mean Opinion Score — the standard measure of perceived audio quality on a voice call. Think of it as a school grade: 5 is perfect, 4 is excellent, 3 is acceptable but noticeable degradation, below 3 is poor.',
            good: '4.0 or above is considered excellent. Most well-configured RCF calls score between 4.0 and 4.5.',
          },
          {
            metric: 'Jitter',
            range: 'milliseconds (ms)',
            what: 'Jitter measures how much the timing of audio packets varies as they travel across the network. High jitter causes the audio to sound choppy, robotic, or broken up.',
            good: 'Below 20ms is good. Above 50ms will typically cause audible audio issues.',
          },
          {
            metric: 'Packet Loss',
            range: 'percentage (%)',
            what: 'The percentage of audio packets that did not arrive at their destination. Even small amounts of packet loss can cause noticeable audio dropouts, clicks, or missing words.',
            good: 'Below 1% is acceptable. Above 3% will typically cause significant audio degradation.',
          },
          {
            metric: 'R-Factor',
            range: '0 – 100 scale',
            what: 'The R-Factor (also called E-Model score) is a composite quality score that accounts for delay, jitter, packet loss, and codec quality. It maps closely to MOS.',
            good: 'Above 80 is considered good. Above 90 is excellent. Below 70 indicates a noticeable quality problem.',
          },
        ].map(({ metric, range, what, good }) => (
          <div
            key={metric}
            style={{
              padding: '16px 18px',
              borderRadius: 10,
              background: 'rgba(13,17,23,0.45)',
              border: `1px solid ${C.borderSubtle}`,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
              <div style={{ fontSize: '0.88rem', fontWeight: 700, color: C.text }}>
                {metric}
              </div>
              <div style={{ fontSize: '0.72rem', color: C.textFaint, fontFamily: 'monospace' }}>
                {range}
              </div>
            </div>
            <div style={{ fontSize: '0.82rem', color: C.textMuted, lineHeight: 1.65, marginBottom: 8 }}>
              {what}
            </div>
            <div style={{ fontSize: '0.79rem', color: GREEN, lineHeight: 1.5 }}>
              Target: {good}
            </div>
          </div>
        ))}
      </div>

      <Callout accent={GREEN}>
        If you are seeing consistently low MOS scores or high packet loss on calls through a specific RCF number, the issue is most likely network-related between your forwarding destination and the carrier. Check with your network team or contact Granite support — the Call Quality page shows the data needed to diagnose it quickly.
      </Callout>
    </AccordionSection>
  );
}

/* ─── Troubleshooting ────────────────────────────────────── */

function TroubleshootingSection() {
  return (
    <AccordionSection
      id="troubleshooting"
      accent={GREEN}
      icon={<HelpCircle size={18} />}
      title="Troubleshooting"
      subtitle="Step-by-step guidance for the most common RCF issues, plus where to go for deeper diagnostics."
    >
      <P>
        Most issues with RCF numbers fall into a small number of categories. Start with the checklist below before escalating to support — many problems can be resolved in seconds directly from the portal.
      </P>

      <H3>Calls are not forwarding</H3>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
        {[
          {
            check: 'Is the number enabled?',
            action: 'Open the RCF page and confirm the toggle for that DID is active (lit). If it is disabled, enable it — forwarding will resume immediately.',
          },
          {
            check: 'Is the forwarding destination correct?',
            action: 'Check the Forward To column for that number. Confirm the number is in E.164 format with no typos. Click the pencil icon to correct it if needed.',
          },
          {
            check: 'Is the destination reachable?',
            action: 'Try calling the forwarding destination number directly from another phone. If that number is not reachable, the issue is at the destination — not with your RCF configuration.',
          },
        ].map(({ check, action }, i) => (
          <div
            key={i}
            style={{
              padding: '14px 16px',
              borderRadius: 8,
              background: 'rgba(13,17,23,0.45)',
              border: `1px solid ${C.borderSubtle}`,
            }}
          >
            <div style={{ fontSize: '0.83rem', fontWeight: 700, color: C.text, marginBottom: 4 }}>
              {check}
            </div>
            <div style={{ fontSize: '0.81rem', color: C.textMuted, lineHeight: 1.6 }}>
              {action}
            </div>
          </div>
        ))}
      </div>

      <H3>One-way audio on calls</H3>
      <P>
        One-way audio (where one party can hear the other but not vice versa) is almost always a network or firewall issue, not a configuration issue in the portal. Here is how to diagnose it:
      </P>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
        {[
          {
            check: 'Check Call Quality metrics',
            action: 'Open the Call Quality page and look at packet loss and jitter for recent calls on that number. High packet loss in one direction strongly indicates a firewall or NAT issue between your network and the carrier.',
          },
          {
            check: 'Check for SIP signaling issues',
            action: 'Open the Troubleshooting page (Homer SIP capture) to inspect the SIP dialog for the affected call. Look for mismatched SDP media addresses or missing RTP streams.',
          },
        ].map(({ check, action }, i) => (
          <div
            key={i}
            style={{
              padding: '14px 16px',
              borderRadius: 8,
              background: 'rgba(13,17,23,0.45)',
              border: `1px solid ${C.borderSubtle}`,
            }}
          >
            <div style={{ fontSize: '0.83rem', fontWeight: 700, color: C.text, marginBottom: 4 }}>
              {check}
            </div>
            <div style={{ fontSize: '0.81rem', color: C.textMuted, lineHeight: 1.6 }}>
              {action}
            </div>
          </div>
        ))}
      </div>

      <H3>Using the Troubleshooting page (Homer)</H3>
      <P>
        The <strong style={{ color: C.text }}>Troubleshooting</strong> page in the sidebar opens the Homer SIP capture tool. Homer provides packet-level visibility into every SIP message exchanged during a call. It is intended for advanced users or network engineers investigating signaling-level issues such as:
      </P>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 20 }}>
        {[
          'Calls connecting but immediately dropping',
          'Registration failures',
          'Calls not being delivered to the correct destination',
          'Codec negotiation issues causing audio problems',
          'Unusual SIP error codes (e.g. 503, 487, 486)',
          'Latency or delay troubleshooting at the SIP layer',
        ].map((item, i) => (
          <div
            key={i}
            style={{
              padding: '10px 14px',
              borderRadius: 7,
              background: 'rgba(13,17,23,0.45)',
              border: `1px solid ${C.borderSubtle}`,
              fontSize: '0.81rem',
              color: C.textMuted,
              lineHeight: 1.5,
            }}
          >
            {item}
          </div>
        ))}
      </div>

      <NoteCards
        accent={C.amber}
        items={[
          {
            title: 'Still not working?',
            body: 'If you have checked the above and calls are still not forwarding correctly, contact Granite support at solutions@granitenet.com. Include the affected DID, the approximate time of the failed call, and any error information visible in the Call Quality or Troubleshooting pages.',
          },
          {
            title: 'Tip: note the timestamps',
            body: 'When reporting an issue to support, note the exact time (with timezone) of a failed call. This lets the Granite team locate the call record and SIP trace quickly, which dramatically speeds up resolution.',
          },
        ]}
      />
    </AccordionSection>
  );
}

/* ─── Page root ──────────────────────────────────────────── */

export function RcfDocsPage() {
  return (
    <div style={{ paddingTop: 20 }}>
      <PageHeaderCard
        eyebrow="Customer Guide"
        title="Granite Keystone RCF User Guide"
        subtitle="Everything you need to manage your Remote Call Forwarding numbers from the Granite Keystone portal"
        accent={GREEN}
      />

      <div style={{ padding: '0 0 60px' }}>
        <div style={{ maxWidth: 1080, margin: '0 auto' }}>
          <GettingStartedSection />
          <ManagingNumbersSection />
          <ForwardingSection />
          <EnableDisableSection />
          <CallerIdSection />
          <FailoverSection />
          <CallQualitySection />
          <TroubleshootingSection />
        </div>
      </div>
    </div>
  );
}

