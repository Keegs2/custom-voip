/**
 * CardHeader — the icon badge + title + subtitle row at the top of each Account
 * card. Presentational; the accent tints the icon badge.
 */

import type { ReactNode } from 'react';
import { GLASS } from '../../../components/glass/glass';
import { cardHeader, cardIconBadge, cardTitle, cardSubtitle } from '../styles';

export function CardHeader({ icon, title, subtitle, accent = GLASS.accent }: { icon: ReactNode; title: string; subtitle: string; accent?: string }) {
  return (
    <div style={cardHeader}>
      <span style={cardIconBadge(accent)}>{icon}</span>
      <div style={{ minWidth: 0 }}>
        <h2 style={cardTitle}>{title}</h2>
        <p style={cardSubtitle}>{subtitle}</p>
      </div>
    </div>
  );
}
