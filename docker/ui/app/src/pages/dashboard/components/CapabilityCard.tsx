/**
 * CapabilityCard — one platform-capability tile, rendered as a frosted glass
 * surface (GlassCard) with the app blue accent. Hover tints the icon and lifts
 * the card via the shared kit.
 *
 * React #310: useState sits unconditionally at the top — no early return above.
 */

import { useState } from 'react';
import { GlassCard } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import type { CapabilityCardData } from '../types';
import {
  capabilityBody,
  capabilityIconBox,
  capabilityTitle,
  capabilityDescription,
} from '../styles';

interface CapabilityCardProps {
  card: CapabilityCardData;
  index: number;
}

export function CapabilityCard({ card, index }: CapabilityCardProps) {
  const [hovered, setHovered] = useState(false);
  const Icon = card.icon;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ height: '100%' }}
    >
      <GlassCard index={index} style={{ height: '100%' }}>
        <div style={capabilityBody}>
          <div style={capabilityIconBox(GLASS.accent, hovered)}>
            <Icon size={22} strokeWidth={1.75} />
          </div>
          <h3 style={capabilityTitle}>{card.title}</h3>
          <p style={capabilityDescription}>{card.description}</p>
        </div>
      </GlassCard>
    </div>
  );
}
