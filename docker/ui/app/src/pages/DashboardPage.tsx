import { useNavigate } from 'react-router-dom';
import { cn } from '../utils/cn';

interface NavCard {
  title: string;
  description: string;
  path: string;
  accentColor: string;
  iconColor: string;
  icon: string;
}

const NAV_CARDS: NavCard[] = [
  {
    title: 'Administration',
    description: 'Manage customers, billing, rates, and platform configuration.',
    path: '/admin',
    accentColor: '#3b82f6',
    iconColor: '#60a5fa',
    icon: '\u2699',
  },
  {
    title: 'RCF',
    description: 'Remote Call Forwarding — route DIDs to any destination.',
    path: '/rcf',
    accentColor: '#22c55e',
    iconColor: '#4ade80',
    icon: '\u21CB',
  },
  {
    title: 'API Calling',
    description: 'Programmable voice with webhook-driven call control.',
    path: '/api-dids',
    accentColor: '#a855f7',
    iconColor: '#c084fc',
    icon: '\u2761',
  },
  {
    title: 'SIP Trunks',
    description: 'Connect PBX systems with IP-authenticated trunks.',
    path: '/trunks',
    accentColor: '#f59e0b',
    iconColor: '#fbbf24',
    icon: '\u21C4',
  },
  {
    title: 'IVR Builder',
    description: 'Design call flows visually with drag-and-drop.',
    path: '/ivr',
    accentColor: '#06b6d4',
    iconColor: '#22d3ee',
    icon: '\u25B6',
  },
  {
    title: 'API Docs',
    description: 'Complete API reference and integration guide.',
    path: '/docs',
    accentColor: '#64748b',
    iconColor: '#94a3b8',
    icon: '\u2753',
  },
];

export function DashboardPage() {
  const navigate = useNavigate();

  return (
    <div>
      {/* Page heading */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight text-[#e2e8f0] leading-tight">
          Custom <span className="text-[#3b82f6]">VoIP</span> Platform
        </h1>
        <p className="text-sm text-[#718096] mt-1.5">
          Select a module to get started
        </p>
      </div>

      {/* Navigation card grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-5">
        {NAV_CARDS.map((card) => (
          <DashCard
            key={card.path}
            card={card}
            onClick={() => navigate(card.path)}
          />
        ))}
      </div>
    </div>
  );
}

interface DashCardProps {
  card: NavCard;
  onClick: () => void;
}

function DashCard({ card, onClick }: DashCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group text-left w-full',
        'relative flex flex-col',
        'bg-[#1a1d27] border border-[#2a2f45]/80 rounded-xl',
        'border-t-2',
        'p-5',
        'min-h-[140px]',
        'cursor-pointer select-none',
        'shadow-[0_1px_3px_rgba(0,0,0,.4)]',
        'transition-all duration-200',
        'hover:-translate-y-0.5 hover:shadow-[0_6px_20px_rgba(0,0,0,.3)] hover:border-[#363c57]',
        'active:translate-y-0 active:transition-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3b82f6]/50',
      )}
      style={{ borderTopColor: card.accentColor }}
    >
      {/* Icon + title row */}
      <div className="flex items-center gap-2.5 mb-3">
        <span
          className="text-2xl leading-none font-normal flex-shrink-0"
          style={{ color: card.iconColor }}
          aria-hidden="true"
        >
          {card.icon}
        </span>
        <span className="text-[0.95rem] font-bold text-[#e2e8f0] tracking-tight">
          {card.title}
        </span>
      </div>

      {/* Description */}
      <p className="text-[0.82rem] text-[#718096] leading-relaxed flex-1">
        {card.description}
      </p>

      {/* "Open ›" link — bottom-right */}
      <div className="flex justify-end mt-3 pt-3 border-t border-[#2a2f45]/60">
        <span
          className={cn(
            'text-xs font-semibold',
            'text-[#3b82f6]/70 tracking-wide',
            'transition-all duration-150',
            'group-hover:text-[#3b82f6] group-hover:translate-x-0.5',
          )}
        >
          Open &rsaquo;
        </span>
      </div>
    </button>
  );
}
