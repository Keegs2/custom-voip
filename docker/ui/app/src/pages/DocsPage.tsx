import { useState } from 'react';
import {
  ChevronDown,
  Phone,
  ToggleLeft,
  UserCheck,
  PhoneOff,
  BarChart2,
  HelpCircle,
  Info,
  LogIn,
  Key,
  Code,
  Database,
  Server,
} from 'lucide-react';

/* ─── Design tokens ──────────────────────────────────────── */

const C = {
  bg: '#13151d',
  surface: '#1a1d27',
  surfaceAlt: '#1e2130',
  border: 'rgba(42,47,69,0.6)',
  borderSubtle: 'rgba(42,47,69,0.35)',
  text: '#e2e8f0',
  textMuted: '#94a3b8',
  textFaint: '#4a5568',
  accent: '#3b82f6',
  amber: '#f59e0b',
  red: '#ef4444',
};

/* ─── Shared sub-components ──────────────────────────────── */

function P({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ margin: '0 0 14px', fontSize: '0.875rem', color: C.textMuted, lineHeight: 1.75 }}>
      {children}
    </p>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{
        margin: '28px 0 10px',
        fontSize: '0.72rem',
        fontWeight: 700,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: C.textFaint,
      }}
    >
      {children}
    </h3>
  );
}

function IC({ children }: { children: React.ReactNode }) {
  return (
    <code
      style={{
        background: 'rgba(13,17,23,0.7)',
        border: `1px solid ${C.borderSubtle}`,
        borderRadius: 4,
        padding: '1px 6px',
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: '0.78rem',
        color: '#79c0ff',
      }}
    >
      {children}
    </code>
  );
}

/* ─── Callout box ────────────────────────────────────────── */

function Callout({
  accent,
  children,
}: {
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: '14px 18px',
        borderRadius: 8,
        background: `${accent}0a`,
        border: `1px solid ${accent}25`,
        marginBottom: 16,
        fontSize: '0.84rem',
        color: C.textMuted,
        lineHeight: 1.65,
      }}
    >
      <div style={{ color: accent, flexShrink: 0, marginTop: 1 }}>
        <Info size={14} />
      </div>
      <div>{children}</div>
    </div>
  );
}

/* ─── Collapsible accordion section ─────────────────────── */

interface AccordionSectionProps {
  id: string;
  accent: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

function AccordionSection({
  accent,
  icon,
  title,
  subtitle,
  children,
  defaultOpen = false,
}: AccordionSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div
      style={{
        border: `1px solid ${open ? accent + '40' : C.border}`,
        borderRadius: 14,
        overflow: 'hidden',
        marginBottom: 20,
        transition: 'border-color 0.2s',
        background: `linear-gradient(135deg, ${C.surface} 0%, ${C.surfaceAlt} 100%)`,
      }}
    >
      {/* Header bar */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '20px 28px',
          background: open
            ? `linear-gradient(90deg, ${accent}0d 0%, transparent 60%)`
            : 'transparent',
          border: 'none',
          borderBottom: open ? `1px solid ${accent}25` : '1px solid transparent',
          cursor: 'pointer',
          textAlign: 'left',
          transition: 'background 0.2s',
        }}
      >
        {/* Icon badge */}
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: `linear-gradient(135deg, ${accent}20 0%, ${accent}08 100%)`,
            border: `1px solid ${accent}35`,
            color: accent,
            flexShrink: 0,
          }}
        >
          {icon}
        </div>

        {/* Title + subtitle */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: '1.05rem',
              fontWeight: 700,
              color: C.text,
              letterSpacing: '-0.01em',
              marginBottom: 2,
            }}
          >
            {title}
          </div>
          <div style={{ fontSize: '0.82rem', color: C.textMuted, lineHeight: 1.4 }}>
            {subtitle}
          </div>
        </div>

        {/* Chevron */}
        <div
          style={{
            color: accent,
            flexShrink: 0,
            transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 0.2s',
          }}
        >
          <ChevronDown size={20} />
        </div>
      </button>

      {/* Collapsible body */}
      {open && (
        <div style={{ padding: '28px 32px' }}>
          {children}
        </div>
      )}
    </div>
  );
}

