import { useNavigate } from 'react-router-dom';
import { cn } from '../utils/cn';

interface NavCard {
  title: string;
  description: string;
  path: string;
  accentColor: string;
  iconColor: string;
  glowColor: string;
  icon: string;
}

const NAV_CARDS: NavCard[] = [
  {
    title: 'Administration',
    description: 'Manage customers, billing, rates, and platform configuration.',
    path: '/admin',
    accentColor: '#3b82f6',
    iconColor: '#60a5fa',
    glowColor: 'rgba(59, 130, 246, 0.12)',
    icon: '⚙',
  },
  {
    title: 'RCF',
    description: 'Remote Call Forwarding — route DIDs to any destination instantly.',
    path: '/rcf',
    accentColor: '#22c55e',
    iconColor: '#4ade80',
    glowColor: 'rgba(34, 197, 94, 0.12)',
    icon: '⇋',
  },
  {
    title: 'API Calling',
    description: 'Programmable voice with webhook-driven call control.',
    path: '/api-dids',
    accentColor: '#a855f7',
    iconColor: '#c084fc',
    glowColor: 'rgba(168, 85, 247, 0.12)',
    icon: '❡',
  },
  {
    title: 'SIP Trunks',
    description: 'Connect PBX systems with IP-authenticated trunks.',
    path: '/trunks',
    accentColor: '#f59e0b',
    iconColor: '#fbbf24',
    glowColor: 'rgba(245, 158, 11, 0.12)',
    icon: '⇄',
  },
  {
    title: 'IVR Builder',
    description: 'Design call flows visually with drag-and-drop.',
    path: '/ivr',
    accentColor: '#06b6d4',
    iconColor: '#22d3ee',
    glowColor: 'rgba(6, 182, 212, 0.12)',
    icon: '▶',
  },
  {
    title: 'API Docs',
    description: 'Complete API reference and integration guide.',
    path: '/docs',
    accentColor: '#64748b',
    iconColor: '#94a3b8',
    glowColor: 'rgba(100, 116, 139, 0.12)',
    icon: '?',
  },
];

export function DashboardPage() {
  const navigate = useNavigate();

  return (
    <div className="max-w-5xl mx-auto">
      {/* Welcome section — centered */}
      <div className="text-center mb-12 animate-fade-in-up">
        <h1 className="text-2xl font-bold tracking-tight text-[#e2e8f0] leading-tight mb-2">
          Custom{' '}
          <span
            className="text-[#3b82f6]"
            style={{ textShadow: '0 0 24px rgba(59, 130, 246, 0.55)' }}
          >
            VoIP
          </span>{' '}
          Platform
        </h1>
        <p className="text-sm text-[#718096] leading-relaxed">
          Select a module below to get started
        </p>
      </div>

      {/* Navigation card grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {NAV_CARDS.map((card, i) => (
          <DashCard
            key={card.path}
            card={card}
            onClick={() => navigate(card.path)}
            style={{ animationDelay: `${i * 0.07}s` }}
          />
        ))}
      </div>
    </div>
  );
}

interface DashCardProps {
  card: NavCard;
  onClick: () => void;
  style?: React.CSSProperties;
}

function DashCard({ card, onClick, style }: DashCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={
        {
          '--glow': card.glowColor,
          '--accent': card.accentColor,
          ...style,
        } as React.CSSProperties
      }
      className={cn(
        'group text-left w-full',
        'relative flex flex-col',
        'bg-[#1a1d27] rounded-2xl',
        'border border-[#2a2f45]/50',
        'border-t-[2px]',
        'p-6',
        'min-h-[172px]',
        'cursor-pointer select-none',
        // Staggered entrance
        'animate-fade-in-up',
        // Hover: lift + glow + border brightens
        'transition-all duration-300 ease-out',
        'hover:-translate-y-1',
        'hover:border-[color:var(--accent)]/50',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]/50',
      )}
      // hover shadow applied inline because Tailwind arbitrary shadow with dynamic color isn't supported
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.boxShadow =
          `0 8px 30px ${card.glowColor}, 0 2px 8px rgba(0,0,0,0.4)`;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.boxShadow = '';
      }}
    >
      {/* Colored top accent border via inline style on the element itself */}
      <div
        className="absolute top-0 left-0 right-0 h-[2px] rounded-t-2xl"
        style={{ background: card.accentColor }}
      />

      {/* Icon */}
      <div
        className="text-3xl leading-none font-normal mb-4 flex-shrink-0 transition-transform duration-300 group-hover:scale-110"
        style={{ color: card.iconColor }}
        aria-hidden="true"
      >
        {card.icon}
      </div>

      {/* Title */}
      <span className="text-base font-semibold text-[#e2e8f0] tracking-tight leading-snug mb-2">
        {card.title}
      </span>

      {/* Description */}
      <p className="text-sm text-[#718096] leading-relaxed flex-1">
        {card.description}
      </p>

      {/* Separator + Open link */}
      <div className="mt-4 pt-4 border-t border-[#2a2f45]/60 flex justify-end">
        <span
          className={cn(
            'text-xs font-semibold tracking-wide',
            'transition-all duration-200',
            'group-hover:translate-x-0.5',
          )}
          style={{ color: card.accentColor, opacity: 0.75 }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLSpanElement).style.opacity = '1';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLSpanElement).style.opacity = '0.75';
          }}
        >
          Open &rsaquo;
        </span>
      </div>
    </button>
  );
}
