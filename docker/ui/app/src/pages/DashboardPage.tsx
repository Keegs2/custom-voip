import { useCallback, useState, type CSSProperties, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  BadgeCheck,
  Check,
  FileSpreadsheet,
  Gauge,
  Layers,
  Lock,
  Network,
  PhoneCall,
  PhoneForwarded,
  RefreshCw,
  Route,
  Server,
  ServerCog,
  ShieldCheck,
  SlidersHorizontal,
  Timer,
  Voicemail,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';
import { HaArchitectureViz } from '../components/layout/HaArchitectureViz';
import { useAuth } from '../contexts/AuthContext';
import { productHome } from '../utils/productHome';
import { SignInModal } from './landing/SignInModal';
import { RequestAccessSection } from './landing/RequestAccessSection';
import '../styles/landing.css';

/* ─────────────────────────────────────────────────────────────
   Public landing page — Granite CRAG.

   One continuous granite canvas (no colour-blocked bands): every
   section sits on the same 12-column container, opens on a
   container-width hairline and a split head (title left, blurb
   right), and gets its own structural device so the page never
   reads as a stack of identical cards — KPI readout, pillar rail,
   product cards, a framed network instrument, a spec grid, the
   intake form. Display type: Archivo. Body: Public Sans. All
   styling lives in styles/landing.css (hand-written @media and
   container queries — NOT Tailwind md:*, see the container-build
   gotcha in CLAUDE.md).

   Positioning (every claim on this page was checked against the
   code in 2026-10 — keep it that way): CRAG is the voice platform
   Granite builds and runs — an active/standby SBC pair and an
   active/hot-standby media server pair in each of three independent
   US regions, health-checked failover, multiple termination routes
   tried per call, on-net routing with no hairpin. Products: Remote
   Call Forwarding (generally available), SIP Trunking and Visual
   Voicemail (early access). Do NOT claim AI voice agents, API
   Calling (retired 2026-09), a "nationwide network" of Granite's
   own, DNS steering (not built), or STIR/SHAKEN on "every call"
   (signing fails open). Owner rules for this public page: never
   name the cloud provider, any carrier or any PoP city; the
   availability figure is presented as a design target.

   Hero: the H1 is the CRAG acrostic, one word per line so the blue
   initials read C-R-A-G down one optically aligned left edge; the art is
   a transparent cut-out of the cube (public/crag-cube.*) over a CSS halo.

   Every list below (stats, pillars, products, capabilities) is data:
   the layouts take any count, so copy can add or drop items without
   touching markup.

   Narrative arc: what it is (hero) → the numbers (KPI readout) →
   who runs it → products → the network under it → platform
   capabilities → intake form (#request-access).
   ───────────────────────────────────────────────────────────── */

function scrollToId(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
}

function scrollToRequestAccess(): void {
  scrollToId('request-access');
}

/* ─── Data ───────────────────────────────────────────────── */

interface ProofPoint {
  icon: LucideIcon;
  title: string;
  detail: string;
}

/* Hero proof strip — three equal columns (one stacked list on phones), so
   it can never leave an orphan row. Titles stay one line; details may wrap. */
const HERO_PROOF: ProofPoint[] = [
  { icon: ShieldCheck, title: 'STIR/SHAKEN', detail: 'Signed at our SBCs' },
  { icon: Network, title: 'Redundant SBCs', detail: 'Active/standby pairs' },
  { icon: Activity, title: 'SIP capture', detail: 'Down to the packet' },
];

/* The H1 acrostic: one word per line, so the blue initials stack into a
   column that reads C-R-A-G. The initials are styled with ::first-letter
   (landing.css), so the DOM text stays "Call Routing Application Gateway". */
const ACROSTIC = ['Call', 'Routing', 'Application', 'Gateway'] as const;

interface Stat {
  value: string;
  label: string;
  /** Set for numbers that are a design figure, not a measured fact. */
  note?: string;
}

/* KPI readout under the hero. Any count works: N equal columns on the
   hero's gutter (lands on the 12-column grid whenever N divides 12).
   Sources: 99.999% — the owner's availability design target (the
   documented monthly SLO is 99.95%, infra/monitoring/SLOS.md); 3 —
   production topology; ~10 s — the SBC load balancer's health check,
   5 s × 2 (flip drills passed but were not logged); 8 — the failover
   list's cap, 4 trunks × 2 SBC paths (inbound_router.lua). Design
   figures carry a visible note. */
const STATS: Stat[] = [
  { value: '99.999%', label: 'Availability design target' },
  { value: '3', label: 'Independent US regions' },
  { value: '~10 s', label: 'Automatic SBC failover', note: 'Design target' },
  { value: 'Up to 8', label: 'Failover routes per call', note: 'Design limit' },
];

type ProductStatus = 'ga' | 'early' | 'roadmap';

const STATUS_LABEL: Record<ProductStatus, string> = {
  ga: 'Generally available',
  early: 'Early access',
  roadmap: 'Roadmap',
};

interface Product {
  name: string;
  icon: LucideIcon;
  desc: string;
  status: ProductStatus;
  /** Proof lines rendered as a check list on the card. */
  specs: string[];
}

/* Products, in display order — one column each on desktop, any count.
   API Calling (retired), IVR, toll-free, UCaaS and AI agents are NOT
   products here; don't list them. */
const PRODUCTS: Product[] = [
  {
    name: 'Remote Call Forwarding',
    icon: PhoneForwarded,
    status: 'ga',
    desc: 'Nationwide number forwarding across three regions and multiple termination routes. In production today for nationwide enterprise traffic.',
    specs: [
      'Forwarding changes apply on the next call',
      'A prioritized list of termination routes for every call',
      'Per-call quality grades and full SIP capture',
    ],
  },
  {
    name: 'SIP Trunking',
    icon: Server,
    status: 'early',
    desc: 'IP-authenticated trunks to your PBX or SBC, accepted in all three regions.',
    specs: [
      'IP authentication — no SIP registration',
      'Calls delivered to your PBX or SBC',
      'Per-call records and full SIP capture',
    ],
  },
  {
    name: 'Visual Voicemail',
    icon: Voicemail,
    status: 'early',
    desc: 'Encrypted mailboxes on dedicated numbers — listen, download and manage messages in the CRAG portal, with optional transcripts.',
    specs: [
      'Encrypted with your own key — audio is never stored in plaintext',
      'Playback links expire after two minutes; every access is logged',
      'Optional transcripts, processed in the US and stored encrypted',
    ],
  },
];

const COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];

