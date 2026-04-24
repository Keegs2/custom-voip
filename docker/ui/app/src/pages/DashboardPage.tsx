import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Shield, Zap, Globe, Activity, PhoneForwarded, Phone, Code, Voicemail } from 'lucide-react';
import { HaArchitectureViz } from '../components/layout/HaArchitectureViz';

/* ─── Capability card data ───────────────────────────────── */

interface CapabilityCard {
  icon: React.ReactNode;
  title: string;
  description: string;
  animDelay: string;
}

const CAPABILITY_CARDS: CapabilityCard[] = [
  {
    icon: <Globe size={22} strokeWidth={1.75} />,
    title: 'Multi-Zone Redundancy',
    description:
      'Three availability zones with active traffic distribution. Calls route to the nearest healthy zone. If a zone becomes unavailable, traffic fails over automatically — no manual intervention, no hardware swap.',
    animDelay: '0.2s',
  },
  {
    icon: <Zap size={22} strokeWidth={1.75} />,
    title: 'Purpose-Built SIP Architecture',
    description:
      'Multi-layer SIP proxy design with sub-10ms latency to signaling endpoints. Intelligent session management handles timer negotiation automatically. SRTP-ready media paths and STIR/SHAKEN attestation on every call.',
    animDelay: '0.4s',
  },
  {
    icon: <Shield size={22} strokeWidth={1.75} />,
    title: '99.999% Uptime Target',
    description:
      'Dual SBC layer fronted by network load balancers with continuous health monitoring. Failed components are detected and bypassed in under 15 seconds. Self-healing by design.',
    animDelay: '0.6s',
  },
  {
    icon: <Activity size={22} strokeWidth={1.75} />,
    title: 'Intelligent Call Routing',
    description:
      'Every call passes through a proprietary routing engine with real-time fraud detection, velocity limiting, and quality analysis. MOS scoring is captured per session for full visibility.',
    animDelay: '0.8s',
  },
];

/* ─── Product card data ──────────────────────────────────── */

interface ProductCard {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  active: boolean;
  route?: string;
  animDelay: string;
}

const PRODUCT_CARDS: ProductCard[] = [
  {
    icon: <PhoneForwarded size={20} strokeWidth={1.75} />,
    title: 'Remote Call Forwarding',
    subtitle: 'Intelligent DID forwarding with multi-zone redundancy',
    active: true,
    route: '/rcf',
    animDelay: '0.1s',
  },
  {
    icon: <Phone size={20} strokeWidth={1.75} />,
    title: 'SIP Trunking',
    subtitle: 'Enterprise SIP connectivity',
    active: false,
    animDelay: '0.2s',
  },
  {
    icon: <Code size={20} strokeWidth={1.75} />,
    title: 'API Calling',
    subtitle: 'Programmable voice via webhooks',
    active: false,
    animDelay: '0.3s',
  },
  {
    icon: <Voicemail size={20} strokeWidth={1.75} />,
    title: 'Voicemail',
    subtitle: 'Visual voicemail with transcription',
    active: false,
    animDelay: '0.4s',
  },
];

/* ─── CapabilityCardEl ───────────────────────────────────── */

function CapabilityCardEl({ card }: { card: CapabilityCard }) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="animate-fade-in-up"
      style={{
        animationDelay: card.animDelay,
        position: 'relative',
        background: 'rgba(19, 21, 29, 0.70)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        border: `1px solid ${hovered ? 'rgba(59,130,246,0.30)' : 'rgba(59,130,246,0.12)'}`,
        borderRadius: 20,
        padding: '22px 22px 20px',
        transition: 'border-color 0.25s ease, box-shadow 0.25s ease',
        boxShadow: hovered
          ? '0 0 0 1px rgba(59,130,246,0.18), 0 20px 50px -12px rgba(0,0,0,0.55)'
          : '0 4px 20px -6px rgba(0,0,0,0.4)',
        overflow: 'hidden',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Top accent line — visible on hover */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 28,
          right: 28,
          height: 2,
          background:
            'linear-gradient(90deg, transparent, rgba(59,130,246,0.8), transparent)',
          opacity: hovered ? 1 : 0,
          transition: 'opacity 0.25s ease',
          borderRadius: '0 0 2px 2px',
        }}
      />

      {/* Icon container */}
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 14,
          color: hovered ? '#60a5fa' : '#3b82f6',
          background: hovered
            ? 'linear-gradient(135deg, rgba(59,130,246,0.22) 0%, rgba(59,130,246,0.10) 100%)'
            : 'linear-gradient(135deg, rgba(59,130,246,0.14) 0%, rgba(59,130,246,0.06) 100%)',
          border: `1px solid ${hovered ? 'rgba(59,130,246,0.35)' : 'rgba(59,130,246,0.20)'}`,
          transition: 'background 0.25s ease, border-color 0.25s ease, color 0.25s ease',
        }}
      >
        {card.icon}
      </div>

      <h3
        style={{
          fontSize: '1rem',
          fontWeight: 700,
          color: '#e2e8f0',
          letterSpacing: '-0.01em',
          marginBottom: 10,
        }}
      >
        {card.title}
      </h3>

      <p
        style={{
          fontSize: '0.8rem',
          color: '#718096',
          lineHeight: 1.65,
        }}
      >
        {card.description}
      </p>
    </div>
  );
}

