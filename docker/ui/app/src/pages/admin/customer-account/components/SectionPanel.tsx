/**
 * SectionPanel — a frosted-glass content section with an optional accent label.
 * Replaces the old opaque `SectionCard` wrapper. Per-product accent (RCF green,
 * API purple, trunk amber, UCaaS sky) is a justified local override of app blue.
 */

import type { ReactNode } from 'react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { sectionLabel } from '../styles';

interface SectionPanelProps {
  children: ReactNode;
  /** Optional uppercase eyebrow label rendered in the accent hue. */
  label?: string;
  accent?: string;
}

export function SectionPanel({ children, label, accent = GLASS.accent }: SectionPanelProps) {
  return (
    <GlassPanel accent={accent} padding="26px 30px">
      {label && <div style={sectionLabel(accent)}>{label}</div>}
      {children}
    </GlassPanel>
  );
}