/** "Three" for 3 — the products title counts the cards it introduces. */
function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

interface Capability {
  icon: LucideIcon;
  title: string;
  desc: string;
}

/* Who runs it — four pillars. */
const BUILD_PILLARS: Capability[] = [
  {
    icon: Layers,
    title: 'Run by the people who built it',
    desc: 'Your calls land on SBCs and media servers Granite operates — not on a reseller’s platform. The engineers who run the network are the ones who handle your request.',
  },
  {
    icon: Timer,
    title: 'Predictable by design',
    desc: 'Every route attempt has a 10-second post-dial bound, media stays in the region that took the call, and failover follows a fixed order set per region.',
  },
  {
    icon: SlidersHorizontal,
    title: 'Self-service control',
    desc: 'Change forwarding in the portal and it applies on the next call. Every call is recorded with its outcome — and a quality grade when there’s enough audio to grade — ready for reports and CSV export.',
  },
  {
    icon: BadgeCheck,
    title: 'Signed with Granite’s own certificate',
    desc: 'Calls leaving Granite are signed at our SBCs with Granite’s own SHAKEN certificate, and the attestation is recorded per call. Forwarded calls keep the caller’s original signature, with Granite’s signed diversion attached.',
  },
];

/* Platform spec grid — 3 × 3: resilience, routing, visibility. */
const CAPABILITIES: Capability[] = [
  {
    icon: RefreshCw,
    title: 'Failures routed around',
    desc: 'The standby SBC takes over in about 10 seconds, an unreachable SBC path is skipped in under a second, and a route that rejects a call triggers an immediate retry on the next one.',
  },
  {
    icon: PhoneCall,
    title: 'Built to keep calls up',
    desc: 'Calls already connected are designed to stay up when an SBC fails over: either SBC can carry an established call’s signaling.',
  },
  {
    icon: ServerCog,
    title: 'Two media servers per region',
    desc: 'Each region runs an active and a hot-standby media server, with automatic takeover.',
  },
  {
    icon: Waypoints,
    title: 'Multiple routes to termination',
    desc: 'Each call works down a prioritized list of termination routes, set per region, over either SBC path — up to eight attempts before a call is given up.',
  },
  {
    icon: Route,
    title: 'On-net calls stay on-net',
    desc: 'Calls between Granite numbers stay on Granite’s network — delivered internally, never sent out to the PSTN and back.',
  },
  {
    icon: Lock,
    title: 'Session hardening',
    desc: 'Topology hiding, rate limiting and session-timer normalization happen at the SBC, before traffic reaches your systems — and duplicate INVITEs are merged, so a forwarded call rings once.',
  },
  {
    icon: Activity,
    title: 'Monitoring built in',
    desc: 'Packet-level SIP capture from every region, call-flow (ladder) diagrams, live NOC dashboards and alerting — the monitoring stack Granite’s operations team runs the network on.',
  },
  {
    icon: Gauge,
    title: 'Quality, measured',
    desc: 'Every answered call with enough audio gets a quality grade — MOS from an ITU-T G.107 model over true RTP packet loss, plus RFC 3550 jitter — shown in the portal and report exports, with one-way audio flagged.',
  },
  {
    icon: FileSpreadsheet,
    title: 'Reports and call records',
    desc: 'Call reports by number, day and outcome, with CSV export, in your time zone. Each call also records every route attempt and its STIR result.',
  },
];

