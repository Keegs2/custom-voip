/**
 * VisualVoicemailPage — the Visual Voicemail product's portal page.
 *
 * The product launches ahead of the flow-builder line, so this page is a
 * quiet daylight header plus a composed coming-soon presentation: a
 * positioning hero with a miniature inbox vignette (pure CSS, no backend),
 * an icon-led capability grid, and a quiet pilot-list closing line. Shared
 * primitives come from the DAYLIGHT CONSOLE system (`dl-*` in index.css);
 * page-scoped styles are `dlx6-*` in dl-voicemail.css.
 *
 * React #310: every hook is called unconditionally at the top, before any
 * early return.
 */

import { useAuth } from '../contexts/AuthContext';
import { IconVoicemail } from '../components/icons/ProductIcons';
import {
  FileText,
  Send,
  Phone,
  SlidersHorizontal,
  Lock,
  Braces,
  Play,
} from 'lucide-react';
import '../styles/dl-voicemail.css';

/* ─── Capability catalogue — what ships with the launch release ─── */

interface Capability {
  icon: React.ReactNode;
  title: string;
  line: string;
}

const CAPABILITIES: Capability[] = [
  {
    icon: <FileText size={17} strokeWidth={1.7} />,
    title: 'Automatic transcription',
    line: 'Read messages at a glance — every voicemail becomes searchable text.',
  },
  {
    icon: <Send size={17} strokeWidth={1.7} />,
    title: 'Instant delivery',
    line: 'Email and webhook notifications the moment a message lands, with the audio and transcript attached.',
  },
  {
    icon: <Phone size={17} strokeWidth={1.7} />,
    title: 'Works with your numbers',
    line: 'Attach mailboxes to the CRAG numbers you already run — RCF or trunk — or add new ones.',
  },
  {
    icon: <SlidersHorizontal size={17} strokeWidth={1.7} />,
    title: 'Per-mailbox controls',
    line: 'Custom greetings, PIN access, and retention windows, set individually for every mailbox.',
  },
  {
    icon: <Lock size={17} strokeWidth={1.7} />,
    title: 'Private by design',
    line: 'Messages encrypted at rest, with access controlled per user on your account.',
  },
  {
    icon: <Braces size={17} strokeWidth={1.7} />,
    title: 'API access',
    line: 'Retrieve messages and transcripts programmatically for your own apps and workflows.',
  },
];

/* ─── Static waveform for the vignette — deterministic bar heights ─── */

const WAVE_HEIGHTS = [5, 9, 14, 11, 16, 8, 13, 17, 10, 15, 7, 12, 16, 9, 14, 6, 11, 15, 8, 12, 5, 9, 13, 7];
const WAVE_PLAYED = 10; // bars rendered as "already played" (azure)

function Waveform() {
  return (
    <div className="dlx6-wave" aria-hidden="true">
      {WAVE_HEIGHTS.map((h, i) => (
        <i key={i} className={i < WAVE_PLAYED ? 'dlx6-on' : undefined} style={{ height: h }} />
      ))}
    </div>
  );
}

/* ─── Inbox vignette — a miniature of the product, no live data ─── */

