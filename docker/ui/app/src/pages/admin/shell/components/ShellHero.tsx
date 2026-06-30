/**
 * ShellHero — the glass header block at the top of an admin tab shell.
 * Pure presentation: receives its copy via props, renders the Shale logo badge +
 * title block inside a frosted GlassPanel (blue accent). GlassPanel supplies the
 * specular top-edge sheen, so no hand-rolled accent line is needed here.
 */

import { GlassPanel } from '../../../../components/glass/GlassCard';
import {
  heroRow,
  heroLogoBadge,
  heroLogoImg,
  heroEyebrow,
  heroTitle,
  heroSubtitle,
} from '../styles';

interface ShellHeroProps {
  eyebrow: string;
  title: string;
  subtitle: string;
}

export function ShellHero({ eyebrow, title, subtitle }: ShellHeroProps) {
  return (
    <GlassPanel padding="30px 34px" radius={20}>
      <div style={heroRow}>
        <div style={heroLogoBadge}>
          <img src="/shale_logo.png" alt="Shale" style={heroLogoImg} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={heroEyebrow}>{eyebrow}</div>
          <h1 style={heroTitle}>{title}</h1>
          <p style={heroSubtitle}>{subtitle}</p>
        </div>
      </div>
    </GlassPanel>
  );
}