/* ─── Behavior note card grid ────────────────────────────── */

function NoteCards({ accent, items }: { accent: string; items: { title: string; body: string }[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 4 }}>
      {items.map(({ title, body }) => (
        <div
          key={title}
          style={{
            padding: '14px 16px',
            borderRadius: 8,
            background: `${accent}07`,
            border: `1px solid ${accent}20`,
          }}
        >
          <div style={{ fontSize: '0.78rem', fontWeight: 700, color: accent, marginBottom: 6 }}>
            {title}
          </div>
          <div style={{ fontSize: '0.81rem', color: C.textMuted, lineHeight: 1.6 }}>
            {body}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─── Getting Started section ────────────────────────────── */

function GettingStartedSection() {
  return (
    <div
      style={{
        background: `linear-gradient(135deg, ${C.surface} 0%, ${C.surfaceAlt} 100%)`,
        border: `1px solid ${C.border}`,
        borderRadius: 14,
        overflow: 'hidden',
        marginBottom: 28,
      }}
    >
      {/* Top accent line */}
      <div
        style={{
          height: 2,
          background: `linear-gradient(90deg, transparent, ${C.accent}, transparent)`,
          opacity: 0.5,
        }}
      />

      <div style={{ padding: '28px 32px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: `linear-gradient(135deg, ${C.accent}20 0%, ${C.accent}08 100%)`,
              border: `1px solid ${C.accent}30`,
              color: C.accent,
              flexShrink: 0,
            }}
          >
            <LogIn size={18} />
          </div>
          <div>
            <h2
              style={{
                fontSize: '1rem',
                fontWeight: 700,
                color: C.text,
                margin: 0,
                letterSpacing: '-0.01em',
              }}
            >
              Getting Started
            </h2>
            <p style={{ margin: 0, fontSize: '0.8rem', color: C.textMuted }}>
              Logging in and navigating the Granite Keystone portal
            </p>
          </div>
        </div>

        <P>
          The Granite Keystone portal is your self-service hub for managing Remote Call Forwarding (RCF) numbers. Everything you need — number management, call quality monitoring, and troubleshooting tools — is accessible directly from the sidebar.
        </P>

        <H3>Logging in</H3>
        <P>
          Navigate to your portal URL and sign in with the email address and password provided by your Granite account team. If you have forgotten your password, contact your administrator or Granite support to have your credentials reset.
        </P>

        <H3>What you can do in this portal</H3>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 20 }}>
          {[
            {
              icon: <Phone size={16} />,
              title: 'Manage Numbers',
              body: 'View all your RCF numbers, change forwarding destinations, and enable or disable individual numbers in real time.',
            },
            {
              icon: <BarChart2 size={16} />,
              title: 'Monitor Call Quality',
              body: 'Track MOS scores, jitter, and packet loss for your calls. Identify quality issues before they impact your business.',
            },
            {
              icon: <HelpCircle size={16} />,
              title: 'Troubleshoot Issues',
              body: 'Access the built-in SIP capture tool (Homer) to inspect call signaling in detail if calls are not connecting as expected.',
            },
          ].map(({ icon, title, body }) => (
            <div
              key={title}
              style={{
                padding: '16px',
                borderRadius: 10,
                background: `${C.accent}08`,
                border: `1px solid ${C.accent}20`,
              }}
            >
              <div style={{ color: C.accent, marginBottom: 8 }}>{icon}</div>
              <div style={{ fontSize: '0.85rem', fontWeight: 700, color: C.text, marginBottom: 6 }}>
                {title}
              </div>
              <div style={{ fontSize: '0.81rem', color: C.textMuted, lineHeight: 1.6 }}>
                {body}
              </div>
            </div>
          ))}
        </div>

        <Callout accent={C.accent}>
          All the features described in this guide are accessible from the left sidebar. Use the <strong style={{ color: C.text }}>RCF</strong> page to manage your numbers, <strong style={{ color: C.text }}>Call Quality</strong> to monitor performance, and <strong style={{ color: C.text }}>Troubleshooting</strong> for deep SIP diagnostics.
        </Callout>
      </div>
    </div>
  );
}

/* ─── Section: Managing Your Numbers ─────────────────────── */

function ManagingNumbersSection() {
  return (
    <AccordionSection
      id="managing-numbers"
      accent={C.accent}
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
                desc: 'Whether the original caller\'s number is passed through to the forwarding destination. See the Caller ID Settings section below for a full explanation.',
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

      <Callout accent={C.accent}>
        Phone numbers in this portal use <strong style={{ color: C.text }}>E.164 format</strong> — the international standard for phone numbers. This means a leading plus sign followed by the country code and subscriber number with no spaces or dashes. For US numbers: <IC>+17745551234</IC>.
      </Callout>
    </AccordionSection>
  );
}

/* ─── Section: Changing a Forwarding Destination ─────────── */

function ForwardingSection() {
  return (
    <AccordionSection
      id="forwarding"
      accent={C.accent}
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
                background: `${C.accent}18`,
                border: `1px solid ${C.accent}35`,
                color: C.accent,
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

      <Callout accent={C.accent}>
        <strong style={{ color: C.text }}>Phone number format:</strong> Always enter the full number including country code, starting with a <IC>+</IC>. For US numbers: <IC>+1</IC> followed by area code and number. Example: <IC>+17745551234</IC>. If you omit the country code, the system may reject the number or route it incorrectly.
      </Callout>

      <H3>What happens after you save</H3>
      <P>
        The platform updates the forwarding configuration in real time. Within a few seconds, all new calls to your DID will be directed to the new destination. Calls already in progress are not affected — only new calls placed after the save will use the new forwarding target.
      </P>
    </AccordionSection>
  );
}

/* ─── Section: Enabling and Disabling Numbers ────────────── */

function EnableDisableSection() {
  return (
    <AccordionSection
      id="enable-disable"
      accent={C.accent}
      icon={<ToggleLeft size={18} />}
      title="Enabling and Disabling Numbers"
      subtitle="Temporarily suspend or reactivate forwarding on any number with a single toggle — no waiting, no tickets."
    >
      <P>
        Every RCF number has an enabled/disabled toggle on its row. This is the fastest way to temporarily take a number out of service without deleting it or changing its forwarding configuration.
      </P>

      <NoteCards
        accent={C.accent}
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

      <Callout accent={C.accent}>
        Disabling a number does <strong style={{ color: C.text }}>not</strong> delete it. All settings — forwarding destination, ring timeout, failover, and caller ID — are preserved and will resume exactly as configured when you re-enable it.
      </Callout>
    </AccordionSection>
  );
}

/* ─── Section: Caller ID Settings ───────────────────────── */

function CallerIdSection() {
  return (
    <AccordionSection
      id="caller-id"
      accent={C.accent}
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
            background: `${C.accent}08`,
            border: `1px solid ${C.accent}25`,
          }}
        >
          <div style={{ fontSize: '0.8rem', fontWeight: 700, color: C.accent, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
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

      <Callout accent={C.accent}>
        Caller ID pass-through is configured per number. You can have some numbers pass through the original caller ID and others display the RCF DID — it depends on your workflow and how your team handles incoming calls.
      </Callout>
    </AccordionSection>
  );
}

/* ─── Section: Ring Timeout and Failover ─────────────────── */

function FailoverSection() {
  return (
    <AccordionSection
      id="failover"
      accent={C.accent}
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
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '14px 18px',
            background: 'rgba(13,17,23,0.55)',
            borderTopLeftRadius: 8,
            borderTopRightRadius: 8,
            border: `1px solid ${C.borderSubtle}`,
            borderBottom: 'none',
          }}
        >
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: C.accent, flexShrink: 0 }} />
          <div style={{ fontSize: '0.83rem', color: C.textMuted, lineHeight: 1.6 }}>
            Caller dials your DID. The platform immediately forwards to your primary destination.
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '14px 18px',
            background: 'rgba(13,17,23,0.45)',
            border: `1px solid ${C.borderSubtle}`,
            borderBottom: 'none',
          }}
        >
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: C.textFaint, flexShrink: 0 }} />
          <div style={{ fontSize: '0.83rem', color: C.textMuted, lineHeight: 1.6 }}>
            If the primary destination does not answer within the ring timeout (e.g. 30 seconds), the call is redirected.
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '14px 18px',
            background: 'rgba(13,17,23,0.35)',
            borderBottomLeftRadius: 8,
            borderBottomRightRadius: 8,
            border: `1px solid ${C.borderSubtle}`,
          }}
        >
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: C.accent, flexShrink: 0, opacity: 0.5 }} />
          <div style={{ fontSize: '0.83rem', color: C.textMuted, lineHeight: 1.6 }}>
            The call rings the failover destination. If no failover is set, the caller receives a standard busy or no-answer treatment.
          </div>
        </div>
      </div>

      <Callout accent={C.accent}>
        Setting a failover destination is strongly recommended for any business-critical number. It ensures no call goes unanswered simply because one person or location is unavailable. Common failover destinations include a mobile number, a colleague's extension, or a general reception line.
      </Callout>

      <NoteCards
        accent={C.accent}
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

