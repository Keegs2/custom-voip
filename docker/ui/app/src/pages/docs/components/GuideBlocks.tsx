/**
 * Reusable presentational blocks for a product guide's plain-English body:
 * the titled section wrapper, the "who it's for" checklist, the "what you get"
 * feature grid, and the numbered "getting started" step list.
 *
 * Presentational only — every visual decision comes from `styles.ts`. Exports
 * only components (keeps `react-refresh/only-export-components` happy).
 */

import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { GlassPanel } from '../../../components/glass/GlassCard';
import type { FeatureItem, GuideStep } from '../types';
import {
  DOCS,
  guideSectionTitle,
  guideLead,
  whoList,
  whoItem,
  whoTick,
  featureGrid,
  featureCard,
  featureDot,
  featureTitle,
  featureBody,
  stepsWrap,
  stepCard,
  stepBadge,
  paragraph,
} from '../styles';

/**
 * A titled guide section rendered on a frosted panel. The panel keeps prose
 * legible over the ambient backdrop and gives each part of the guide a clear
 * visual boundary.
 */
export function GuideSection({
  title,
  icon,
  accent = DOCS.accent,
  children,
}: {
  title: string;
  icon?: ReactNode;
  accent?: string;
  children: ReactNode;
}) {
  return (
    <GlassPanel accent={accent} radius={18} padding="24px 28px">
      <h2 style={{ ...guideSectionTitle, color: accent }}>
        {icon && <span style={{ display: 'flex', color: accent }}>{icon}</span>}
        {title}
      </h2>
      {children}
    </GlassPanel>
  );
}

/** The lead paragraph used for the "In plain English" opener. */
export function GuideLead({ children }: { children: ReactNode }) {
  return <p style={guideLead}>{children}</p>;
}

/** "Who it's for" — a ticked checklist. */
export function WhoList({ items, accent = DOCS.accent }: { items: ReactNode[]; accent?: string }) {
  return (
    <ul style={whoList}>
      {items.map((item, i) => (
        <li key={i} style={whoItem}>
          <span style={whoTick(accent)}>
            <Check size={13} strokeWidth={2.6} />
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

/** "What you get" — a feature grid. */
export function FeatureList({ items, accent = DOCS.accent }: { items: FeatureItem[]; accent?: string }) {
  return (
    <div style={featureGrid}>
      {items.map((f, i) => (
        <div key={i} style={featureCard(accent)}>
          <span style={featureDot(accent)}>
            <Check size={15} strokeWidth={2.4} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={featureTitle}>{f.title}</div>
            <div style={featureBody}>{f.body}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** "How it works" — plain prose paragraph(s). */
export function HowItWorks({ children }: { children: ReactNode }) {
  return <p style={{ ...paragraph, fontSize: '0.92rem', margin: 0 }}>{children}</p>;
}

/** "Getting started" — a numbered step list. */
export function StepList({ steps, accent = DOCS.accent }: { steps: GuideStep[]; accent?: string }) {
  return (
    <div style={stepsWrap}>
      {steps.map((s, i) => (
        <div key={i} style={stepCard}>
          <div style={stepBadge(accent)}>{i + 1}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '0.9rem', fontWeight: 700, color: DOCS.text, marginBottom: 4 }}>{s.title}</div>
            <div style={{ fontSize: '0.85rem', color: DOCS.textMuted, lineHeight: 1.66 }}>{s.body}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