/* ─── ProductCardEl ──────────────────────────────────────── */

function ProductCardEl({ card }: { card: ProductCard }) {
  const [hovered, setHovered] = useState(false);
  const navigate = useNavigate();

  function handleClick() {
    if (card.active && card.route) {
      navigate(card.route);
    }
  }

  if (card.active) {
    return (
      <div
        className="animate-fade-in-up"
        style={{
          animationDelay: card.animDelay,
          flex: 1,
          position: 'relative',
          background: 'rgba(19, 21, 29, 0.70)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          border: `1px solid ${hovered ? 'rgba(59,130,246,0.45)' : 'rgba(59,130,246,0.28)'}`,
          borderRadius: 16,
          padding: '20px',
          cursor: 'pointer',
          transition: 'border-color 0.22s ease, box-shadow 0.22s ease, transform 0.18s ease',
          boxShadow: hovered
            ? '0 0 0 1px rgba(59,130,246,0.22), 0 0 28px -6px rgba(59,130,246,0.25), 0 12px 32px -10px rgba(0,0,0,0.5)'
            : '0 0 16px -6px rgba(59,130,246,0.12), 0 4px 16px -4px rgba(0,0,0,0.35)',
          transform: hovered ? 'translateY(-2px)' : 'translateY(0)',
          overflow: 'hidden',
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={handleClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick(); }}
      >
        {/* Top accent line */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 16,
            right: 16,
            height: 2,
            background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.9), transparent)',
            opacity: hovered ? 1 : 0.4,
            transition: 'opacity 0.22s ease',
            borderRadius: '0 0 2px 2px',
          }}
        />

        {/* Header row: icon + active badge */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 10,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: hovered ? '#93c5fd' : '#60a5fa',
              background: hovered
                ? 'linear-gradient(135deg, rgba(59,130,246,0.28) 0%, rgba(59,130,246,0.12) 100%)'
                : 'linear-gradient(135deg, rgba(59,130,246,0.18) 0%, rgba(59,130,246,0.08) 100%)',
              border: `1px solid ${hovered ? 'rgba(59,130,246,0.45)' : 'rgba(59,130,246,0.28)'}`,
              transition: 'background 0.22s ease, border-color 0.22s ease, color 0.22s ease',
              flexShrink: 0,
            }}
          >
            {card.icon}
          </div>

          {/* Active badge */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              background: 'rgba(59,130,246,0.12)',
              border: '1px solid rgba(59,130,246,0.30)',
              borderRadius: 20,
              padding: '3px 8px',
            }}
          >
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: '#3b82f6',
                boxShadow: '0 0 6px rgba(59,130,246,0.8)',
              }}
            />
            <span
              style={{
                fontSize: '0.6rem',
                fontWeight: 700,
                color: '#60a5fa',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}
            >
              Active
            </span>
          </div>
        </div>

        <div
          style={{
            fontSize: '0.85rem',
            fontWeight: 700,
            color: '#e2e8f0',
            letterSpacing: '-0.01em',
            marginBottom: 5,
          }}
        >
          {card.title}
        </div>
        <div
          style={{
            fontSize: '0.72rem',
            color: '#64748b',
            lineHeight: 1.5,
          }}
        >
          {card.subtitle}
        </div>
      </div>
    );
  }

  /* Coming soon card */
  return (
    <div
      className="animate-fade-in-up"
      style={{
        animationDelay: card.animDelay,
        flex: 1,
        position: 'relative',
        background: 'rgba(19, 21, 29, 0.70)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        border: '1px solid rgba(59,130,246,0.08)',
        borderRadius: 16,
        padding: '20px',
        cursor: 'default',
        opacity: 0.45,
        overflow: 'hidden',
      }}
    >
      {/* Header row: icon + soon badge */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#94a3b8',
            background: 'rgba(148,163,184,0.08)',
            border: '1px solid rgba(148,163,184,0.14)',
            flexShrink: 0,
          }}
        >
          {card.icon}
        </div>

        {/* Soon badge */}
        <div
          style={{
            background: 'rgba(168,85,247,0.12)',
            border: '1px solid rgba(168,85,247,0.22)',
            borderRadius: 20,
            padding: '3px 8px',
          }}
        >
          <span
            style={{
              fontSize: '0.6rem',
              fontWeight: 700,
              color: '#c084fc',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            Soon
          </span>
        </div>
      </div>

      <div
        style={{
          fontSize: '0.85rem',
          fontWeight: 700,
          color: '#e2e8f0',
          letterSpacing: '-0.01em',
          marginBottom: 5,
        }}
      >
        {card.title}
      </div>
      <div
        style={{
          fontSize: '0.72rem',
          color: '#64748b',
          lineHeight: 1.5,
        }}
      >
        {card.subtitle}
      </div>
    </div>
  );
}

