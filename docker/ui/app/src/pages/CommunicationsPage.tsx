/**
 * CommunicationsPage — the unified-communications hub (a static navigation hub
 * linking to chat, meetings, documents, and voicemail). No API calls or
 * server state; it is pure composition.
 *
 * THIN page: composition only. Everything else is co-located under
 * `pages/communications/` (mirrors docs/FRONTEND_GLASS_REFACTOR.md):
 *   communications/styles.ts          → centralised CSSProperties / builders
 *   communications/types.ts           → local FeatureCardDef type
 *   communications/data.tsx           → the static product-tile definitions
 *   communications/components/        → dumb presentational pieces (hero, cards, icons)
 *
 * The ambient GlassBackground is mounted app-wide by AppLayout (this page is
 * routed INSIDE AppLayout), so it does NOT mount its own — it just builds glass
 * surfaces on top. Top offset + horizontal gutters are owned by AppLayout; this
 * page never re-pads the top edge.
 *
 * React #310: no hooks here (static page), but if any are added they must sit
 * unconditionally at the top before any early return.
 */

import { pageColumn, featureGrid } from './communications/styles';
import { FEATURE_CARDS } from './communications/data';
import { CommsHero } from './communications/components/CommsHero';
import { GlassFeatureCard } from './communications/components/GlassFeatureCard';

export function CommunicationsPage() {
  return (
    <div style={pageColumn}>
      <CommsHero />

      <div style={featureGrid}>
        {FEATURE_CARDS.map((card, i) => (
          <GlassFeatureCard key={card.to} card={card} index={i} />
        ))}
      </div>
    </div>
  );
}
