/**
 * Content sections for the RCF customer guide. Pure presentation — each section
 * is a <DocsAccordion> filled with text primitives. The page file composes
 * these in order.
 *
 * Themed on the app blue (DOCS.accent) to match the glass kit + the rcf-glass
 * reference; the Sidebar keeps its own RCF-green accent (Sidebar exception).
 */

import { Phone, HelpCircle, LogIn } from 'lucide-react';
import { DocsAccordion } from './DocsAccordion';
import { P, H3, IC, Callout, B } from './text';
import { DOCS, helpCard } from '../styles';

export function GettingStartedSection() {
  return (
    <DocsAccordion
      accent={DOCS.accent}
      icon={<LogIn size={18} />}
      title="Getting Started"
      subtitle="Log in and verify your numbers are working."
    >
      <P>
        Your administrator provides your login credentials. Navigate to your portal URL, sign in, and open
        the <B>RCF</B> page from the sidebar. Confirm your numbers are listed, enabled, and forwarding to the
        correct destinations. Place a test call to verify.
      </P>
      <Callout>
        If you need your password reset, contact your administrator or email <B>solutions@granitenet.com</B>.
      </Callout>
    </DocsAccordion>
  );
}

export function ManagingRcfSection() {
  return (
    <DocsAccordion
      accent={DOCS.accent}
      icon={<Phone size={18} />}
      title="Managing Your RCF"
      subtitle="Everything you can do with your forwarding numbers — all from the RCF page."
    >
      <P>
        The RCF page shows all of your numbers. Each card displays the DID, where it forwards to, and its
        current settings. All changes take effect within seconds — no support tickets required.
      </P>

      <H3>Change a forwarding destination</H3>
      <P>
        Click the forwarding number on any card. Type the new destination in E.164 format (<IC>+17745551234</IC>)
        and click <B>Save</B>. New calls immediately route to the updated number. Calls already in progress are
        not affected.
      </P>

      <H3>Enable or disable a number</H3>
      <P>
        Use the toggle in the top-right corner of each card. Disabled numbers stop forwarding but keep all
        settings intact. Re-enable anytime — forwarding resumes instantly.
      </P>

      <H3>Set a name / label</H3>
      <P>
        Click the label text above the DID (e.g. "Name this line — click to edit") to assign a friendly name
        like "Main Office" or "Boston Sales". This is for your reference only.
      </P>

      <H3>Caller ID pass-through</H3>
      <P>
        The <B>Caller ID</B> setting at the bottom of each card controls what the destination sees.{' '}
        <B>Pass-thru</B> shows the original caller's number. <B>Show DID</B> shows your RCF number instead.
        Click the pill to toggle.
      </P>

      <H3>Ring timeout</H3>
      <P>
        How long the call rings at the destination before giving up (default 30 seconds, range 5–120s). If a
        failover number is configured, unanswered calls redirect there automatically.
      </P>

      <H3>Call activity</H3>
      <P>
        Switch to the <B>Call Activity</B> tab to see recent calls, ASR%, average MOS, and a 7-day performance
        graph. Use the search bar to filter by number or date.
      </P>

      <Callout>
        Phone numbers use <B>E.164 format</B>: a <IC>+</IC> followed by country code and number with no spaces.
        US example: <IC>+17745551234</IC>.
      </Callout>
    </DocsAccordion>
  );
}

export function DIDManagementSection() {
  return (
    <DocsAccordion
      accent={DOCS.accent}
      icon={<Phone size={18} />}
      title="DID Management"
      subtitle="Request new numbers, view your inventory, and release numbers you no longer need."
    >
      <H3>Your numbers</H3>
      <P>
        The <B>Your Numbers</B> tab lists every DID assigned to your account along with its current status.
        Active numbers are ready to forward calls.
      </P>

      <H3>Requesting a new number</H3>
      <P>
        Open the <B>Available Numbers</B> tab, filter by area code, exchange, or state, then click <B>Request</B>{' '}
        next to any number you want. Each listing shows the city, state, and rate center.
      </P>

      <H3>Pending requests</H3>
      <P>
        Requested numbers appear in the <B>Pending</B> tab while awaiting admin approval. Once approved, the
        number moves into your active inventory automatically.
      </P>

      <H3>Releasing a number</H3>
      <P>
        To return a number you no longer need, click <B>Release</B> on the number's card. It is removed from
        your account and returned to the available pool immediately.
      </P>

      <H3>Filtering available numbers</H3>
      <P>
        Use the filter bar to narrow results by NPA (area code), NXX (exchange), state, or keyword. Filters can
        be combined to quickly find numbers in a specific city or region.
      </P>

      <Callout>
        Requested numbers require admin approval before they appear in your RCF lineup. Contact your
        administrator if a request has been pending for an extended period.
      </Callout>
    </DocsAccordion>
  );
}

export function SupportSection() {
  const items = [
    { q: 'Calls not forwarding?', a: 'Check the toggle is enabled and the forwarding number is correct.' },
    { q: 'Wrong destination?', a: 'Click the forwarding number to edit it. Use full E.164 format.' },
    { q: 'Destination not answering?', a: 'Call the forwarding number directly to confirm it works.' },
  ];

  return (
    <DocsAccordion
      accent={DOCS.accent}
      icon={<HelpCircle size={18} />}
      title="Need Help?"
      subtitle="Quick checks and support contact."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        {items.map(({ q, a }) => (
          <div key={q} style={helpCard}>
            <span style={{ fontSize: '0.83rem', fontWeight: 700, color: DOCS.text }}>{q}</span>{' '}
            <span style={{ fontSize: '0.81rem', color: DOCS.textMuted }}>{a}</span>
          </div>
        ))}
      </div>

      <Callout>
        Email <B>solutions@granitenet.com</B> with the affected DID and approximate time of the issue.
      </Callout>
    </DocsAccordion>
  );
}
