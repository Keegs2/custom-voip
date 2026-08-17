/**
 * ApiDidsPage — the API Calling (programmable voice) portal page.
 *
 * The product is in early access ahead of its customer portal, so this page
 * is a quiet daylight header plus a composed coming-soon presentation: a
 * positioning hero beside a pure-CSS request/response code vignette (the
 * docs pages' established ink-on-dark code treatment — no live backend), an
 * icon-led capability grid, and a quiet pilot closing line. Shared
 * primitives come from the DAYLIGHT CONSOLE system (`dl-*` in index.css);
 * page-scoped styles are `dlx7-*` in dl-api-calling.css.
 *
 * React #310: every hook is called unconditionally at the top, before any
 * early return.
 */

import { useAuth } from '../contexts/AuthContext';
import {
  Code2,
  SlidersHorizontal,
  Webhook,
  BadgeCheck,
  Activity,
  Bot,
} from 'lucide-react';
import '../styles/dl-api-calling.css';

/* ─── Capability catalogue — the first-release API surface ─── */

interface Capability {
  icon: React.ReactNode;
  title: string;
  line: string;
}

const CAPABILITIES: Capability[] = [
  {
    icon: <Code2 size={17} strokeWidth={1.7} />,
    title: 'Calls from code',
    line: 'Originate and manage calls with a simple REST request — no SIP stack required.',
  },
  {
    icon: <SlidersHorizontal size={17} strokeWidth={1.7} />,
    title: 'Live call control',
    line: 'Transfer, end, and monitor in-progress calls programmatically.',
  },
  {
    icon: <Webhook size={17} strokeWidth={1.7} />,
    title: 'Event webhooks',
    line: 'Call lifecycle events delivered to your endpoints as they happen.',
  },
  {
    icon: <BadgeCheck size={17} strokeWidth={1.7} />,
    title: 'Signed identity',
    line: 'Calls go out STIR/SHAKEN-signed by the carrier, so they arrive verified and get answered.',
  },
  {
    icon: <Activity size={17} strokeWidth={1.7} />,
    title: 'Per-call telemetry',
    line: 'Every call’s quality metrics and records retrievable via API.',
  },
  {
    icon: <Bot size={17} strokeWidth={1.7} />,
    title: 'Built for AI agents',
    line: 'Deterministic behavior and predictable throughput tiers for programmatic voice at scale.',
  },
];

/* ─── Code vignette — a composed request/response, rendered in CSS ───
   Tiny token helpers keep the JSON markup readable: K = key, S = string
   value, P = punctuation. Colors follow the docs code palette. */

function K({ children }: { children: React.ReactNode }) {
  return <span className="dlx7-k">{children}</span>;
}

function S({ children }: { children: React.ReactNode }) {
  return <span className="dlx7-s">{children}</span>;
}

function P({ children }: { children: React.ReactNode }) {
  return <span className="dlx7-p">{children}</span>;
}

function CodeVignette() {
  return (
    <div>
      <div className="dlx7-vignette" aria-hidden="true">
        {/* Request — method chip + path, then the JSON body */}
        <div className="dlx7-vg-bar">
          <span className="dlx7-vg-method">POST</span>
          <span className="dlx7-vg-path">/v1/calls</span>
          <span className="dlx7-vg-side">request</span>
        </div>
        <pre className="dlx7-vg-code">
          <P>{'{'}</P>{'\n'}
          {'  '}<K>&quot;from&quot;</K><P>: </P><S>&quot;+16175551234&quot;</S><P>,</P>{'\n'}
          {'  '}<K>&quot;to&quot;</K><P>: </P><S>&quot;+15085550100&quot;</S><P>,</P>{'\n'}
          {'  '}<K>&quot;webhook&quot;</K><P>: </P><S>&quot;https://your.app/events&quot;</S>{'\n'}
          <P>{'}'}</P>
        </pre>

        {/* Response — status chip, then the JSON body */}
        <div className="dlx7-vg-bar dlx7-vg-bar-resp">
          <span className="dlx7-vg-status">201 Created</span>
          <span className="dlx7-vg-side">response</span>
        </div>
        <pre className="dlx7-vg-code dlx7-vg-code-resp">
          <P>{'{'}</P>{'\n'}
          {'  '}<K>&quot;call_id&quot;</K><P>: </P><S>&quot;call_9f27ac41e3&quot;</S><P>,</P>{'\n'}
          {'  '}<K>&quot;status&quot;</K><P>: </P><S>&quot;queued&quot;</S>{'\n'}
          <P>{'}'}</P>
        </pre>
      </div>
      <p className="dlx7-vg-caption">Product preview — API surface may change</p>
    </div>
  );
}

/* ─── Page ─── */

export function ApiDidsPage() {
  // ── ALL hooks unconditionally at the top — React #310 guard ──
  const { user } = useAuth();

  return (
    <div className="dl-scope">
      <div className="dl-shell">
        {/* Quiet page header — breadcrumb, calm title, one-line description */}
        <header className="dl-header fx-load">
          <div className="dl-header-id">
            <div className="dl-crumb">
              <span>API Calling</span>
              <span className="dl-crumb-sep" aria-hidden="true">/</span>
              <span>Granite CRAG</span>
            </div>
            <h1 className="dl-title">
              {user?.customer_name ? `${user.customer_name}'s API Calling` : 'API Calling'}
            </h1>
            <p className="dl-sub">
              Programmable voice for platforms and AI agents — REST calls in, real calls out.
            </p>
          </div>
          <div className="dl-tag" style={{ padding: '6px 14px', fontSize: '0.68rem' }}>
            Early access
          </div>
        </header>

        {/* Hero — positioning copy beside the request/response vignette */}
        <div className="dl-panel fx-load fx-load-d1" style={{ marginBottom: 'var(--rcf-stack)' }}>
          <div className="dlx7-hero">
            <div>
              <h2 className="dlx7-hero-title">Programmable voice, built directly on the carrier</h2>
              <p className="dlx7-hero-copy">
                Not a reseller wrapper around someone else&rsquo;s network. Your code places
                calls on Granite&rsquo;s own switching core — the same one that routes,
                signs, and measures every call on CRAG — through a clean REST surface
                and webhooks that report what actually happened.
              </p>
              <ul className="dlx7-ticks">
                <li>One POST places a call on the carrier network — no SIP expertise needed</li>
                <li>No reseller layer between your application and the PSTN</li>
                <li>Made for platforms and AI agents that place calls at scale</li>
              </ul>
            </div>
            <CodeVignette />
          </div>
        </div>

        {/* Capability grid — the first-release API surface */}
        <div className="dl-panel fx-load fx-load-d2">
          <div className="dl-panel-head">
            <span className="dl-panel-title">What&rsquo;s coming</span>
            <span className="dl-tag">First release</span>
            <p className="dl-panel-sub">
              The initial API surface — everything below is exposed over REST and webhooks from day one.
            </p>
          </div>
          <div className="dlx7-caps">
            {CAPABILITIES.map((cap, i) => (
              <div
                key={cap.title}
                className="dlx7-cap fx-load"
                style={{ animationDelay: `${0.24 + i * 0.05}s` }}
              >
                <span className="dlx7-cap-chip" aria-hidden="true">{cap.icon}</span>
                <div>
                  <h3 className="dlx7-cap-title">{cap.title}</h3>
                  <p className="dlx7-cap-line">{cap.line}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Quiet closing line */}
        <p className="dlx7-close fx-load fx-load-d3">
          Building on voice? Your account team can add you to the early-access pilot.
        </p>
      </div>
    </div>
  );
}
