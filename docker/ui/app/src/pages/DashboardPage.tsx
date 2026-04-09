import { useNavigate } from 'react-router-dom';
import { cn } from '../utils/cn';

interface NavCard {
  title: string;
  description: string;
  path: string;
  accent: string;
  glow: string;
  icon: React.ReactNode;
}

/* ─── SVG Icons (Heroicons outline, 28×28) ──────────────── */

const IconAdmin = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-7 h-7">
    <path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7 7 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a7 7 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a7 7 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a7 7 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconRCF = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-7 h-7">
    <path d="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconAPI = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-7 h-7">
    <path d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconTrunk = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-7 h-7">
    <path d="M5.25 14.25h13.5m-13.5 0a3 3 0 0 1-3-3m3 3a3 3 0 1 0 0 6h13.5a3 3 0 1 0 0-6m-16.5-3a3 3 0 0 1 3-3h13.5a3 3 0 0 1 3 3m-19.5 0a4.5 4.5 0 0 1 .9-2.7L5.737 5.1a3.375 3.375 0 0 1 2.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 0 1 .9 2.7m0 0a3 3 0 0 1-3 3m0 3h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Zm-3 6h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconIVR = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-7 h-7">
    <path d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25a2.25 2.25 0 0 1-2.25-2.25v-2.25Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconDocs = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-7 h-7">
    <path d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const NAV_CARDS: NavCard[] = [
  {
    title: 'Administration',
    description: 'Manage customers, billing, rates, and platform configuration.',
    path: '/admin',
    accent: '#3b82f6',
    glow: 'rgba(59, 130, 246, 0.18)',
    icon: <IconAdmin />,
  },
  {
    title: 'RCF',
    description: 'Remote Call Forwarding — route DIDs to any destination instantly.',
    path: '/rcf',
    accent: '#22c55e',
    glow: 'rgba(34, 197, 94, 0.18)',
    icon: <IconRCF />,
  },
  {
    title: 'API Calling',
    description: 'Programmable voice with webhook-driven call control.',
    path: '/api-dids',
    accent: '#a855f7',
    glow: 'rgba(168, 85, 247, 0.18)',
    icon: <IconAPI />,
  },
  {
    title: 'SIP Trunks',
    description: 'Connect PBX systems with IP-authenticated trunks.',
    path: '/trunks',
    accent: '#f59e0b',
    glow: 'rgba(245, 158, 11, 0.18)',
    icon: <IconTrunk />,
  },
  {
    title: 'IVR Builder',
    description: 'Design call flows visually with drag-and-drop.',
    path: '/ivr',
    accent: '#06b6d4',
    glow: 'rgba(6, 182, 212, 0.18)',
    icon: <IconIVR />,
  },
  {
    title: 'API Docs',
    description: 'Complete API reference and integration guide.',
    path: '/docs',
    accent: '#94a3b8',
    glow: 'rgba(148, 163, 184, 0.12)',
    icon: <IconDocs />,
  },
];

export function DashboardPage() {
  const navigate = useNavigate();

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 'calc(100vh - 112px)', // 100vh minus AppLayout top+bottom padding (py-8 = 32px + pb-20 = 80px)
        width: '100%',
      }}
    >
      {/* Hero — big bold headline, zentra-style */}
      <div className="text-center animate-fade-in-up" style={{ marginBottom: 48 }}>
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

      {/* Card grid — fixed widths via flex for exact control */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          gap: 24,
          width: '100%',
          maxWidth: 1060,
        }}
      >
        {NAV_CARDS.map((card, i) => (
          <DashCard
            key={card.path}
            card={card}
            onClick={() => navigate(card.path)}
            delay={i * 0.08}
          />
        ))}
      </div>
    </div>
  );
}

interface DashCardProps {
  card: NavCard;
  onClick: () => void;
  delay: number;
}

function DashCard({ card, onClick, delay }: DashCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        animationDelay: `${delay}s`,
        // Flex basis: 3 cards per row with 24px gaps → (1060 - 48) / 3 ≈ 337
        flex: '0 1 320px',
        minHeight: 220,
      }}
      className={cn(
        'group relative text-left',
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
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = '';
      }}
    >
      {/* Background layer — gradient like zentra */}
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

      {/* Content — p-8 like zentra feature cards */}
      <div style={{ position: 'relative', zIndex: 1, padding: 32 }}>
        {/* Icon container — zentra style with gradient bg + border */}
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 24,
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
            fontSize: '1.125rem',
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
            marginBottom: 24,
          }}
        >
          {card.description}
        </p>

        {/* Footer — arrow link */}
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
            Open
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
