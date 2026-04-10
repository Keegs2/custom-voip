import { useNavigate } from 'react-router-dom';
import { cn } from '../utils/cn';
import {
  IconRCF, IconTrunk, IconAPI, IconIVR, IconDocs,
  IconAdmin, IconSignal, IconTroubleshoot,
} from '../components/icons/ProductIcons';

/* ─── Types ──────────────────────────────────────────────── */

interface NavCard {
  title: string;
  description: string;
  path: string;
  accent: string;
  glow: string;
  icon: React.ReactNode;
  badge?: string;
  muted?: boolean;
  compact?: boolean;
}

/* ─── Card Definitions ───────────────────────────────────── */

const PRIMARY_CARDS: NavCard[] = [
  {
    title: 'RCF',
    description: 'Remote Call Forwarding — route DIDs to any destination instantly.',
    path: '/rcf',
    accent: '#22c55e',
    glow: 'rgba(34, 197, 94, 0.18)',
    icon: <IconRCF size={28} />,
  },
  {
    title: 'SIP Trunks',
    description: 'Connect PBX systems with IP-authenticated trunks.',
    path: '/trunks',
    accent: '#f59e0b',
    glow: 'rgba(245, 158, 11, 0.18)',
    icon: <IconTrunk size={28} />,
  },
];

const COMING_SOON_CARDS: NavCard[] = [
  {
    title: 'API Calling',
    description: 'Programmable voice with webhook-driven call control — coming soon.',
    path: '/api-dids',
    accent: '#a855f7',
    glow: 'rgba(168, 85, 247, 0.18)',
    icon: <IconAPI size={28} />,
    badge: 'Phase 2',
    muted: true,
  },
  {
    title: 'IVR Builder',
    description: 'Design call flows visually with drag-and-drop — coming soon.',
    path: '/ivr',
    accent: '#06b6d4',
    glow: 'rgba(6, 182, 212, 0.18)',
    icon: <IconIVR size={28} />,
    badge: 'Phase 2',
    muted: true,
  },
];

const UTILITY_CARDS: NavCard[] = [
  {
    title: 'Administration',
    description: 'Manage customers, billing, rates, and platform configuration.',
    path: '/admin',
    accent: '#3b82f6',
    glow: 'rgba(59, 130, 246, 0.18)',
    icon: <IconAdmin size={28} />,
    compact: true,
  },
  {
    title: 'Call Quality',
    description: 'Platform-wide SIP call quality analysis, RTP diagnostics, and MOS trends.',
    path: '/call-quality',
    accent: '#22c55e',
    glow: 'rgba(34, 197, 94, 0.15)',
    icon: <IconSignal size={28} />,
    compact: true,
  },
  {
    title: 'Troubleshooting',
    description: 'SIP capture, call flow analysis, and debugging.',
    path: '/troubleshooting',
    accent: '#f59e0b',
    glow: 'rgba(245, 158, 11, 0.15)',
    icon: <IconTroubleshoot size={28} />,
    compact: true,
  },
  {
    title: 'API Docs',
    description: 'Complete API reference and integration guide.',
    path: '/documentation',
    accent: '#94a3b8',
    glow: 'rgba(148, 163, 184, 0.12)',
    icon: <IconDocs size={28} />,
    compact: true,
  },
];

/* ─── Section Label ──────────────────────────────────────── */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: '0.65rem',
        fontWeight: 700,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: '#4a5568',
        marginBottom: 14,
      }}
    >
      {children}
    </div>
  );
}

/* ─── Phase 2 Badge ──────────────────────────────────────── */

function Phase2Badge({ accent }: { accent: string }) {
  return (
    <div
      style={{
        position: 'absolute',
        top: 16,
        right: 16,
        fontSize: '0.6rem',
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: accent,
        background: `${accent}18`,
        border: `1px solid ${accent}35`,
        borderRadius: 999,
        padding: '3px 9px',
        zIndex: 2,
        lineHeight: 1.5,
      }}
    >
      Phase 2
    </div>
  );
}

/* ─── DashCard ───────────────────────────────────────────── */

interface DashCardProps {
  card: NavCard;
  onClick: () => void;
  delay: number;
  /** Override flex-basis for the card */
  flexBasis?: string;
  /** Override minHeight for the card */
  minHeight?: number;
}

