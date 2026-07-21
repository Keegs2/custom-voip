/**
 * ProductGuide — the single, universal page body every product guide renders
 * through. Given one typed `ProductGuideData`, it lays out the identical IA for
 * all products:
 *
 *   ← back to all guides
 *   DocsPageHeader (icon + eyebrow + title + subtitle)
 *   In plain English   — the value proposition, front and centre
 *   Who it's for       — audience checklist
 *   What you get       — feature grid
 *   How it works       — the mechanism in prose
 *   Getting started    — numbered steps + a sign-up CTA
 *   For developers     — a COLLAPSIBLE accordion holding the technical detail,
 *                        visually separated so non-technical readers lead with
 *                        the plain-English story and never hit code unless they
 *                        choose to open it.
 *
 * This keeps every guide consistent (layout, spacing, typographic hierarchy)
 * while each product supplies only its content. The dev accordion is closed by
 * default — approachable-first.
 *
 * React #310: this component has no hooks; the back-link hover state lives in
 * its own child component (BackToDocs) with the hook at the top.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  Sparkles,
  Users,
  PackageCheck,
  Workflow,
  Rocket,
  Code2,
} from 'lucide-react';
import { DocsPageHeader } from './DocsPageHeader';
import { DocsAccordion } from './DocsAccordion';
import { GuideSection, GuideLead, WhoList, FeatureList, HowItWorks, StepList } from './GuideBlocks';
import { GuideCta } from './GuideCta';
import { Endpoint } from './apiRefs';
import type { ProductGuideData } from '../types';
import { DOCS, readingColumn, guideSectionList, backLink } from '../styles';

/** The "← All product guides" breadcrumb; owns its own hover state. */
function BackToDocs({ accent }: { accent: string }) {
  // ALL hooks first (React #310).
  const [hovered, setHovered] = useState(false);
  return (
    <Link
      to="/docs"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={backLink(hovered, accent)}
    >
      <ArrowLeft size={14} strokeWidth={2.2} />
      All product guides
    </Link>
  );
}

export function ProductGuide({ data }: { data: ProductGuideData }) {
  const accent = data.accent ?? DOCS.accent;
  const dev = data.developers;
  const Icon = data.icon;

  return (
    <div style={readingColumn}>
      <BackToDocs accent={accent} />

      <DocsPageHeader
        eyebrow={data.eyebrow}
        title={data.title}
        subtitle={data.subtitle}
        accent={accent}
        icon={<Icon size={30} strokeWidth={1.7} />}
      />

      <div style={guideSectionList}>
        {/* In plain English — lead with the value, largest text, no jargon. */}
        <GuideSection title="In plain English" icon={<Sparkles size={14} />} accent={accent}>
          <GuideLead>{data.plainEnglish}</GuideLead>
        </GuideSection>

        {/* Who it's for */}
        <GuideSection title="Who it's for" icon={<Users size={14} />} accent={accent}>
          <WhoList items={data.whoItsFor} accent={accent} />
        </GuideSection>

        {/* What you get */}
        <GuideSection title="What you get" icon={<PackageCheck size={14} />} accent={accent}>
          <FeatureList items={data.features} accent={accent} />
        </GuideSection>

        {/* How it works */}
        <GuideSection title="How it works" icon={<Workflow size={14} />} accent={accent}>
          <HowItWorks>{data.howItWorks}</HowItWorks>
        </GuideSection>

        {/* Getting started + CTA */}
        <GuideSection title="Getting started" icon={<Rocket size={14} />} accent={accent}>
          <StepList steps={data.gettingStarted} accent={accent} />
          <GuideCta
            title={`Ready to get started with ${data.title}?`}
            body="Request access and a Granite specialist will get your account provisioned. Prefer to keep reading first? Browse the other product guides."
            primaryLabel={data.ctaLabel ?? 'Request access'}
            accent={accent}
          />
        </GuideSection>

        {/* For developers — visually separated, collapsible, closed by default. */}
        <DocsAccordion
          accent={accent}
          icon={<Code2 size={18} />}
          title="For developers"
          subtitle={dev.summary}
        >
          {dev.endpoints && dev.endpoints.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              {dev.endpoints.map((e) => (
                <Endpoint key={`${e.method} ${e.path}`} method={e.method} path={e.path} description={e.description} />
              ))}
            </div>
          )}
          {dev.body()}
        </DocsAccordion>
      </div>
    </div>
  );
}
