/**
 * SectionCard — a glass panel with an uppercase, icon-prefixed section header.
 * The surface is the canonical blue glass; the `accent` prop tints only the
 * sheen edge + the header icon/label, so product sections (RCF green, API
 * purple, Trunk amber) stay visually distinct while reading as glass.
 */

import type { ReactNode } from 'react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { sectionHeader, sectionIcon, sectionTitle } from '../styles';

interface SectionCardProps {
  children: ReactNode;
  accent?: string;
  title: string;
  icon?: ReactNode;
}

export function SectionCard({ children, accent = GLASS.accent, title, icon }: SectionCardProps) {
  return (
    <GlassPanel accent={accent} padding="22px 24px">
      <div style={sectionHeader}>
        {icon && <span style={sectionIcon(accent)}>{icon}</span>}
        <h3 style={sectionTitle}>{title}</h3>
      </div>
      {children}
    </GlassPanel>
  );
}