/* ─── Section: Call Quality Monitoring ──────────────────── */

function CallQualitySection() {
  return (
    <AccordionSection
      id="call-quality"
      accent={C.accent}
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
            color: C.accent,
            what: 'Mean Opinion Score — the standard measure of perceived audio quality on a voice call. Think of it as a school grade: 5 is perfect, 4 is excellent, 3 is acceptable but noticeable degradation, below 3 is poor.',
            good: '4.0 or above is considered excellent. Most well-configured RCF calls score between 4.0 and 4.5.',
          },
          {
            metric: 'Jitter',
            range: 'milliseconds (ms)',
            color: C.accent,
            what: 'Jitter measures how much the timing of audio packets varies as they travel across the network. High jitter causes the audio to sound choppy, robotic, or broken up.',
            good: 'Below 20ms is good. Above 50ms will typically cause audible audio issues.',
          },
          {
            metric: 'Packet Loss',
            range: 'percentage (%)',
            color: C.accent,
            what: 'The percentage of audio packets that did not arrive at their destination. Even small amounts of packet loss can cause noticeable audio dropouts, clicks, or missing words.',
            good: 'Below 1% is acceptable. Above 3% will typically cause significant audio degradation.',
          },
          {
            metric: 'R-Factor',
            range: '0 – 100 scale',
            color: C.accent,
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
            <div style={{ fontSize: '0.79rem', color: C.accent, lineHeight: 1.5 }}>
              Target: {good}
            </div>
          </div>
        ))}
      </div>

      <Callout accent={C.accent}>
        If you are seeing consistently low MOS scores or high packet loss on calls through a specific RCF number, the issue is most likely network-related between your forwarding destination and the carrier. Check with your network team or contact Granite support — the Call Quality page shows the data needed to diagnose it quickly.
      </Callout>
    </AccordionSection>
  );
}

