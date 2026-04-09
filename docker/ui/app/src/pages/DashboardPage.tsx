import { useNavigate } from 'react-router-dom';
import { cn } from '../utils/cn';

interface NavCard {
  title: string;
  description: string;
  path: string;
  accentColor: string;
  iconColor: string;
  /** Raw HTML entity or SVG path represented as a unicode char */
  icon: string;
}

const NAV_CARDS: NavCard[] = [
  {
    title: 'Administration',
    description: 'Manage customers, billing, rates, and platform configuration.',
    path: '/admin',
    accentColor: '#3b82f6',
    iconColor: '#60a5fa',
    icon: '\u2699', // gear ⚙
  },
  {
    title: 'RCF',
    description: 'Remote Call Forwarding — route DIDs to any destination.',
    path: '/rcf',
    accentColor: '#22c55e',
    iconColor: '#4ade80',
    icon: '\u21CB', // ⇋ left-right arrows
  },
  {
    title: 'API Calling',
    description: 'Programmable voice with webhook-driven call control.',
    path: '/api-dids',
    accentColor: '#a855f7',
    iconColor: '#c084fc',
    icon: '\u2761', // ❡ — using <> representation
  },
  {
    title: 'SIP Trunks',
    description: 'Connect PBX systems with IP-authenticated trunks.',
    path: '/trunks',
    accentColor: '#f59e0b',
    iconColor: '#fbbf24',
    icon: '\u21C4', // ⇄ left-right double arrow
  },
  {
    title: 'IVR Builder',
    description: 'Design call flows visually with drag-and-drop.',
    path: '/ivr',
    accentColor: '#06b6d4',
    iconColor: '#22d3ee',
    icon: '\u25B6', // ▶ play
  },
  {
    title: 'API Docs',
    description: 'Complete API reference and integration guide.',
    path: '/docs',
    accentColor: '#64748b',
    iconColor: '#94a3b8',
    icon: '\u2753', // ? help/question
  },
];

export function DashboardPage() {
  const navigate = useNavigate();

  return (
    <div>
      {/* Page heading */}
      <div className="mb-8 pb-5 border-b border-[#2a2f45]">
        <h1 className="text-[1.45rem] font-bold tracking-[-0.3px] text-[#e2e8f0] leading-tight">
          Custom <span className="text-[#3b82f6]">VoIP</span> Platform
        </h1>
        <p className="text-[0.82rem] text-[#718096] mt-1">
          Select a module to get started
        </p>
      </div>

      {/* 3×2 navigation card grid — constrained width, responsive columns */}
      <div className="max-w-7xl mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
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
        'relative flex flex-col gap-0',
        'bg-[#1a1d27] border border-[#2a2f45] rounded-[10px]',
        'border-t-2',
        'p-5 pb-4',
        'min-h-[148px]',
        'cursor-pointer select-none',
        'shadow-[0_1px_4px_rgba(0,0,0,.4),0_1px_2px_rgba(0,0,0,.3)]',
        'transition-[transform,box-shadow,border-color] duration-200',
        'hover:-translate-y-0.5 hover:shadow-[0_4px_16px_rgba(59,130,246,0.12)]',
        'hover:border-[#363c57]',
        'active:translate-y-0 active:transition-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3b82f6]/50',
      )}
      style={{ borderTopColor: card.accentColor }}
    >
      {/* Icon + title row */}
      <div className="flex items-center gap-2.5 mb-2">
        <span
          className="text-[1.5rem] leading-none font-normal flex-shrink-0"
          style={{ color: card.iconColor }}
          aria-hidden="true"
        >
          {card.icon}
        </span>
        <span className="text-[1rem] font-bold text-[#e2e8f0] tracking-[-0.1px]">
          {card.title}
        </span>
      </div>

      {/* Description */}
      <p className="text-[0.82rem] text-[#718096] leading-[1.5] flex-1 mb-3">
        {card.description}
      </p>

      {/* "Open ›" link */}
      <span
        className={cn(
          'block text-right text-[0.78rem] font-semibold',
          'text-[#3b82f6] opacity-75 tracking-[0.2px]',
          'transition-opacity duration-150',
          'group-hover:opacity-100',
        )}
      >
        Open &rsaquo;
      </span>
    </button>
  );
}
