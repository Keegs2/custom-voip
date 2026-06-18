import { useNavigate } from 'react-router-dom';

/* ─── Keyframe injection ─────────────────────────────────── */

const GLOBAL_STYLES = `
  @keyframes commFadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
`;

function injectStyles() {
  if (typeof document !== 'undefined' && !document.getElementById('comm-page-styles')) {
    const tag = document.createElement('style');
    tag.id = 'comm-page-styles';
    tag.textContent = GLOBAL_STYLES;
    document.head.appendChild(tag);
  }
}
injectStyles();

/* ─── Icons ──────────────────────────────────────────────── */

const IconHeadset = ({ size = 32, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={1.6}
    style={{ width: size, height: size }}
  >
    <path
      d="M3.75 13.5a8.25 8.25 0 0 1 16.5 0"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M3.75 13.5A2.25 2.25 0 0 0 1.5 15.75v1.5A2.25 2.25 0 0 0 3.75 19.5h.75V13.5h-.75ZM20.25 13.5A2.25 2.25 0 0 1 22.5 15.75v1.5A2.25 2.25 0 0 1 20.25 19.5H19.5V13.5h.75Z"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const IconChat = ({ size = 28, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={1.6}
    style={{ width: size, height: size }}
  >
    <path
      d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const IconVideo = ({ size = 28, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={1.6}
    style={{ width: size, height: size }}
  >
    <path
      d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const IconFolder = ({ size = 28, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={1.6}
    style={{ width: size, height: size }}
  >
    <path
      d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v8.25A2.25 2.25 0 0 0 4.5 16.5h15a2.25 2.25 0 0 0 2.25-2.25V8.25A2.25 2.25 0 0 0 19.5 6h-5.379a1.5 1.5 0 0 1-1.06-.44Z"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const IconVoicemail = ({ size = 28, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={1.6}
    style={{ width: size, height: size }}
  >
    <path
      d="M5.25 8.25a3 3 0 1 0 6 0 3 3 0 0 0-6 0ZM12.75 8.25a3 3 0 1 0 6 0 3 3 0 0 0-6 0Z"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M2.25 14.25h7.5M14.25 14.25h7.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const IconArrow = ({ size = 14, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    style={{ width: size, height: size, flexShrink: 0 }}
  >
    <path d="M4.5 12h15m0 0-6.75-6.75M19.5 12l-6.75 6.75" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/* ─── Feature card definition ────────────────────────────── */

interface FeatureCard {
  title: string;
  description: string;
  to: string;
  color: string;
  icon: (color: string) => React.ReactNode;
}

const FEATURE_CARDS: FeatureCard[] = [
  {
    title: 'Chat',
    description: 'Real-time messaging with your team. Direct messages and group conversations.',
    to: '/chat',
    color: '#60a5fa',
    icon: (c) => <IconChat color={c} />,
  },
  {
    title: 'Meetings',
    description: 'Video meetings with screen sharing, recording, and scheduling.',
    to: '/conference',
    color: '#4ade80',
    icon: (c) => <IconVideo color={c} />,
  },
  {
    title: 'Documents',
    description: 'Shared document storage for your organization.',
    to: '/documents',
    color: '#fbbf24',
    icon: (c) => <IconFolder color={c} />,
  },
  {
    title: 'Voicemail',
    description: 'Listen to voicemail messages and manage greetings.',
    to: '/voicemail',
    color: '#818cf8',
    icon: (c) => <IconVoicemail color={c} />,
  },
];

/* ─── Feature card component ─────────────────────────────── */

interface FeatureCardProps {
  card: FeatureCard;
  animationDelay: string;
}

function FeatureCardItem({ card, animationDelay }: FeatureCardProps) {
  const navigate = useNavigate();

  const handleClick = () => {
    navigate(card.to);
  };

  const handleMouseEnter = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.style.background = 'linear-gradient(135deg, #1e2235 0%, #1c1f30 100%)';
    el.style.borderColor = `${card.color}40`;
    el.style.transform = 'scale(1.01)';
    el.style.boxShadow = `0 8px 32px -8px ${card.color}20, 0 4px 16px rgba(0,0,0,0.3)`;
  };

  const handleMouseLeave = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.style.background = 'linear-gradient(135deg, #1a1d2e 0%, #181b29 100%)';
    el.style.borderColor = 'rgba(42,47,69,0.6)';
    el.style.transform = 'scale(1)';
    el.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
  };

  // Hex color at 15% opacity as rgba for the icon container background
  const iconBg = hexToRgba(card.color, 0.12);

  return (
    <div
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleClick(); }}
      aria-label={`Go to ${card.title}`}
      style={{
        background: 'linear-gradient(135deg, #1a1d2e 0%, #181b29 100%)',
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 16,
        padding: 28,
        cursor: 'pointer',
        transition: 'background 0.2s, border-color 0.2s, transform 0.2s, box-shadow 0.2s',
        boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        animation: `commFadeIn 0.4s ease both`,
        animationDelay,
        userSelect: 'none',
        outline: 'none',
      }}
    >
      {/* Icon circle */}
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: iconBg,
          border: `1px solid ${card.color}25`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {card.icon(card.color)}
      </div>

      {/* Text content */}
      <div style={{ flex: 1 }}>
        <div
          style={{
            fontSize: '1rem',
            fontWeight: 700,
            color: '#f1f5f9',
            letterSpacing: '-0.02em',
            marginBottom: 6,
          }}
        >
          {card.title}
        </div>
        <div
          style={{
            fontSize: '0.825rem',
            color: '#64748b',
            lineHeight: 1.55,
          }}
        >
          {card.description}
        </div>
      </div>

      {/* Arrow hint */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          fontSize: '0.75rem',
          fontWeight: 600,
          color: card.color,
          opacity: 0.7,
          letterSpacing: '0.01em',
        }}
      >
        <span>Open</span>
        <IconArrow size={13} color={card.color} />
      </div>
    </div>
  );
}

/* ─── Hex to rgba helper ─────────────────────────────────── */

function hexToRgba(hex: string, alpha: number): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return `rgba(255,255,255,${alpha})`;
  const r = parseInt(result[1], 16);
  const g = parseInt(result[2], 16);
  const b = parseInt(result[3], 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/* ─── CommunicationsPage ─────────────────────────────────── */

export function CommunicationsPage() {
  return (
    <div
      style={{
        minHeight: '100%',
        padding: '40px 24px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 900,
          display: 'flex',
          flexDirection: 'column',
          gap: 40,
        }}
      >
        {/* ── Header ───────────────────────────────────── */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 14,
            textAlign: 'center',
            animation: 'commFadeIn 0.35s ease both',
          }}
        >
          {/* Icon container */}
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, rgba(96,165,250,0.18) 0%, rgba(129,140,248,0.12) 100%)',
              border: '1px solid rgba(96,165,250,0.25)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 32px rgba(96,165,250,0.12)',
            }}
          >
            <IconHeadset size={34} color="#60a5fa" />
          </div>

          <div>
            <h1
              style={{
                fontSize: '1.75rem',
                fontWeight: 800,
                color: '#f1f5f9',
                letterSpacing: '-0.04em',
                margin: 0,
                lineHeight: 1.2,
              }}
            >
              Communications
            </h1>
            <p
              style={{
                fontSize: '0.925rem',
                color: '#64748b',
                margin: '8px 0 0',
                lineHeight: 1.6,
                maxWidth: 460,
              }}
            >
              Your unified communications hub — chat, meetings, documents, and voicemail.
            </p>
          </div>
        </div>

        {/* ── Divider ───────────────────────────────────── */}
        <div
          style={{
            height: 1,
            background: 'linear-gradient(90deg, transparent, rgba(42,47,69,0.8) 20%, rgba(42,47,69,0.8) 80%, transparent)',
          }}
        />

        {/* ── Feature grid ──────────────────────────────── */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
            gap: 20,
          }}
        >
          {FEATURE_CARDS.map((card, i) => (
            <FeatureCardItem
              key={card.to}
              card={card}
              animationDelay={`${i * 60}ms`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
