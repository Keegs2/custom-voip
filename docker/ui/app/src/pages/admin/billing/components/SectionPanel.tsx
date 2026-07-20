/**
 * SectionPanel — a frosted glass section container with a standard header
 * (eyebrow + title + description + optional badge slot) used across the billing
 * admin area. Wraps the canonical <GlassPanel> so every section refracts light
 * the same way. Presentation only — all data/state lives in the parent.
 */

import type { ReactNode } from 'react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { sectionEyebrow, sectionTitle, sectionDesc } from '../styles';

interface SectionPanelProps {
  eyebrow?: string;
  title: string;
  description?: string;
  badge?: ReactNode;
  accent?: string;
  children: ReactNode;
}

export function SectionPanel({ eyebrow, title, description, badge, accent = GLASS.accent, children }: SectionPanelProps) {
  return (
    <GlassPanel padding="24px 26px" accent={accent}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 22,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 0 }}>
          {eyebrow && <div style={sectionEyebrow(accent)}>{eyebrow}</div>}
          <h2 style={sectionTitle}>{title}</h2>
          {description && <p style={sectionDesc}>{description}</p>}
        </div>
        {badge && <div style={{ flexShrink: 0 }}>{badge}</div>}
      </div>
      {children}
    </GlassPanel>
  );
}