function DashCard({ card, onClick, delay, flexBasis = '420px', minHeight = 220 }: DashCardProps) {
  const padding = card.compact ? 22 : 32;

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        animationDelay: `${delay}s`,
        flex: `0 1 ${flexBasis}`,
        minHeight,
        opacity: card.muted ? 0.72 : 1,
        position: 'relative',
      }}
      className={cn(
        'group text-left',
        'rounded-2xl overflow-hidden',
        'cursor-pointer select-none',
        'animate-fade-in-up',
        'transition-all duration-300 ease-out',
        'hover:-translate-y-1.5',
        'focus-visible:outline-none',
      )}
      onMouseEnter={(e) => {
        const el = e.currentTarget;
        el.style.boxShadow = `0 0 0 1px ${card.accent}50, 0 25px 60px -15px ${card.glow}, 0 10px 24px -8px rgba(0,0,0,0.5)`;
        if (card.muted) el.style.opacity = '1';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = '';
        if (card.muted) e.currentTarget.style.opacity = '0.72';
      }}
    >
      {/* Badge */}
      {card.badge && <Phase2Badge accent={card.accent} />}

      {/* Background layer */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 16,
          background: 'linear-gradient(135deg, rgba(30, 33, 48, 0.9) 0%, rgba(19, 21, 29, 0.95) 100%)',
          border: '1px solid rgba(42, 47, 69, 0.6)',
          transition: 'border-color 0.3s',
        }}
        className="group-hover:!border-transparent"
      />

      {/* Hover gradient overlay */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 16,
          background: `linear-gradient(135deg, ${card.accent}18 0%, ${card.accent}05 100%)`,
          opacity: 0,
          transition: 'opacity 0.3s',
        }}
        className="group-hover:!opacity-100"
      />

      {/* Hover border */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 16,
          border: `1px solid ${card.accent}40`,
          opacity: 0,
          transition: 'opacity 0.3s',
          pointerEvents: 'none',
        }}
        className="group-hover:!opacity-100"
      />

      {/* Top accent gradient line */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 32,
          right: 32,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${card.accent}, transparent)`,
          opacity: 0.5,
          transition: 'opacity 0.3s',
        }}
        className="group-hover:!opacity-100"
      />

      {/* Content */}
      <div style={{ position: 'relative', zIndex: 1, padding }}>
        {/* Icon */}
        <div
          style={{
            width: card.compact ? 44 : 52,
            height: card.compact ? 44 : 52,
            borderRadius: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: card.compact ? 16 : 24,
            color: card.accent,
            background: `linear-gradient(135deg, ${card.accent}20 0%, ${card.accent}10 100%)`,
            border: `1px solid ${card.accent}30`,
            transition: 'transform 0.3s, box-shadow 0.3s',
          }}
          className="group-hover:scale-110"
        >
          {card.icon}
        </div>

        {/* Title */}
        <h3
          style={{
            fontSize: card.compact ? '1rem' : '1.125rem',
            fontWeight: 700,
            color: '#e2e8f0',
            letterSpacing: '-0.01em',
            marginBottom: 8,
          }}
        >
          {card.title}
        </h3>

        {/* Description */}
        <p
          style={{
            fontSize: '0.875rem',
            color: '#718096',
            lineHeight: 1.65,
            marginBottom: card.compact ? 16 : 24,
          }}
        >
          {card.description}
        </p>

        {/* Footer arrow */}
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          className="transition-all duration-200 group-hover:gap-3"
        >
          <span
            style={{
              fontSize: '0.8rem',
              fontWeight: 600,
              letterSpacing: '0.02em',
              color: card.accent,
              opacity: 0.7,
              transition: 'opacity 0.2s',
            }}
            className="group-hover:!opacity-100"
          >
            {card.muted ? 'Preview' : 'Open'}
          </span>
          <svg
            style={{ width: 14, height: 14, color: card.accent, opacity: 0.5, transition: 'all 0.2s' }}
            className="group-hover:!opacity-100 group-hover:translate-x-0.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
          </svg>
        </div>
      </div>
    </button>
  );
}

/* ─── Row wrapper ────────────────────────────────────────── */

function CardRow({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 24,
        width: '100%',
        maxWidth: 1060,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────── */

export function DashboardPage() {
  const navigate = useNavigate();

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        width: '100%',
        paddingTop: 52,
        paddingBottom: 64,
        paddingLeft: 24,
        paddingRight: 24,
        boxSizing: 'border-box',
      }}
    >
      {/* ── Page Header ── */}
      <div
        className="text-center animate-fade-in-up"
        style={{ marginBottom: 48, width: '100%', maxWidth: 1060 }}
      >
        <h1
          style={{
            fontSize: 'clamp(2.8rem, 5vw, 4.5rem)',
            fontWeight: 800,
            letterSpacing: '-0.025em',
            lineHeight: 1.1,
            marginBottom: 12,
          }}
        >
          <span style={{ color: '#e2e8f0' }}>Custom </span>
          <span
            style={{
              backgroundImage: 'linear-gradient(135deg, #3b82f6 0%, #60a5fa 50%, #93c5fd 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}
          >
            VoIP
          </span>
        </h1>
        <p style={{ fontSize: '1.125rem', color: '#718096', fontWeight: 500, letterSpacing: '0.02em' }}>
          Enterprise Voice Platform
        </p>
      </div>

      {/* ── Row 1: Primary Products ── */}
      <div style={{ width: '100%', maxWidth: 1060 }}>
        <SectionLabel>Products</SectionLabel>
        <CardRow>
          {PRIMARY_CARDS.map((card, i) => (
            <DashCard
              key={card.path}
              card={card}
              onClick={() => navigate(card.path)}
              delay={i * 0.08}
              flexBasis="calc(50% - 12px)"
              minHeight={240}
            />
          ))}
        </CardRow>
      </div>

      {/* ── Row 2: Coming Soon ── */}
      <div style={{ width: '100%', maxWidth: 1060, marginTop: 32 }}>
        <SectionLabel>Coming Soon</SectionLabel>
        <CardRow>
          {COMING_SOON_CARDS.map((card, i) => (
            <DashCard
              key={card.path}
              card={card}
              onClick={() => navigate(card.path)}
              delay={0.16 + i * 0.08}
              flexBasis="calc(50% - 12px)"
              minHeight={200}
            />
          ))}
        </CardRow>
      </div>

      {/* ── Row 3: Utilities ── */}
      <div style={{ width: '100%', maxWidth: 1060, marginTop: 32 }}>
        <SectionLabel>Tools</SectionLabel>
        <CardRow>
          {UTILITY_CARDS.map((card, i) => (
            <DashCard
              key={card.path}
              card={card}
              onClick={() => navigate(card.path)}
              delay={0.32 + i * 0.08}
              flexBasis="calc(50% - 12px)"
              minHeight={150}
            />
          ))}
        </CardRow>
      </div>
    </div>
  );
}
