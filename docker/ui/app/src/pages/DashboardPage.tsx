import { useCallback, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  Bot,
  Braces,
  Gauge,
  Layers,
  Lock,
  RefreshCw,
  ShieldCheck,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';
import { HaArchitectureViz } from '../components/layout/HaArchitectureViz';
import { useAuth } from '../contexts/AuthContext';
import { productHome } from '../utils/productHome';
import { SignInModal } from './landing/SignInModal';
import { RequestAccessSection } from './landing/RequestAccessSection';

/* ─────────────────────────────────────────────────────────────
   Public landing page — Granite CRAG.

   "Granite & Signal": industrial enterprise, color-blocked.
   Full-bleed alternating granite-dark / cobalt / paper-light
   bands (IBM/Cisco enterprise pattern). Display type: Archivo
   800–900. Body: Public Sans. ALL load-bearing responsive
   layout lives in index.css under "LANDING PAGE" as hand-written
   @media rules (NOT Tailwind md:* — see the container-build
   gotcha in CLAUDE.md).

   Positioning: Granite IS the carrier. CRAG is Granite's
   next-generation platform for advanced voice — AI agents,
   API calling, webhooks, intelligent routing — built directly
   on the carrier's own network. Never describe CRAG itself as
   "our carrier-grade platform".

   Narrative arc: what it is (hero) → proof (stats) → what you
   can build (AI/API band) → products → the network under it →
   platform capabilities → intake form (#request-access).
   ───────────────────────────────────────────────────────────── */

function scrollToRequestAccess(): void {
  document
    .getElementById('request-access')
    ?.scrollIntoView({ behavior: 'smooth' });
}

/* ─── Data ───────────────────────────────────────────────── */

interface Stat {
  value: string;
  label: string;
}

const STATS: Stat[] = [
  { value: '99.999%', label: 'Availability design target' },
  { value: '3', label: 'Self-contained US regions' },
  { value: '<1s', label: 'Failure detection & reroute' },
  { value: '100%', label: 'Calls signed with STIR/SHAKEN' },
];

type ProductStatus = 'ga' | 'early' | 'roadmap';

interface Product {
  name: string;
  desc: string;
  status: ProductStatus;
}

const STATUS_LABEL: Record<ProductStatus, string> = {
  ga: 'Generally available',
  early: 'Early access',
  roadmap: 'Roadmap',
};

const SIDE_PRODUCTS: Product[] = [
  {
    name: 'SIP Trunking',
    desc: 'IP-authenticated enterprise trunks with multi-region inbound redundancy and automated DNS failover.',
    status: 'early',
  },
  {
    name: 'API Calling',
    desc: 'Programmable voice for platforms and AI agents — originate, control, and observe calls over REST and webhooks.',
    status: 'early',
  },
  {
    name: 'Visual Voicemail',
    desc: 'Platform-native mailboxes with transcription and API retrieval — designed in, not bolted on.',
    status: 'roadmap',
  },
];

interface Capability {
  icon: LucideIcon;
  title: string;
  desc: string;
}

const CAPABILITIES: Capability[] = [
  {
    icon: ShieldCheck,
    title: 'Identity on every call',
    desc: 'STIR/SHAKEN signing at the switch, on self-hosted certificates. Verified attestation travels with the call from origination to termination.',
  },
  {
    icon: Activity,
    title: 'Packet-level observability',
    desc: 'Full SIP capture in every region. Ladder diagrams, per-hop timing, and raw messages for any call — no ticket, no waiting.',
  },
  {
    icon: Gauge,
    title: 'Quality, measured',
    desc: 'MOS, jitter, and packet-loss scoring on every session, surfaced in dashboards and exportable call records.',
  },
  {
    icon: Waypoints,
    title: 'Independent routes to termination',
    desc: 'A redundant, highly available SBC layer and two carrier points of presence — Dallas and Los Angeles — give every call independent paths to termination.',
  },
  {
    icon: Lock,
    title: 'Session hardening',
    desc: 'Topology hiding, rate limiting, and session-timer normalization handled in the network core, before traffic reaches your systems.',
  },
  {
    icon: RefreshCw,
    title: 'A network that reroutes itself',
    desc: 'Sub-second failure detection with automatic reroute across border controllers and carriers — no manual intervention, no maintenance window.',
  },
];

const BUILD_PILLARS: Capability[] = [
  {
    icon: Layers,
    title: 'No middleman between you and the network',
    desc: 'CRAG APIs terminate into Granite’s own switching core — no reseller layer, no CPaaS markup, no support-ticket relay. The team behind the API is the team that runs the network.',
  },
  {
    icon: Bot,
    title: 'Deterministic by design',
    desc: 'Bounded post-dial delay, regional media anchoring, and a fixed failover order. Your AI agents get the same network behavior on every single call.',
  },
  {
    icon: Braces,
    title: 'Programmable control',
    desc: 'REST provisioning, webhook call control, intelligent routing, and structured per-call records with quality metrics. Build voice products on primitives, not tickets.',
  },
  {
    icon: BadgeCheck,
    title: 'Carrier identity that gets answered',
    desc: 'Calls carry Granite’s own signed attestation, so machine-originated traffic arrives verified at the far end — answered by people, not screened out as spam.',
  },
];

/* ─── Building blocks ────────────────────────────────────── */

function StatusChip({ status }: { status: ProductStatus }) {
  return (
    <span className={`landing-chip landing-chip-${status}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function SectionHead({
  kicker,
  kickerInverse,
  title,
  blurb,
}: {
  kicker: string;
  kickerInverse?: boolean;
  title: React.ReactNode;
  blurb: string;
}) {
  return (
    <header className="landing-section-head">
      <span
        className={
          kickerInverse
            ? 'landing-kicker landing-kicker-inverse'
            : 'landing-kicker'
        }
      >
        {kicker}
      </span>
      <h2 className="landing-h2">{title}</h2>
      <p className="landing-blurb">{blurb}</p>
    </header>
  );
}

/* ─── Page ───────────────────────────────────────────────── */

export function DashboardPage() {
  // All hooks unconditionally at the top — React #310 prevention.
  const { isAuthenticated, isLoading, user, isAdmin } = useAuth();
  const location = useLocation();
  const [signInOpen, setSignInOpen] = useState(false);

  // Sign-in success only needs to close the modal: the auth state
  // change re-renders this component, and the <Navigate> below takes
  // over — a single, deterministic redirect source.
  const handleSignInSuccess = useCallback(() => {
    setSignInOpen(false);
  }, []);

  // RequireAuth preserves the intended destination when it bounces
  // unauthenticated visitors here.
  const fromState = location.state as
    | { from?: { pathname?: string; search?: string } }
    | null;
  const redirectTo =
    fromState?.from?.pathname && fromState.from.pathname !== '/'
      ? `${fromState.from.pathname}${fromState.from.search ?? ''}`
      : null;

  // While the persisted token validates, hold on a blank granite
  // screen so signed-in users never see the marketing page flash.
  if (isLoading) {
    return <div className="landing-splash" />;
  }

  // Authenticated users never see the landing page: go straight to
  // where they were headed, or to the product page they purchased.
  if (isAuthenticated) {
    return <Navigate to={redirectTo ?? productHome(user, isAdmin)} replace />;
  }

  return (
    <div className="landing-root">
      {/* ── HERO — granite band (top nav + hero grid) ────── */}
      <section className="landing-band landing-band-granite landing-hero">
        <div className="landing-wrap landing-topnav landing-up">
          <a
            className="landing-topnav-brand"
            href="/"
            onClick={(e) => {
              e.preventDefault();
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          >
            <img
              src="/crag.png"
              alt=""
              className="landing-topnav-mark"
              width={32}
              height={32}
            />
            <span className="landing-topnav-word">GRANITE CRAG</span>
          </a>
          <button
            type="button"
            className="landing-btn landing-btn-ghost landing-topnav-btn"
            onClick={() => setSignInOpen(true)}
          >
            Sign in
          </button>
        </div>

        <div className="landing-wrap landing-hero-grid">
          <div>
            <p className="landing-tag landing-up">
              Granite Telecommunications&ensp;·&ensp;Next-generation voice
            </p>

            <h1 className="landing-h1 landing-up landing-d1">
              <span className="landing-acc">C</span>all{' '}
              <span className="landing-acc">R</span>outing{' '}
              <span className="landing-acc">A</span>pplication{' '}
              <span className="landing-acc">G</span>ateway
            </h1>

            <p className="landing-lede landing-up landing-d2">
              CRAG is Granite&rsquo;s next-generation voice platform — built by
              the carrier for what comes next: AI voice agents, programmable
              API calling, webhooks, and intelligent routing, running directly
              on Granite&rsquo;s own nationwide network.
            </p>

            <div className="landing-cta-row landing-up landing-d3">
              <button
                type="button"
                className="landing-btn landing-btn-primary"
                onClick={scrollToRequestAccess}
              >
                Request access
                <ArrowRight size={16} strokeWidth={2.5} />
              </button>
              <a
                className="landing-btn landing-btn-ghost"
                href="#landing-network"
                onClick={(e) => {
                  e.preventDefault();
                  document
                    .getElementById('landing-network')
                    ?.scrollIntoView({ behavior: 'smooth' });
                }}
              >
                See the network
              </a>
            </div>

            <ul className="landing-hero-points landing-up landing-d4">
              <li>STIR/SHAKEN on every call</li>
              <li>Redundant, highly available SBC architecture</li>
              <li>Packet-level SIP capture</li>
            </ul>
          </div>

          <div className="landing-hero-mark landing-up landing-d2">
            <img
              src="/crag.png"
              alt="CRAG — Call Routing Application Gateway"
            />
          </div>
        </div>
      </section>

      {/* ── STAT BAND — cobalt ───────────────────────────── */}
      <section className="landing-band landing-band-cobalt landing-stats">
        <div className="landing-wrap landing-stats-grid">
          {STATS.map((s) => (
            <div key={s.label} className="landing-stat">
              <div className="landing-stat-value">{s.value}</div>
              <div className="landing-stat-label">{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── BUILD ON THE CARRIER — granite band ──────────── */}
      <section className="landing-band landing-band-granite landing-ai">
        <div className="landing-wrap">
          <SectionHead
            kicker="Build what's next"
            title="A programmable surface on the carrier itself."
            blurb="AI voice agents, API calling, webhooks, intelligent routing — CRAG puts modern voice primitives directly on Granite's nationwide network. When you build here, your software talks to the carrier — not to a reseller sitting on top of one."
          />
          <div className="landing-ai-grid">
            {BUILD_PILLARS.map((p) => (
              <div key={p.title} className="landing-ai-card">
                <span className="landing-icon-tile landing-icon-tile-inverse">
                  <p.icon size={19} strokeWidth={2.1} />
                </span>
                <h3 className="landing-card-title">{p.title}</h3>
                <p className="landing-card-desc">{p.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── PRODUCTS — paper band ────────────────────────── */}
      <section className="landing-band landing-band-paper">
        <div className="landing-wrap">
          <SectionHead
            kicker="Products"
            title="One network. Four ways to build on it."
            blurb="Every product runs on the same signed, multi-region core — the same routing engine, the same failover discipline, the same telemetry. Pick the interface that fits your traffic."
          />

          <div className="landing-products">
            <div
              className="landing-card landing-card-featured"
              role="button"
              tabIndex={0}
              onClick={scrollToRequestAccess}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') scrollToRequestAccess();
              }}
            >
              <StatusChip status="ga" />
              <h3 className="landing-card-title landing-card-title-lg">
                Remote Call Forwarding
              </h3>
              <p className="landing-card-desc">
                Nationwide number forwarding on redundant carrier routes —
                provisioned in minutes and observable down to the packet.
                Deployed today for utility-scale enterprise traffic.
              </p>
              <ul className="landing-spec-list">
                <li>Forwarding changes take effect in seconds</li>
                <li>Independent carrier routes for every call</li>
                <li>Per-call quality scoring and SIP capture</li>
              </ul>
              <span className="landing-card-link">
                Request access
                <ArrowUpRight size={16} strokeWidth={2.5} />
              </span>
            </div>

            <div className="landing-products-side">
              {SIDE_PRODUCTS.map((p) => (
                <div key={p.name} className="landing-card landing-card-side">
                  <div className="landing-card-side-head">
                    <h3 className="landing-card-title">{p.name}</h3>
                    <StatusChip status={p.status} />
                  </div>
                  <p className="landing-card-desc">{p.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── NETWORK — granite band ───────────────────────── */}
      <section
        className="landing-band landing-band-granite landing-network"
        id="landing-network"
      >
        <div className="landing-wrap">
          <SectionHead
            kicker="The network"
            title="Three regions. Zero shared fate."
            blurb="Each region runs a complete, independent voice stack — a redundant, highly available SBC layer, dedicated media, local data. Signaling and media never cross regional boundaries, so a regional event is a reroute, not an outage. The model below shows SIP Trunking inbound: every customer trunk targets one health-checked hostname, and DNS steers each call to a healthy region — running the failover scenarios continuously."
          />
          <HaArchitectureViz />
        </div>
      </section>

      {/* ── CAPABILITIES — paper band ────────────────────── */}
      <section className="landing-band landing-band-paper">
        <div className="landing-wrap">
          <SectionHead
            kicker="Platform"
            title="Carrier discipline. Modern tooling."
            blurb="The practices Granite uses to keep utility-scale voice traffic flowing, paired with the observability and control surfaces engineering teams actually want to use."
          />
          <div className="landing-caps">
            {CAPABILITIES.map((c) => (
              <div key={c.title} className="landing-card landing-cap">
                <span className="landing-icon-tile">
                  <c.icon size={19} strokeWidth={2.1} />
                </span>
                <h3 className="landing-card-title">{c.title}</h3>
                <p className="landing-card-desc">{c.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── INTAKE — cobalt band (#request-access) ───────── */}
      {/* Only unauthenticated visitors ever reach this render — the
          intake band is always present. */}
      <RequestAccessSection />

      {/* ── FOOTER ───────────────────────────────────────── */}
      <footer className="landing-band landing-foot">
        <div className="landing-wrap landing-foot-inner">
          <span className="landing-foot-brand">GRANITE · CRAG</span>
          <span>
            Next-generation voice — built and operated by Granite
            Telecommunications
          </span>
        </div>
      </footer>

      {/* ── SIGN-IN MODAL — mounted only while open so each
             open starts with fresh field/error state ───────── */}
      {signInOpen && (
        <SignInModal
          onClose={() => setSignInOpen(false)}
          onSuccess={handleSignInSuccess}
        />
      )}
    </div>
  );
}