function InboxVignette() {
  return (
    <div>
      <div className="dlx6-vignette" aria-hidden="true">
        <div className="dlx6-vg-head">
          <IconVoicemail size={14} />
          <span className="dlx6-vg-title">Voicemail — Main Line</span>
          <span className="dlx6-vg-count">2 new</span>
        </div>

        {/* Unread, playing */}
        <div className="dlx6-msg dlx6-msg-unread">
          <span className="dlx6-play dlx6-play-solid">
            <Play size={11} strokeWidth={2.4} fill="currentColor" />
          </span>
          <div className="dlx6-msg-main">
            <div className="dlx6-msg-top">
              <span className="dlx6-msg-from">(617) 555-0134</span>
              <span className="dlx6-msg-when">Today · 2:41 PM</span>
            </div>
            <Waveform />
            <div className="dlx6-msg-snippet">
              &ldquo;Hi, this is Dana calling back about Thursday&rsquo;s inspection at the Franklin Street site&hellip;&rdquo;
            </div>
          </div>
          <span className="dlx6-msg-dur">0:42</span>
        </div>

        {/* Unread */}
        <div className="dlx6-msg dlx6-msg-unread">
          <span className="dlx6-play">
            <Play size={11} strokeWidth={2.4} fill="currentColor" />
          </span>
          <div className="dlx6-msg-main">
            <div className="dlx6-msg-top">
              <span className="dlx6-msg-from">(508) 555-0198</span>
              <span className="dlx6-msg-when">Today · 9:03 AM</span>
            </div>
            <div className="dlx6-msg-snippet">
              &ldquo;Morning — the service crew is on site and the gate code isn&rsquo;t working. Could someone&hellip;&rdquo;
            </div>
          </div>
          <span className="dlx6-msg-dur">1:17</span>
        </div>

        {/* Read */}
        <div className="dlx6-msg dlx6-msg-read">
          <span className="dlx6-play">
            <Play size={11} strokeWidth={2.4} fill="currentColor" />
          </span>
          <div className="dlx6-msg-main">
            <div className="dlx6-msg-top">
              <span className="dlx6-msg-from">(774) 555-0210</span>
              <span className="dlx6-msg-when">Yesterday</span>
            </div>
            <div className="dlx6-msg-snippet">
              &ldquo;Just confirming next week&rsquo;s delivery window — no need to call back if it still&hellip;&rdquo;
            </div>
          </div>
          <span className="dlx6-msg-dur">0:29</span>
        </div>
      </div>
      <p className="dlx6-vg-caption">Product preview — final interface may vary</p>
    </div>
  );
}

/* ─── Page ─── */

export function VisualVoicemailPage() {
  // ── ALL hooks unconditionally at the top — React #310 guard ──
  const { user } = useAuth();

  return (
    <div className="dl-scope">
      <div className="dl-shell">
        {/* Quiet page header — breadcrumb, calm title, one-line description */}
        <header className="dl-header fx-load">
          <div className="dl-header-id">
            <div className="dl-crumb">
              <span>Visual Voicemail</span>
              <span className="dl-crumb-sep" aria-hidden="true">/</span>
              <span>Granite CRAG</span>
            </div>
            <h1 className="dl-title">
              {user?.customer_name ? `${user.customer_name}'s Visual Voicemail` : 'Visual Voicemail'}
            </h1>
            <p className="dl-sub">
              See, play, and read your voicemail — on the numbers you already run on CRAG.
            </p>
          </div>
          <div className="dl-tag" style={{ padding: '6px 14px', fontSize: '0.68rem' }}>
            Coming soon
          </div>
        </header>

        {/* Hero — positioning copy beside the inbox vignette */}
        <div className="dl-panel fx-load fx-load-d1" style={{ marginBottom: 'var(--rcf-stack)' }}>
          <div className="dlx6-hero">
            <div>
              <h2 className="dlx6-hero-title">Voicemail, designed into the platform</h2>
              <p className="dlx6-hero-copy">
                Not an answering service bolted on the side. Mailboxes attach directly to the
                CRAG numbers you already forward and trunk — and every message lands in a
                visual inbox you can scan, play, and search like email.
              </p>
              <ul className="dlx6-ticks">
                <li>See and play messages from any browser or device</li>
                <li>Manage voicemail like email — no dial-in menus, no cassette metaphors</li>
                <li>Keep your existing numbers; add mailboxes when you need them</li>
              </ul>
            </div>
            <InboxVignette />
          </div>
        </div>

        {/* Capability grid — what ships with the launch */}
        <div className="dl-panel fx-load fx-load-d2">
          <div className="dl-panel-head">
            <span className="dl-panel-title">What&rsquo;s coming</span>
            <span className="dl-tag">Launch release</span>
            <p className="dl-panel-sub">
              Every capability below ships with the launch — no new hardware, no number changes.
            </p>
          </div>
          <div className="dlx6-caps">
            {CAPABILITIES.map((cap, i) => (
              <div
                key={cap.title}
                className="dlx6-cap fx-load"
                style={{ animationDelay: `${0.24 + i * 0.05}s` }}
              >
                <span className="dlx6-cap-chip" aria-hidden="true">{cap.icon}</span>
                <div>
                  <h3 className="dlx6-cap-title">{cap.title}</h3>
                  <p className="dlx6-cap-line">{cap.line}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Quiet closing line */}
        <p className="dlx6-close fx-load fx-load-d3">
          Want early access? Your account team can add you to the pilot list.
        </p>
      </div>
    </div>
  );
}
