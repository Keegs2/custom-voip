/**
 * RCF User Guide — concise customer-facing documentation for Granite CRAG
 * (Call Routing Application Gateway) RCF.
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` in index.css) plus the
 * docs-only `dlx-*` primitives in src/styles/dl-docs.css.
 */

import { Phone, HelpCircle, LogIn } from 'lucide-react';

import { C } from './tokens';
import {
  P,
  H3,
  IC,
  Callout,
  AccordionSection,
  DocsHeader,
} from './shared';

// RCF brand accent — azure to match the daylight console system.
const ACCENT = '#2f7df6';

/* ─── Getting Started ────────────────────────────────────── */

function GettingStartedSection() {
  return (
    <AccordionSection
      id="getting-started"
      icon={<LogIn size={18} />}
      title="Getting Started"
      subtitle="Log in and verify your numbers are working."
    >
      <P>
        Your administrator provides your login credentials. Navigate to your portal URL, sign in, and open the <strong style={{ color: C.text }}>RCF</strong> page from the sidebar. Confirm your numbers are listed, enabled, and forwarding to the correct destinations. Place a test call to verify.
      </P>
      <Callout accent={ACCENT}>
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
      icon={<Phone size={18} />}
      title="Managing Your RCF"
      subtitle="Everything you can do with your forwarding numbers — all from the RCF page."
    >
      <P>
        The RCF page shows all of your numbers. Each card displays the DID, where it forwards to, and its current settings. All changes take effect within seconds — no support tickets required.
      </P>

      <H3>Change a forwarding destination</H3>
      <P>
        Click the blue forwarding number on any card. Type the new destination in E.164 format (<IC>+17745551234</IC>) and click <strong style={{ color: C.text }}>Save</strong>. New calls immediately route to the updated number. Calls already in progress are not affected.
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

      <Callout accent={ACCENT}>
        Phone numbers use <strong style={{ color: C.text }}>E.164 format</strong>: a <IC>+</IC> followed by country code and number with no spaces. US example: <IC>+17745551234</IC>.
      </Callout>
    </AccordionSection>
  );
}

/* ─── DID Management ────────────────────────────────────── */

function DIDManagementSection() {
  return (
    <AccordionSection
      id="did-management"
      icon={<Phone size={18} />}
      title="DID Management"
      subtitle="Request new numbers, view your inventory, and release numbers you no longer need."
    >
      <H3>Your numbers</H3>
      <P>
        The <strong style={{ color: C.text }}>Your Numbers</strong> tab lists every DID assigned to your account along with its current status. Active numbers are ready to forward calls.
      </P>

      <H3>Requesting a new number</H3>
      <P>
        Open the <strong style={{ color: C.text }}>Available Numbers</strong> tab, filter by area code, exchange, or state, then click <strong style={{ color: C.text }}>Request</strong> next to any number you want. Each listing shows the city, state, and rate center.
      </P>

      <H3>Pending requests</H3>
      <P>
        Requested numbers appear in the <strong style={{ color: C.text }}>Pending</strong> tab while awaiting admin approval. Once approved, the number moves into your active inventory automatically.
      </P>

      <H3>Releasing a number</H3>
      <P>
        To return a number you no longer need, click <strong style={{ color: C.text }}>Release</strong> on the number's card. It is removed from your account and returned to the available pool immediately.
      </P>

      <H3>Filtering available numbers</H3>
      <P>
        Use the filter bar to narrow results by NPA (area code), NXX (exchange), state, or keyword. Filters can be combined to quickly find numbers in a specific city or region.
      </P>

      <Callout accent={ACCENT}>
        Requested numbers require admin approval before they appear in your RCF lineup. Contact your administrator if a request has been pending for an extended period.
      </Callout>
    </AccordionSection>
  );
}

/* ─── Need Help? ─────────────────────────────────────────── */

function SupportSection() {
  return (
    <AccordionSection
      id="support"
      icon={<HelpCircle size={18} />}
      title="Need Help?"
      subtitle="Quick checks and support contact."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
        {[
          { q: 'Calls not forwarding?', a: 'Check the toggle is enabled and the forwarding number is correct.' },
          { q: 'Wrong destination?', a: 'Click the blue number to edit it. Use full E.164 format.' },
          { q: 'Destination not answering?', a: 'Call the forwarding number directly to confirm it works.' },
        ].map(({ q, a }, i) => (
          <div key={i} className="dlx-item">
            <span style={{ fontSize: '0.83rem', fontWeight: 700, color: C.text }}>{q}</span>{' '}
            <span style={{ fontSize: '0.81rem', color: C.textMuted }}>{a}</span>
          </div>
        ))}
      </div>

      <Callout accent={ACCENT}>
        Email <strong style={{ color: C.text }}>solutions@granitenet.com</strong> with the affected DID and approximate time of the issue.
      </Callout>
    </AccordionSection>
  );
}

/* ─── Page root ──────────────────────────────────────────── */

export function RcfDocsPage() {
  return (
    <div className="dl-scope">
      <div className="dl-shell">
        <DocsHeader
          crumb="RCF Guide"
          title="Granite CRAG RCF"
          subtitle="Call Routing Application Gateway — manage your Remote Call Forwarding numbers"
        />

        <div className="dlx-docs-col dl-stack fx-load fx-load-d1">
          <GettingStartedSection />
          <ManagingRcfSection />
          <DIDManagementSection />
          <SupportSection />
        </div>
      </div>
    </div>
  );
}
