import { useNavigate } from 'react-router-dom';
import { cn } from '../utils/cn';

interface NavCard {
  title: string;
  description: string;
  path: string;
  accent: string;
  glow: string;
  gradient: string;
  icon: React.ReactNode;
}

/* ─── SVG Icons (crisp at any size) ─────────────────────── */

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
    glow: 'rgba(59, 130, 246, 0.15)',
    gradient: 'linear-gradient(135deg, rgba(59, 130, 246, 0.12) 0%, rgba(59, 130, 246, 0.03) 100%)',
    icon: <IconAdmin />,
  },
  {
    title: 'RCF',
    description: 'Remote Call Forwarding — route DIDs to any destination instantly.',
    path: '/rcf',
    accent: '#22c55e',
    glow: 'rgba(34, 197, 94, 0.15)',
    gradient: 'linear-gradient(135deg, rgba(34, 197, 94, 0.12) 0%, rgba(34, 197, 94, 0.03) 100%)',
    icon: <IconRCF />,
  },
  {
    title: 'API Calling',
    description: 'Programmable voice with webhook-driven call control.',
    path: '/api-dids',
    accent: '#a855f7',
    glow: 'rgba(168, 85, 247, 0.15)',
    gradient: 'linear-gradient(135deg, rgba(168, 85, 247, 0.12) 0%, rgba(168, 85, 247, 0.03) 100%)',
    icon: <IconAPI />,
  },
  {
    title: 'SIP Trunks',
    description: 'Connect PBX systems with IP-authenticated trunks.',
    path: '/trunks',
    accent: '#f59e0b',
    glow: 'rgba(245, 158, 11, 0.15)',
    gradient: 'linear-gradient(135deg, rgba(245, 158, 11, 0.12) 0%, rgba(245, 158, 11, 0.03) 100%)',
    icon: <IconTrunk />,
  },
  {
    title: 'IVR Builder',
    description: 'Design call flows visually with drag-and-drop.',
    path: '/ivr',
    accent: '#06b6d4',
    glow: 'rgba(6, 182, 212, 0.15)',
    gradient: 'linear-gradient(135deg, rgba(6, 182, 212, 0.12) 0%, rgba(6, 182, 212, 0.03) 100%)',
    icon: <IconIVR />,
  },
  {
    title: 'API Docs',
    description: 'Complete API reference and integration guide.',
    path: '/docs',
    accent: '#94a3b8',
    glow: 'rgba(148, 163, 184, 0.12)',
    gradient: 'linear-gradient(135deg, rgba(148, 163, 184, 0.08) 0%, rgba(148, 163, 184, 0.02) 100%)',
    icon: <IconDocs />,
  },
];

export function DashboardPage() {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-64px)] -mt-8">
      {/* Hero section — centered, zentra-style big typography */}
      <div className="text-center mb-16 animate-fade-in-up">
        <h1 className="text-5xl md:text-6xl lg:text-7xl font-extrabold tracking-tight leading-none mb-4">
          <span className="text-[#e2e8f0]">Custom </span>
          <span
            className="bg-clip-text text-transparent"
            style={{
              backgroundImage: 'linear-gradient(135deg, #3b82f6 0%, #60a5fa 50%, #93c5fd 100%)',
              backgroundSize: '200% auto',
            }}
          >
            VoIP
          </span>
        </h1>
        <p className="text-lg md:text-xl text-[#718096] font-medium tracking-wide">
          Enterprise Voice Platform
        </p>
      </div>

      {/* Navigation card grid — 2 cols on md, 3 cols on lg */}
      <div className="w-full max-w-5xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 md:gap-6">
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
      style={{ animationDelay: `${delay}s` }}
      className={cn(
        'group relative text-left w-full',
        'rounded-2xl overflow-hidden',
        'p-7 pb-6',
        'cursor-pointer select-none',
        'animate-fade-in-up',
        'transition-all duration-300 ease-out',
        'hover:-translate-y-1.5',
        'focus-visible:outline-none',
      )}
      onMouseEnter={(e) => {
        const el = e.currentTarget;
        el.style.boxShadow = `0 0 0 1px ${card.accent}40, 0 20px 50px -12px ${card.glow}, 0 8px 20px -8px rgba(0,0,0,0.5)`;
        el.style.borderColor = `${card.accent}50`;
        el.style.background = card.gradient;
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget;
        el.style.boxShadow = '';
        el.style.borderColor = '';
        el.style.background = '';
      }}
    >
      {/* Base background + border */}
      <div
        className="absolute inset-0 rounded-2xl border border-[#2a2f45]/60 bg-[#13151d] transition-colors duration-300 group-hover:border-transparent"
        style={{ zIndex: 0 }}
      />

      {/* Top accent line */}
      <div
        className="absolute top-0 left-6 right-6 h-[2px] opacity-60 group-hover:opacity-100 transition-opacity duration-300"
        style={{ background: `linear-gradient(90deg, transparent, ${card.accent}, transparent)` }}
      />

      {/* Content */}
      <div className="relative z-10">
        {/* Icon circle */}
        <div
          className="w-12 h-12 rounded-xl flex items-center justify-center mb-5 transition-all duration-300 group-hover:scale-110 group-hover:shadow-lg"
          style={{
            background: `${card.accent}15`,
            color: card.accent,
            boxShadow: `0 0 0 1px ${card.accent}20`,
          }}
          onMouseEnter={() => {}}
        >
          {card.icon}
        </div>

        {/* Title */}
        <h3
          className="text-lg font-bold text-[#e2e8f0] tracking-tight mb-2 transition-colors duration-200"
          style={{}}
        >
          {card.title}
        </h3>

        {/* Description */}
        <p className="text-sm text-[#718096] leading-relaxed mb-6">
          {card.description}
        </p>

        {/* Footer arrow */}
        <div className="flex items-center gap-1.5 transition-all duration-200 group-hover:gap-3">
          <span
            className="text-xs font-semibold tracking-wide opacity-70 group-hover:opacity-100 transition-opacity duration-200"
            style={{ color: card.accent }}
          >
            Open
          </span>
          <svg
            className="w-3.5 h-3.5 opacity-50 group-hover:opacity-100 transition-all duration-200 group-hover:translate-x-0.5"
            style={{ color: card.accent }}
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