/* ─── Section label ──────────────────────────────────────── */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: '0.62rem',
        fontWeight: 700,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: '#3b82f6',
        marginBottom: 20,
        opacity: 0.75,
      }}
    >
      {children}
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────── */

export function DashboardPage() {
  return (
    <div style={{ minHeight: '100vh' }}>
      {/* Page content — single column, centered */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          width: '100%',
          paddingLeft: 24,
          paddingRight: 24,
          paddingTop: 72,
          paddingBottom: 80,
          boxSizing: 'border-box',
        }}
      >
        {/* ──────────────────────────────────────────────────── */}
        {/* HERO SECTION                                         */}
        {/* ──────────────────────────────────────────────────── */}
        <div
          className="animate-fade-in-up"
          style={{
            textAlign: 'center',
            marginBottom: 56,
            width: '100%',
            maxWidth: 760,
          }}
        >
          {/* Keystone branded image with scan-line overlay */}
          {/*
            Two-layer structure:
            - .dash-keystone-hero-wrap  → outer; handles hover scale via CSS transition
            - img.dash-keystone-hero    → inner; owns glow + float animation, never paused
            Keeping them on separate elements prevents the animation transform and the
            hover scale transform from fighting on the same CSS property.
          */}
          <div
            className="dash-keystone-hero-wrap"
            style={{
              position: 'relative',
              marginBottom: 32,
              overflow: 'hidden',
              borderRadius: 16,
            }}
          >
            <img
              src="/keystone_image.png"
              alt="Granite Keystone — Distributed Voice Infrastructure"
              className="dash-keystone-hero"
              style={{
                width: 320,
                height: 'auto',
                display: 'block',
              }}
            />
            {/* Scan-line overlay */}
            <div
              className="dash-scan-line"
              style={{
                position: 'absolute',
                inset: 0,
                background:
                  'linear-gradient(180deg, transparent 0%, rgba(96,165,250,0.06) 50%, transparent 100%)',
                pointerEvents: 'none',
              }}
            />
          </div>

          {/* Tagline */}
          <h1
            className="animate-fade-in-up animation-delay-200"
            style={{
              fontSize: 'clamp(1.5rem, 3.5vw, 2.1rem)',
              fontWeight: 800,
              color: '#e2e8f0',
              letterSpacing: '-0.03em',
              lineHeight: 1.2,
              marginBottom: 16,
            }}
          >
            <span style={{ color: '#3b82f6' }}>Distributed</span>{' '}
            Voice Infrastructure.{' '}
            <br />
            Built for the Enterprise.
          </h1>

          {/* Subtitle */}
          <p
            className="animate-fade-in-up animation-delay-400"
            style={{
              fontSize: '1rem',
              color: '#718096',
              lineHeight: 1.75,
              maxWidth: 600,
              margin: '0 auto',
            }}
          >
            Port your numbers. Configure your rules. Route every call through
            carrier-grade infrastructure with automatic failover across three
            availability zones.
          </p>
        </div>

        {/* ──────────────────────────────────────────────────── */}
        {/* PRODUCTS — 4 horizontal cards                        */}
        {/* ──────────────────────────────────────────────────── */}
        <div
          style={{
            width: '100%',
            maxWidth: 1400,
            marginBottom: 48,
          }}
        >
          <div className="animate-fade-in-up animation-delay-200">
            <SectionLabel>Products</SectionLabel>
          </div>

          <div
            style={{
              display: 'flex',
              gap: 16,
            }}
          >
            {PRODUCT_CARDS.map((card) => (
              <ProductCardEl key={card.title} card={card} />
            ))}
          </div>
        </div>

        {/* ──────────────────────────────────────────────────── */}
        {/* HA ARCHITECTURE VISUALIZATION                        */}
        {/* ──────────────────────────────────────────────────── */}
        <div
          className="animate-fade-in-up animation-delay-600"
          style={{ width: '100%', maxWidth: 1400 }}
        >
          <HaArchitectureViz />
        </div>

        {/* ──────────────────────────────────────────────────── */}
        {/* PLATFORM CAPABILITIES — 2×2 glass-morphism grid     */}
        {/* ──────────────────────────────────────────────────── */}
        <div
          style={{
            width: '100%',
            maxWidth: 1400,
            marginBottom: 72,
          }}
        >
          <div className="animate-fade-in-up animation-delay-200">
            <SectionLabel>Platform Capabilities</SectionLabel>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 20,
            }}
          >
            {CAPABILITY_CARDS.map((card) => (
              <CapabilityCardEl key={card.title} card={card} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