/* ─── Section: Troubleshooting ───────────────────────────── */

function TroubleshootingSection() {
  return (
    <AccordionSection
      id="troubleshooting"
      accent={C.accent}
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
            body: 'If you have checked the above and calls are still not forwarding correctly, contact Granite support. Include the affected DID, the approximate time of the failed call, and any error information you can see in the Call Quality or Troubleshooting pages.',
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

/* ─── API Reference: shared sub-components ──────────────── */

/** Syntax-highlighted code block with blue accent palette. */
function CodeBlock({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  // Tokenise for blue-accent syntax colouring:
  // strings → #93c5fd (light blue), keys/paths → #60a5fa, booleans/numbers → #818cf8, comments → #475569
  const lines = code.split('\n');

  return (
    <div
      style={{
        borderRadius: 10,
        overflow: 'hidden',
        border: `1px solid rgba(59,130,246,0.2)`,
        marginBottom: 16,
      }}
    >
      {/* Top bar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '8px 16px',
          background: 'rgba(59,130,246,0.06)',
          borderBottom: '1px solid rgba(59,130,246,0.15)',
        }}
      >
        <span
          style={{
            fontSize: '0.7rem',
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: '#60a5fa',
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          }}
        >
          {label ?? 'code'}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: '0.7rem',
            color: copied ? '#4ade80' : '#475569',
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            padding: '2px 6px',
            borderRadius: 4,
            transition: 'color 0.2s',
          }}
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>

      {/* Code body */}
      <div
        style={{
          background: 'rgba(10,13,22,0.85)',
          padding: '16px 20px',
          overflowX: 'auto',
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          fontSize: '0.78rem',
          lineHeight: 1.75,
        }}
      >
        {lines.map((raw, idx) => (
          <CodeLine key={idx} raw={raw} />
        ))}
      </div>
    </div>
  );
}

/**
 * Renders a single code line with simple blue-palette token colouring.
 * Covers the patterns that appear in curl/JSON examples without a full parser.
 */
function CodeLine({ raw }: { raw: string }) {
  // Comment lines
  if (/^\s*#/.test(raw)) {
    return (
      <div>
        <span style={{ color: '#334155' }}>{raw}</span>
      </div>
    );
  }

  // Tokenise by splitting on JSON string literals, numbers, booleans, and
  // shell keywords so we can colour each segment differently.
  const tokens: Array<{ text: string; color: string }> = [];
  let remaining = raw;

  // Regex groups in order of precedence:
  //   1. JSON key:  "someKey":
  //   2. JSON string value:  "someValue"
  //   3. Bareword keywords: true, false, null, curl, -X, --header, --data
  //   4. Numbers (optionally in JSON context)
  //   5. Everything else
  const TOKEN_RE = /("[\w\s:+@./\\-]*"\s*:)|("(?:[^"\\]|\\.)*")|(\b(?:true|false|null)\b)|(\b\d+(?:\.\d+)?\b)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(remaining)) !== null) {
    // Plain text before this match
    if (match.index > lastIndex) {
      tokens.push({ text: remaining.slice(lastIndex, match.index), color: '#94a3b8' });
    }

    if (match[1]) {
      // JSON key — lighter blue
      tokens.push({ text: match[1], color: '#60a5fa' });
    } else if (match[2]) {
      // String value — pale blue
      tokens.push({ text: match[2], color: '#93c5fd' });
    } else if (match[3]) {
      // boolean / null — indigo
      tokens.push({ text: match[3], color: '#818cf8' });
    } else if (match[4]) {
      // number — sky
      tokens.push({ text: match[4], color: '#38bdf8' });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < remaining.length) {
    tokens.push({ text: remaining.slice(lastIndex), color: '#94a3b8' });
  }

  if (tokens.length === 0) {
    return <div><span style={{ color: '#94a3b8' }}>{raw || '\u00A0'}</span></div>;
  }

  return (
    <div>
      {tokens.map((t, i) => (
        <span key={i} style={{ color: t.color }}>{t.text}</span>
      ))}
    </div>
  );
}

/** HTTP method badge + path + description row. */
function Endpoint({
  method,
  path,
  description,
}: {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  description: string;
}) {
  const methodColors: Record<string, { bg: string; text: string }> = {
    GET:    { bg: 'rgba(59,130,246,0.15)',  text: '#60a5fa' },
    POST:   { bg: 'rgba(34,197,94,0.12)',   text: '#4ade80' },
    PUT:    { bg: 'rgba(245,158,11,0.12)',   text: '#fbbf24' },
    DELETE: { bg: 'rgba(239,68,68,0.12)',    text: '#f87171' },
    PATCH:  { bg: 'rgba(168,85,247,0.12)',   text: '#c084fc' },
  };
  const mc = methodColors[method] ?? methodColors.GET;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 16px',
        borderRadius: 8,
        background: 'rgba(10,13,22,0.55)',
        border: `1px solid rgba(59,130,246,0.18)`,
        marginBottom: 12,
      }}
    >
      <span
        style={{
          display: 'inline-block',
          padding: '3px 9px',
          borderRadius: 5,
          background: mc.bg,
          color: mc.text,
          fontSize: '0.68rem',
          fontWeight: 800,
          letterSpacing: '0.08em',
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          flexShrink: 0,
        }}
      >
        {method}
      </span>
      <code
        style={{
          color: '#93c5fd',
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          fontSize: '0.82rem',
          flexShrink: 0,
        }}
      >
        {path}
      </code>
      <span style={{ color: C.textMuted, fontSize: '0.81rem', lineHeight: 1.4 }}>
        {description}
      </span>
    </div>
  );
}