/* Footer in-page navigation — anchors that exist on this page. */
const FOOTER_LINKS: { label: string; target: string }[] = [
  { label: 'Products', target: 'landing-products' },
  { label: 'The network', target: 'landing-network' },
  { label: 'Platform', target: 'landing-platform' },
  { label: 'Request access', target: 'request-access' },
];

/* ─── Building blocks ────────────────────────────────────── */

/**
 * The CRAG stone cube, cut out of /crag.png onto a transparent ground
 * (crag-cube.* is the full-size art, crag-mark.* a tight 160px crop for the
 * nav). WebP first; the PNG is the fallback. The original /crag.png lockup
 * stays in public/ for the sidebar and the favicon.
 */
function CragCube({
  variant,
  className,
  alt,
}: {
  variant: 'hero' | 'mark';
  className: string;
  alt: string;
}) {
  const base = variant === 'hero' ? '/crag-cube' : '/crag-mark';
  const size = variant === 'hero' ? 798 : 160;
  return (
    <picture>
      <source srcSet={`${base}.webp`} type="image/webp" />
      <img
        src={`${base}.png`}
        alt={alt}
        className={className}
        width={size}
        height={size}
        decoding="async"
        fetchPriority={variant === 'hero' ? 'high' : 'auto'}
      />
    </picture>
  );
}

/** The logo's signal line, redrawn crisp: hairline — waveform — hairline. */
function SignalLine() {
  // Bar heights echo the waveform glyph under the CRAG wordmark.
  const bars = [3, 6, 10, 15, 9, 13, 6, 4];
  return (
    <span className="landing-hero-signal" aria-hidden="true">
      <span className="landing-hero-signal-rule" />
      <svg viewBox="0 0 30 16" width="30" height="16" focusable="false">
        {bars.map((h, i) => (
          <rect
            key={i}
            x={1 + i * 3.6}
            y={(16 - h) / 2}
            width="1.8"
            height={h}
            rx="0.9"
          />
        ))}
      </svg>
      <span className="landing-hero-signal-rule" />
    </span>
  );
}

