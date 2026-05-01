/**
 * RCF User Guide — concise customer-facing documentation for Granite Keystone RCF.
 */

import { Phone, HelpCircle, LogIn } from 'lucide-react';

import {
  C,
  P,
  H3,
  IC,
  Callout,
  AccordionSection,
  PageHeaderCard,
} from './shared';

const GREEN = '#4ade80';

/* ─── Getting Started ────────────────────────────────────── */

function GettingStartedSection() {
  return (
    <AccordionSection
      id="getting-started"
      accent={GREEN}
      icon={<LogIn size={18} />}
      title="Getting Started"
      subtitle="Log in and verify your numbers are working."
    >
      <P>
        Your administrator provides your login credentials. Navigate to your portal URL, sign in, and open the <strong style={{ color: C.text }}>RCF</strong> page from the sidebar. Confirm your numbers are listed, enabled, and forwarding to the correct destinations. Place a test call to verify.
      </P>
      <Callout accent={GREEN}>
        If you need your password reset, contact your administrator or email <strong style={{ color: C.text }}>solutions@granitenet.com</strong>.
      </Callout>
    </AccordionSection>
  );
}

/* ─── Managing Your RCF ─────────────────────────────────── */

function ManagingRcfSection() {
  return (
    <AccordionSection
      id="managing-rcf"
      accent={GREEN}
      icon={<Phone size={18} />}
      title="Managing Your RCF"
      subtitle="Everything you can do with your forwarding numbers — all from the RCF page."
    >
      <P>
        The RCF page shows all of your numbers. Each card displays the DID, where it forwards to, and its current settings. All changes take effect within seconds — no support tickets required.
      </P>

      <H3>Change a forwarding destination</H3>
      <P>
        Click the green forwarding number on any card. Type the new destination in E.164 format (<IC>+17745551234</IC>) and click <strong style={{ color: C.text }}>Save</strong>. New calls immediately route to the updated number. Calls already in progress are not affected.
      </P>

      <H3>Enable or disable a number</H3>
      <P>
        Use the toggle in the top-right corner of each card. Disabled numbers stop forwarding but keep all settings intact. Re-enable anytime — forwarding resumes instantly.
      </P>

      <H3>Set a name / label</H3>
      <P>
        Click the label text above the DID (e.g. "Name this line — click to edit") to assign a friendly name like "Main Office" or "Boston Sales". This is for your reference only.
      </P>

      <H3>Caller ID pass-through</H3>
      <P>
        The <strong style={{ color: C.text }}>Caller ID</strong> setting at the bottom of each card controls what the destination sees. <strong style={{ color: C.text }}>Pass-thru</strong> shows the original caller's number. <strong style={{ color: C.text }}>Show DID</strong> shows your RCF number instead. Click the pill to toggle.
      </P>

      <H3>Ring timeout</H3>
      <P>
        How long the call rings at the destination before giving up (default 30 seconds, range 5–120s). If a failover number is configured, unanswered calls redirect there automatically.
      </P>

      <H3>Call activity</H3>
      <P>
        Switch to the <strong style={{ color: C.text }}>Call Activity</strong> tab to see recent calls, ASR%, average MOS, and a 7-day performance graph. Use the search bar to filter by number or date.
      </P>

      <Callout accent={GREEN}>
        Phone numbers use <strong style={{ color: C.text }}>E.164 format</strong>: a <IC>+</IC> followed by country code and number with no spaces. US example: <IC>+17745551234</IC>.
      </Callout>
    </AccordionSection>
  );
}

/* ─── Need Help? ─────────────────────────────────────────── */

function SupportSection() {
  return (
    <AccordionSection
      id="support"
      accent={GREEN}
      icon={<HelpCircle size={18} />}
      title="Need Help?"
      subtitle="Quick checks and support contact."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        {[
          { q: 'Calls not forwarding?', a: 'Check the toggle is enabled and the forwarding number is correct.' },
          { q: 'Wrong destination?', a: 'Click the green number to edit it. Use full E.164 format.' },
          { q: 'Destination not answering?', a: 'Call the forwarding number directly to confirm it works.' },
        ].map(({ q, a }, i) => (
          <div
            key={i}
            style={{
              padding: '12px 16px',
              borderRadius: 8,
              background: 'rgba(13,17,23,0.45)',
              border: `1px solid ${C.borderSubtle}`,
            }}
          >
            <span style={{ fontSize: '0.83rem', fontWeight: 700, color: C.text }}>{q}</span>{' '}
            <span style={{ fontSize: '0.81rem', color: C.textMuted }}>{a}</span>
          </div>
        ))}
      </div>

      <Callout accent={GREEN}>
        Email <strong style={{ color: C.text }}>solutions@granitenet.com</strong> with the affected DID and approximate time of the issue.
      </Callout>
    </AccordionSection>
  );
}

/* ─── Page root ──────────────────────────────────────────── */

export function RcfDocsPage() {
  return (
    <div style={{ paddingTop: 20 }}>
      <PageHeaderCard
        eyebrow="Customer Guide"
        title="Granite Keystone RCF"
        subtitle="Manage your Remote Call Forwarding numbers"
        accent={GREEN}
      />

      <div style={{ padding: '0 0 60px' }}>
        <div style={{ maxWidth: 1080, margin: '0 auto' }}>
          <GettingStartedSection />
          <ManagingRcfSection />
          <SupportSection />
        </div>
      </div>
    </div>
  );
}
