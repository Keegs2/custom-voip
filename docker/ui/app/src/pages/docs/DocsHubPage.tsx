/**
 * DocsHubPage — the public documentation landing at `/docs`.
 *
 * A marketing-facing hub: a short "What is Shale" intro followed by a grid of
 * product-guide cards (one per product in the registry). Every card links to a
 * public per-product guide, so a prospect can read everything before creating
 * an account. Lives inside AppLayout but OUTSIDE RequireAuth (like the public
 * homepage), so logged-out visitors can browse it.
 *
 * THIN page: composition only. The frosted-glass primitives + styles live in
 * the co-located feature folder. The ambient GlassBackground is mounted app-wide
 * by AppLayout; this page just composes glass surfaces on top. No top padding —
 * the layout owns the offset (React #310: no hooks here, no early return).
 */

import { DocsPageHeader } from './components/DocsPageHeader';
import { GuideHubCard } from './components/GuideHubCard';
import { GuideCta } from './components/GuideCta';
import { GUIDES } from './guides/registry';
import { P, B } from './components/text';
import { hubColumn, hubIntro, hubIntroLead, hubGrid, sectionList } from './styles';

export function DocsHubPage() {
  return (
    <div style={hubColumn}>
      <DocsPageHeader
        eyebrow="Documentation"
        title="Shale product guides"
        subtitle="Everything Shale does, explained plainly — with a technical section on every product for developers."
      />

      <div style={sectionList}>
        {/* What is Shale — the intro from PRODUCTS.md. */}
        <div style={hubIntro}>
          <p style={hubIntroLead}>
            <B>Shale</B> is Granite's carrier-grade voice platform: distributed voice infrastructure built for the
            enterprise. It runs your phone numbers, your calls, and your communications on the same hardened
            network that carries nationwide utility traffic — with automatic failover across multiple availability
            zones so calls simply don't drop.
          </p>
          <P>
            From a small business that needs one number to always ring the right phone, to a developer building a
            calling app, to an enterprise running its whole phone system in the cloud, to a wholesale buyer
            managing tens of thousands of numbers — you pick the products you need. They all run on{' '}
            <B>one account, one balance, one platform</B>. Pick a product below to learn more.
          </P>
        </div>

        {/* Product-guide cards. */}
        <div style={hubGrid}>
          {GUIDES.map((guide, i) => (
            <GuideHubCard key={guide.slug} guide={guide} index={i} />
          ))}
        </div>

        {/* Closing CTA for prospects. */}
        <GuideCta
          title="Ready to build on Shale?"
          body="Request access and a Granite specialist will help you pick the right products and get your account provisioned — one account, one balance, one platform."
          primaryLabel="Request access"
        />
      </div>
    </div>
  );
}
