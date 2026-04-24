import { useState } from 'react';
import { Shield, Zap, Globe, Activity } from 'lucide-react';
import { AnimatedGridBackground } from '../components/layout/AnimatedGridBackground';

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
    title: 'Carrier-Grade Infrastructure',
    description:
      'Enterprise SIP architecture engineered for sub-10ms latency to carrier Points of Presence. Session timer management, SRTP-ready media paths, and STIR/SHAKEN call attestation on every session.',
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

/* ─── How it works steps ─────────────────────────────────── */

interface Step {
  number: string;
  title: string;
  description: string;
  animDelay: string;
}

const HOW_IT_WORKS: Step[] = [
  {
    number: '01',
    title: 'Provision Numbers',
    description:
      'Port existing DIDs or provision new numbers directly through the platform. No carrier coordination required.',
    animDelay: '0.3s',
  },
  {
    number: '02',
    title: 'Configure Routing',
    description:
      'Set forwarding rules with instant activation. Point to any PSTN number or SIP endpoint — no hardware, no reboots.',
    animDelay: '0.5s',
  },
  {
    number: '03',
    title: 'Monitor in Real Time',
    description:
      'Every call is logged with quality metrics. Drill into MOS scores, packet loss, and jitter from the Call Quality dashboard.',
    animDelay: '0.7s',
  },
];

/* ─── Stat bar data ──────────────────────────────────────── */

interface Stat {
  value: string;
  label: string;
  animDelay: string;
}

const STATS: Stat[] = [
  { value: '3',        label: 'Availability Zones',   animDelay: '0.2s' },
  { value: '< 15s',   label: 'Automatic Failover',    animDelay: '0.35s' },
  { value: '99.999%', label: 'Uptime Target',          animDelay: '0.5s' },
  { value: 'Sub-10ms',label: 'Carrier PoP Latency',   animDelay: '0.65s' },
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
        padding: '28px 28px 24px',
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
          width: 48,
          height: 48,
          borderRadius: 13,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 18,
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
          fontSize: '0.85rem',
          color: '#718096',
          lineHeight: 1.7,
        }}
      >
        {card.description}
      </p>
    </div>
  );
}

/* ─── StepEl ─────────────────────────────────────────────── */

function StepEl({ step, isLast }: { step: Step; isLast: boolean }) {
  return (
    <div
      className="animate-fade-in-up"
      style={{
        animationDelay: step.animDelay,
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        position: 'relative',
      }}
    >
      {/* Connector line between steps */}
      {!isLast && (
        <div
          style={{
            position: 'absolute',
            top: 21,
            left: 'calc(44px + 16px)',
            right: -16,
            height: 1,
            background:
              'linear-gradient(90deg, rgba(59,130,246,0.25) 0%, rgba(59,130,246,0.05) 100%)',
            zIndex: 0,
          }}
        />
      )}

      {/* Step number badge */}
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: '50%',
          border: '1.5px solid rgba(59,130,246,0.40)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 18,
          background: 'rgba(59,130,246,0.08)',
          position: 'relative',
          zIndex: 1,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: '0.7rem',
            fontWeight: 800,
            color: '#3b82f6',
            letterSpacing: '0.04em',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {step.number}
        </span>
      </div>

      <h4
        style={{
          fontSize: '0.95rem',
          fontWeight: 700,
          color: '#e2e8f0',
          letterSpacing: '-0.01em',
          marginBottom: 8,
        }}
      >
        {step.title}
      </h4>

      <p
        style={{
          fontSize: '0.83rem',
          color: '#718096',
          lineHeight: 1.7,
          maxWidth: 280,
        }}
      >
        {step.description}
      </p>
    </div>
  );
}

/* ─── StatCardEl ─────────────────────────────────────────── */

function StatCardEl({ stat }: { stat: Stat }) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="animate-fade-in-up"
      style={{
        animationDelay: stat.animDelay,
        flex: 1,
        minWidth: 120,
        background: 'rgba(19, 21, 29, 0.65)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        border: `1px solid ${hovered ? 'rgba(59,130,246,0.25)' : 'rgba(59,130,246,0.10)'}`,
        borderRadius: 16,
        padding: '20px 18px',
        textAlign: 'center',
        transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
        boxShadow: hovered ? '0 0 24px -6px rgba(59,130,246,0.18)' : 'none',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        style={{
          fontSize: '2rem',
          fontWeight: 800,
          color: '#3b82f6',
          lineHeight: 1.1,
          letterSpacing: '-0.03em',
          fontVariantNumeric: 'tabular-nums',
          marginBottom: 6,
        }}
      >
        {stat.value}
      </div>
      <div
        style={{
          fontSize: '0.7rem',
          fontWeight: 600,
          color: '#475569',
          textTransform: 'uppercase',
          letterSpacing: '0.09em',
          lineHeight: 1.4,
        }}
      >
        {stat.label}
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
    <div style={{ position: 'relative', minHeight: '100vh' }}>
      {/* Animated grid — z-0, behind all content */}
      <AnimatedGridBackground
        gridSize={56}
        dotsPerSide={8}
        gridOpacity={0.06}
        showGlow={true}
      />

      {/* All content floats above the grid */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
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
            marginBottom: 72,
            width: '100%',
            maxWidth: 760,
          }}
        >
          {/* Keystone branded image with scan-line overlay */}
          <div
            style={{
              position: 'relative',
              display: 'inline-block',
              marginBottom: 32,
              overflow: 'hidden',
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
        {/* PLATFORM CAPABILITIES — 2×2 glass-morphism grid     */}
        {/* ──────────────────────────────────────────────────── */}
        <div
          style={{
            width: '100%',
            maxWidth: 1000,
            marginBottom: 72,
          }}
        >
          <div className="animate-fade-in-up animation-delay-200">
            <SectionLabel>Platform Capabilities</SectionLabel>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
              gap: 20,
            }}
          >
            {CAPABILITY_CARDS.map((card) => (
              <CapabilityCardEl key={card.title} card={card} />
            ))}
          </div>
        </div>

        {/* ──────────────────────────────────────────────────── */}
        {/* HOW IT WORKS — 3 horizontal steps                   */}
        {/* ──────────────────────────────────────────────────── */}
        <div
          style={{
            width: '100%',
            maxWidth: 1000,
            marginBottom: 72,
          }}
        >
          <div className="animate-fade-in-up animation-delay-200">
            <SectionLabel>How It Works</SectionLabel>
          </div>

          <div
            style={{
              display: 'flex',
              gap: 32,
              flexWrap: 'wrap',
            }}
          >
            {HOW_IT_WORKS.map((step, idx) => (
              <StepEl
                key={step.number}
                step={step}
                isLast={idx === HOW_IT_WORKS.length - 1}
              />
            ))}
          </div>
        </div>

        {/* ──────────────────────────────────────────────────── */}
        {/* STATS BAR — 4 glass-morphism stat cards             */}
        {/* ──────────────────────────────────────────────────── */}
        <div
          style={{
            width: '100%',
            maxWidth: 1000,
          }}
        >
          <div className="animate-fade-in-up animation-delay-200">
            <SectionLabel>By the Numbers</SectionLabel>
          </div>

          <div
            style={{
              display: 'flex',
              gap: 16,
              flexWrap: 'wrap',
            }}
          >
            {STATS.map((stat) => (
              <StatCardEl key={stat.label} stat={stat} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
