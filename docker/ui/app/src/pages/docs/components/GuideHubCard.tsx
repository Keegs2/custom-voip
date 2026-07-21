/**
 * GuideHubCard — one product tile in the /docs landing grid. A frosted glass
 * card (lifts + glows on hover) that shows the product's icon, one-line pitch,
 * "best for" line, and a "Read the guide →" affordance. The whole card is a
 * link to that product's guide, so a prospect can browse every product before
 * ever creating an account.
 *
 * React #310: the single hover hook sits unconditionally at the top.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { GlassCard } from '../../../components/glass/GlassCard';
import type { GuideMeta } from '../types';
import {
  DOCS,
  hubCardBody,
  hubIconBox,
  hubCardTitle,
  hubCardPitch,
  hubCardMeta,
  hubCardLink,
} from '../styles';

export function GuideHubCard({ guide, index }: { guide: GuideMeta; index: number }) {
  // ALL hooks first (React #310).
  const [hovered, setHovered] = useState(false);
  const Icon = guide.icon;

  return (
    <Link
      to={`/docs/${guide.slug}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ textDecoration: 'none', height: '100%', display: 'block' }}
    >
      <GlassCard index={index} accent={guide.accent} style={{ height: '100%' }}>
        <div style={hubCardBody}>
          <div style={hubIconBox(guide.accent)}>
            <Icon size={22} strokeWidth={1.75} />
          </div>
          <div style={hubCardTitle}>{guide.title}</div>
          <div style={hubCardPitch}>{guide.pitch}</div>
          <div style={hubCardMeta}>
            <span style={{ color: DOCS.textMuted, fontWeight: 600 }}>Best for:</span> {guide.bestFor}
          </div>
          <span style={{ ...hubCardLink(guide.accent), opacity: hovered ? 1 : 0.82, gap: hovered ? 8 : 6 }}>
            Read the guide
            <ArrowRight size={13} strokeWidth={2.4} />
          </span>
        </div>
      </GlassCard>
    </Link>
  );
}
