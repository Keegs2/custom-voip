/**
 * DashboardPage — the public landing / product-hub home (route `/`).
 *
 * THIN page: composition + the single auth-derived flag only. All data, styles,
 * card definitions, and presentational pieces live in the co-located feature
 * folder `./dashboard/` (hooks.ts / styles.ts / data.ts / types.ts / components/),
 * mirroring the reference `pages/rcf-glass/`. See docs/FRONTEND_GLASS_REFACTOR.md.
 *
 * Spacing: this page renders inside AppLayout's centered, padded content column,
 * so it adds NO top padding/gutters of its own — it only owns in-page vertical
 * rhythm (32px section gap, 16px card gap). The ambient GlassBackground is mounted
 * once app-wide in AppLayout; this page just builds glass surfaces on top.
 *
 * React #310: the only hook (useDashboard) sits at the top, before any return.
 */

import { HaArchitectureViz } from '../components/layout/HaArchitectureViz';
import { useDashboard } from './dashboard/hooks';
import { PRODUCT_CARDS, CAPABILITY_CARDS } from './dashboard/data';
import { pageColumn, sectionBlock, capabilitiesGrid } from './dashboard/styles';
import { Hero } from './dashboard/components/Hero';
import { SectionLabel } from './dashboard/components/SectionLabel';
import { ProductCard } from './dashboard/components/ProductCard';
import { CapabilityCard } from './dashboard/components/CapabilityCard';
import { RequestAccessCta } from './dashboard/components/RequestAccessCta';

export function DashboardPage() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const { isAuthenticated, openRequestAccess } = useDashboard();

  return (
    <div style={pageColumn}>
      {/* Hero */}
      <Hero />

      {/* Products — frosted glass tiles */}
      <section style={sectionBlock}>
        <div className="animate-fade-in-up animation-delay-200">
          <SectionLabel>Products</SectionLabel>
        </div>
        <div className="dash-products-grid">
          {PRODUCT_CARDS.map((card, i) => (
            <ProductCard
              key={card.title}
              card={card}
              index={i}
              // On the public homepage every active tile opens Request Access
              // instead of bouncing an unauthenticated visitor to login.
              // Authenticated users navigate normally (no callback).
              onRequestAccess={!isAuthenticated && card.active ? openRequestAccess : undefined}
            />
          ))}
        </div>
      </section>

      {/* HA architecture visualization */}
      <section className="animate-fade-in-up animation-delay-600" style={sectionBlock}>
        <HaArchitectureViz />
      </section>

      {/* Request Access CTA — unauthenticated only */}
      {!isAuthenticated && (
        <section className="animate-fade-in-up animation-delay-200" style={sectionBlock}>
          <RequestAccessCta onRequestAccess={openRequestAccess} />
        </section>
      )}

      {/* Platform capabilities — frosted glass grid */}
      <section style={sectionBlock}>
        <div className="animate-fade-in-up animation-delay-200">
          <SectionLabel>Platform Capabilities</SectionLabel>
        </div>
        <div style={capabilitiesGrid}>
          {CAPABILITY_CARDS.map((card, i) => (
            <CapabilityCard key={card.title} card={card} index={i} />
          ))}
        </div>
      </section>
    </div>
  );
}