function StatusPill({ status }: { status: ProductStatus }) {
  return (
    <span className={`landing-status landing-status-${status}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

/** One product card: status, name, description, proof list, CTA. */
function ProductCard({ product: p }: { product: Product }) {
  return (
    <li className={`landing-product landing-product-${p.status}`}>
      <div className="landing-product-head">
        <span className="landing-icon-tile">
          <p.icon size={20} strokeWidth={1.9} aria-hidden="true" />
        </span>
        <StatusPill status={p.status} />
      </div>
      <h3 className="landing-product-name">{p.name}</h3>
      <p className="landing-item-desc">{p.desc}</p>
      {p.specs.length > 0 && (
        <ul className="landing-product-specs">
          {p.specs.map((s) => (
            <li key={s}>
              <Check size={16} strokeWidth={2.5} aria-hidden="true" />
              {s}
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="landing-product-cta"
        onClick={scrollToRequestAccess}
      >
        Request access
        <ArrowRight size={15} strokeWidth={2.5} aria-hidden="true" />
      </button>
    </li>
  );
}

/**
 * Section head — a kicker (the hero tag's bar motif, sentence case), the
 * H2, and a blurb. Desktop splits it: title on the copy columns, blurb on
 * the right. The H2 id labels the section landmark.
 */
function SectionHead({
  id,
  kicker,
  title,
  blurb,
}: {
  id: string;
  kicker: string;
  title: ReactNode;
  blurb: ReactNode;
}) {
  return (
    <header className="landing-grid12 landing-section-head">
      <div className="landing-section-head-title">
        <span className="landing-kicker">{kicker}</span>
        <h2 className="landing-h2" id={id}>
          {title}
        </h2>
      </div>
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

  const statStyle = { '--lg-stat-count': STATS.length } as CSSProperties;

  return (
    <div className="landing-root">
      {/* ── HERO (top nav + hero grid) ───────────────────── */}
      <section className="landing-band landing-hero">
        <div className="landing-wrap landing-topnav landing-up">
          <a
            className="landing-topnav-brand"
            href="/"
            onClick={(e) => {
              e.preventDefault();
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          >
            <CragCube variant="mark" className="landing-topnav-mark" alt="" />
            <span className="landing-topnav-word">
              <span className="landing-topnav-word-granite">GRANITE</span>
              {' '}
              CRAG
            </span>
          </a>
          <button
            type="button"
            className="landing-btn landing-btn-ghost landing-topnav-btn"
            onClick={() => setSignInOpen(true)}
          >
            Sign in
          </button>
        </div>

        <div className="landing-wrap landing-grid12 landing-hero-grid">
          <div className="landing-hero-copy">
            <p className="landing-tag landing-up">
              <span className="landing-tag-org">Granite Telecommunications</span>
              <span className="landing-tag-sep" aria-hidden="true" />
              <span>Next-generation voice</span>
            </p>

            <h1 className="landing-h1 landing-acrostic landing-up landing-d1">
              {ACROSTIC.map((word, i) => (
                <span key={word}>
                  {word}
                  {i < ACROSTIC.length - 1 ? ' ' : ''}
                </span>
              ))}
            </h1>

            <p className="landing-lede landing-up landing-d2">
              CRAG is Granite&rsquo;s voice platform for business call
              routing: call forwarding, SIP trunking and encrypted voicemail
              on a carrier-grade core that Granite builds and runs in three
              independent US regions, managed through a self-service portal.
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
                  scrollToId('landing-network');
                }}
              >
                See the network
              </a>
            </div>

            <ul className="landing-proof landing-up landing-d4">
              {HERO_PROOF.map((p) => (
                <li key={p.title} className="landing-proof-item">
                  <p.icon
                    className="landing-proof-icon"
                    size={18}
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                  <span className="landing-proof-title">{p.title}</span>
                  <span className="landing-proof-detail">{p.detail}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="landing-hero-art landing-up landing-d2">
            <div className="landing-hero-stage">
              <CragCube
                variant="hero"
                className="landing-hero-cube"
                alt="CRAG — Call Routing Application Gateway"
              />
              <SignalLine />
            </div>
          </div>
        </div>
      </section>

      {/* ── KPI READOUT — N equal columns on the hero's grid ─ */}
      <section className="landing-band landing-stats" aria-label="Platform at a glance">
        <div className="landing-wrap">
          <dl className="landing-stats-grid" style={statStyle}>
            {STATS.map((s) => (
              <div key={s.label} className="landing-stat">
                <dt className="landing-stat-label">
                  {s.label}
                  {s.note && <span className="landing-stat-note">{s.note}</span>}
                </dt>
                <dd className="landing-stat-value">{s.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ── WHO RUNS IT — pillar rail ────────────────────── */}
      <section
        className="landing-band landing-section landing-build"
        aria-labelledby="landing-build-title"
      >
        <div className="landing-wrap">
          <SectionHead
            id="landing-build-title"
            kicker="Built by Granite"
            title="A voice core Granite builds and runs."
            blurb="CRAG is Granite's own switching core — border controllers, media servers and routing that Granite engineers build and operate in three US regions, connected to the PSTN over multiple termination routes."
          />
          <ul className="landing-pillars">
            {BUILD_PILLARS.map((p) => (
              <li key={p.title} className="landing-pillar">
                <span className="landing-icon-tile">
                  <p.icon size={20} strokeWidth={1.9} aria-hidden="true" />
                </span>
                <h3 className="landing-item-title">{p.title}</h3>
                <p className="landing-item-desc">{p.desc}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── PRODUCTS — data-driven cards ─────────────────── */}
      <section
        className="landing-band landing-section landing-products-band"
        id="landing-products"
        aria-labelledby="landing-products-title"
      >
        <div className="landing-wrap">
          <SectionHead
            id="landing-products-title"
            kicker="Products"
            title={`One network. ${countWord(PRODUCTS.length)} ways to use it.`}
            blurb="Every product runs on the same three-region core — one routing engine, one failover design, one call record. Pick the one that fits your traffic."
          />

          <ul className="landing-products">
            {PRODUCTS.map((p) => (
              <ProductCard key={p.name} product={p} />
            ))}
          </ul>
        </div>
      </section>

      {/* ── NETWORK — framed HA instrument ───────────────── */}
      <section
        className="landing-band landing-section landing-network"
        id="landing-network"
        aria-labelledby="landing-network-title"
      >
        <div className="landing-wrap">
          <SectionHead
            id="landing-network-title"
            kicker="The network"
            title="Three regions. Independent call paths."
            blurb="Each region runs a complete voice stack — an active/standby SBC pair, active/standby media servers and a local database replica. Signaling and media never cross regions, and a region whose media layer fails marks itself unhealthy so new calls land in the others. Shared services — the database primary, the API and SIP capture — run in East. The model below plays the failover scenarios on a loop."
          />
          <HaArchitectureViz />
        </div>
      </section>

      {/* ── PLATFORM — spec grid ─────────────────────────── */}
      <section
        className="landing-band landing-section landing-platform"
        id="landing-platform"
        aria-labelledby="landing-platform-title"
      >
        <div className="landing-wrap">
          <SectionHead
            id="landing-platform-title"
            kicker="Platform"
            title="Carrier discipline. Modern tooling."
            blurb="The practices Granite uses to keep utility-scale voice traffic flowing, paired with the observability and control surfaces engineering teams actually want to use."
          />
          <ul className="landing-specgrid">
            {CAPABILITIES.map((c) => (
              <li key={c.title} className="landing-spec">
                <c.icon
                  className="landing-spec-icon"
                  size={20}
                  strokeWidth={1.9}
                  aria-hidden="true"
                />
                <h3 className="landing-item-title">{c.title}</h3>
                <p className="landing-item-desc">{c.desc}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── INTAKE (#request-access) ─────────────────────── */}
      {/* Only unauthenticated visitors ever reach this render — the
          intake band is always present. */}
      <RequestAccessSection />

      {/* ── FOOTER ───────────────────────────────────────── */}
      <footer className="landing-foot">
        <div className="landing-wrap landing-grid12 landing-foot-top">
          <div className="landing-foot-brand">
            <a
              className="landing-topnav-brand"
              href="/"
              onClick={(e) => {
                e.preventDefault();
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
            >
              <CragCube variant="mark" className="landing-topnav-mark" alt="" />
              <span className="landing-topnav-word">
                <span className="landing-topnav-word-granite">GRANITE</span>
                {' '}
                CRAG
              </span>
            </a>
            <p className="landing-foot-tagline">
              Next-generation voice — built and operated by Granite
              Telecommunications.
            </p>
          </div>

          <nav className="landing-foot-nav" aria-label="Footer">
            <ul>
              {FOOTER_LINKS.map((l) => (
                <li key={l.target}>
                  <a
                    href={`#${l.target}`}
                    onClick={(e) => {
                      e.preventDefault();
                      scrollToId(l.target);
                    }}
                  >
                    {l.label}
                  </a>
                </li>
              ))}
              <li>
                <button type="button" onClick={() => setSignInOpen(true)}>
                  Sign in
                </button>
              </li>
            </ul>
          </nav>
        </div>

        <div className="landing-wrap landing-foot-bottom">
          <span>&copy; {new Date().getFullYear()} Granite Telecommunications</span>
          <span>CRAG — Call Routing Application Gateway</span>
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