/** Parameter reference table. */
interface Param {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

function ParamTable({ params }: { params: Param[] }) {
  return (
    <div
      style={{
        borderRadius: 8,
        overflow: 'hidden',
        border: `1px solid rgba(59,130,246,0.18)`,
        marginBottom: 20,
      }}
    >
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
        <thead>
          <tr style={{ background: 'rgba(10,13,22,0.7)' }}>
            {['Parameter', 'Type', 'Required', 'Description'].map(h => (
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
          {params.map((p, i) => (
            <tr key={p.name} style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(10,13,22,0.28)' }}>
              <td style={{ padding: '9px 14px', borderBottom: '1px solid rgba(42,47,69,0.3)', whiteSpace: 'nowrap' }}>
                <code style={{ color: '#60a5fa', fontFamily: 'monospace', fontSize: '0.8rem', fontWeight: 700 }}>
                  {p.name}
                </code>
              </td>
              <td style={{ padding: '9px 14px', borderBottom: '1px solid rgba(42,47,69,0.3)', whiteSpace: 'nowrap' }}>
                <code style={{ color: '#818cf8', fontFamily: 'monospace', fontSize: '0.78rem' }}>
                  {p.type}
                </code>
              </td>
              <td style={{ padding: '9px 14px', borderBottom: '1px solid rgba(42,47,69,0.3)', whiteSpace: 'nowrap' }}>
                <span
                  style={{
                    display: 'inline-block',
                    padding: '2px 7px',
                    borderRadius: 4,
                    fontSize: '0.67rem',
                    fontWeight: 700,
                    letterSpacing: '0.05em',
                    background: p.required ? 'rgba(59,130,246,0.12)' : 'rgba(71,85,105,0.2)',
                    color: p.required ? '#60a5fa' : '#475569',
                  }}
                >
                  {p.required ? 'required' : 'optional'}
                </span>
              </td>
              <td style={{ padding: '9px 14px', borderBottom: '1px solid rgba(42,47,69,0.3)', color: C.textMuted, lineHeight: 1.55 }}>
                {p.description}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Side-by-side (or stacked on narrow) request + response code blocks. */
function ReqRes({ request, response }: { request: string; response: string }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 12,
        marginBottom: 20,
      }}
    >
      <CodeBlock code={request} label="request" />
      <CodeBlock code={response} label="response" />
    </div>
  );
}

/* ─── API Reference: Section 1 — Authentication ─────────── */

function ApiAuthSection() {
  return (
    <AccordionSection
      id="api-auth"
      accent={C.accent}
      icon={<Key size={18} />}
      title="API Reference — Authentication"
      subtitle="Obtain a JWT token and authenticate every API request with a Bearer header."
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

      <Callout accent={C.accent}>
        All API endpoints below require a valid Bearer token. A request without a token, or with an
        expired token, returns <IC>401 Unauthorized</IC>. A token belonging to a user who does not
        have access to the requested resource returns <IC>403 Forbidden</IC>.
      </Callout>
    </AccordionSection>
  );
}

/* ─── API Reference: Section 2 — RCF Endpoints ──────────── */

function ApiRcfSection() {
  return (
    <AccordionSection
      id="api-rcf"
      accent={C.accent}
      icon={<Code size={18} />}
      title="API Reference — RCF Endpoints"
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

      <Callout accent={C.accent}>
        URL-encode the <IC>+</IC> sign in E.164 numbers when placing them in URL path segments.
        Replace <IC>+</IC> with <IC>%2B</IC>. For example, <IC>+17745551234</IC> becomes
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

/* ─── API Reference: Section 3 — CDR / Usage ────────────── */

function ApiCdrSection() {
  return (
    <AccordionSection
      id="api-cdrs"
      accent={C.accent}
      icon={<Database size={18} />}
      title="API Reference — CDR / Usage"
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
        accent={C.accent}
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

      <Callout accent={C.accent}>
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
        <Server size={16} style={{ color: C.accent, flexShrink: 0 }} />
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

export function DocsPage() {
  return (
    <div style={{ paddingTop: 20 }}>

      {/* Glass-morphism page header — matches RcfPageHeader style */}
      <div
        className="animate-fade-in-up"
        style={{
          position: 'relative',
          background: 'rgba(19, 21, 29, 0.72)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          border: '1px solid rgba(59,130,246,0.16)',
          borderRadius: 20,
          padding: '32px 36px 28px',
          marginBottom: 28,
          overflow: 'hidden',
          boxShadow: '0 8px 40px -12px rgba(0,0,0,0.55), 0 0 0 1px rgba(59,130,246,0.06)',
        }}
      >
        {/* Top accent line */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 48,
            right: 48,
            height: 2,
            background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.7), transparent)',
            borderRadius: '0 0 2px 2px',
          }}
        />

        {/* Subtle radial glow background */}
        <div
          style={{
            position: 'absolute',
            top: -60,
            right: -60,
            width: 280,
            height: 280,
            background: 'radial-gradient(circle, rgba(59,130,246,0.07) 0%, transparent 70%)',
            pointerEvents: 'none',
          }}
        />

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 24 }}>
          {/* Keystone logo with glow */}
          <div style={{ flexShrink: 0, position: 'relative' }}>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: 14,
                background: 'linear-gradient(135deg, rgba(59,130,246,0.18) 0%, rgba(59,130,246,0.08) 100%)',
                border: '1px solid rgba(59,130,246,0.28)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 0 24px rgba(59,130,246,0.20)',
              }}
            >
              <img
                src="/keystone_logo.png"
                alt="Keystone"
                style={{
                  width: 36,
                  height: 36,
                  objectFit: 'contain',
                  filter: 'drop-shadow(0 0 8px rgba(59,130,246,0.55)) brightness(1.1)',
                }}
              />
            </div>
          </div>

          {/* Title + subtitle */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: '0.6rem',
                fontWeight: 700,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: '#3b82f6',
                opacity: 0.8,
                marginBottom: 6,
              }}
            >
              API Documentation
            </div>
            <h1
              style={{
                fontSize: 'clamp(1.2rem, 2.5vw, 1.55rem)',
                fontWeight: 800,
                color: '#e2e8f0',
                letterSpacing: '-0.025em',
                lineHeight: 1.15,
                margin: '0 0 8px',
              }}
            >
              Remote Call Forwarding — Customer Guide
            </h1>
            <p
              style={{
                fontSize: '0.85rem',
                color: '#718096',
                lineHeight: 1.65,
                margin: 0,
                maxWidth: 500,
              }}
            >
              A complete reference for managing your RCF numbers, understanding your call quality metrics, and troubleshooting issues — all from the Granite Keystone portal.
            </p>
          </div>
        </div>
      </div>

      <div
        style={{
          padding: '0 0 60px',
        }}
      >
        <div style={{ maxWidth: 1080, margin: '0 auto' }}>

          {/* Always-visible getting started section */}
          <GettingStartedSection />

          {/* Collapsible guide sections */}
          <ManagingNumbersSection />
          <ForwardingSection />
          <EnableDisableSection />
          <CallerIdSection />
          <FailoverSection />
          <CallQualitySection />
          <TroubleshootingSection />

          {/* Developer API reference */}
          <div style={{ margin: '36px 0 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <Server size={16} style={{ color: C.accent }} />
              <span
                style={{
                  fontSize: '0.68rem',
                  fontWeight: 800,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: C.accent,
                }}
              >
                Developer API
              </span>
            </div>
            <h2
              style={{
                margin: '0 0 6px',
                fontSize: '1.25rem',
                fontWeight: 800,
                color: C.text,
                letterSpacing: '-0.02em',
              }}
            >
              API Reference
            </h2>
            <p style={{ margin: 0, fontSize: '0.86rem', color: C.textMuted, lineHeight: 1.6 }}>
              Interact with your RCF numbers programmatically using the REST API.
              All endpoints use JSON and require a Bearer token obtained from the login endpoint.
            </p>
          </div>

          <ApiAuthSection />
          <ApiRcfSection />
          <ApiCdrSection />

        </div>
      </div>
    </div>
  );
}
