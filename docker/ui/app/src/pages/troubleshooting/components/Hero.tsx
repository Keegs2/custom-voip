/**
 * Hero — the page header: an accent badge, gradient title, subtitle, and the
 * "Open SIP Dashboard" deep link to Grafana. Pure presentation.
 */

import { useState } from 'react';
import { GLASS, hexToRgba } from '../../../components/glass/glass';
import {
  heroRow,
  heroBadge,
  heroBadgeDot,
  heroBadgeText,
  heroTitle,
  heroSubtitle,
  dashboardLink,
} from '../styles';
import { IconExternal } from './icons';

export function Hero() {
  const [hovered, setHovered] = useState(false);

  return (
    <header style={heroRow}>
      <div>
        <div style={heroBadge()}>
          <span style={heroBadgeDot()} />
          <span style={heroBadgeText()}>SIP Trace Search</span>
        </div>
        <h1 style={heroTitle()}>Troubleshooting</h1>
        <p style={heroSubtitle}>
          Trace any call through the signaling path. Search by phone number,
          Call-ID, or time window — then expand a row for the full SIP ladder and
          packet detail.
        </p>
      </div>

      <a
        href="/grafana/"
        target="_blank"
        rel="noopener noreferrer"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          ...dashboardLink(),
          background: hovered ? hexToRgba(GLASS.accent, 0.16) : hexToRgba(GLASS.accent, 0.08),
          borderColor: hovered ? hexToRgba(GLASS.accent, 0.5) : hexToRgba(GLASS.accent, 0.28),
        }}
      >
        <IconExternal />
        Open SIP Dashboard
      </a>
    </header>
  );
}
