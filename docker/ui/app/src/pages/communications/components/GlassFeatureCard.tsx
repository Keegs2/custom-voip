/**
 * One product tile on the Communications hub. Composes the canonical
 * <GlassCard> (hover lift + accent glow + staggered entrance) and adds
 * navigation + keyboard affordances. Purely presentational: it receives its
 * definition + index via props and calls navigate on activation.
 */

import { useNavigate } from 'react-router-dom';
import { GlassCard } from '../../../components/glass/GlassCard';
import type { FeatureCardDef } from '../types';
import { cardInner, cardIconRing, cardTitle, cardDesc, cardOpenHint } from '../styles';
import { IconArrow } from './icons';

interface GlassFeatureCardProps {
  card: FeatureCardDef;
  index: number;
}

export function GlassFeatureCard({ card, index }: GlassFeatureCardProps) {
  // ALL hooks unconditionally at the top (React #310 discipline)
  const navigate = useNavigate();

  const go = () => navigate(card.to);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Go to ${card.title}`}
      onClick={go}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          go();
        }
      }}
      style={{ cursor: 'pointer', outline: 'none', borderRadius: 22 }}
    >
      <GlassCard index={index} accent={card.accent} style={{ height: '100%' }}>
        <div style={cardInner}>
          <div style={cardIconRing(card.accent)}>{card.icon}</div>

          <div style={{ flex: 1 }}>
            <div style={cardTitle}>{card.title}</div>
            <div style={cardDesc}>{card.description}</div>
          </div>

          <div style={cardOpenHint(card.accent)}>
            <span>Open</span>
            <IconArrow size={13} color={card.accent} />
          </div>
        </div>
      </GlassCard>
    </div>
  );
}
