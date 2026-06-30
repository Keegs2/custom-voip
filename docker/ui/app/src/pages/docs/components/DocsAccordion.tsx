/**
 * Collapsible documentation section — a frosted glass card whose border + header
 * wash warm to the accent when open. Built on the canonical `glassSurface` +
 * <GlassSheen> so it refracts light identically to the rest of the glass kit.
 *
 * React #310: the single `open` hook sits unconditionally at the top.
 */

import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { glassSurface, hexToRgba } from '../../../components/glass/glass';
import { GlassSheen } from '../../../components/glass/GlassCard';
import {
  DOCS,
  accordionHeader,
  accordionIconBadge,
  accordionTitle,
  accordionSubtitle,
  accordionChevron,
  accordionBody,
} from '../styles';

interface DocsAccordionProps {
  accent?: string;
  icon: ReactNode;
  title: ReactNode;
  subtitle: string;
  children: ReactNode;
  defaultOpen?: boolean;
}

export function DocsAccordion({
  accent = DOCS.accent,
  icon,
  title,
  subtitle,
  children,
  defaultOpen = false,
}: DocsAccordionProps) {
  // ALL hooks first (React #310).
  const [open, setOpen] = useState(defaultOpen);

  // Base frosted surface; when open, lift the border toward the accent.
  const surface = glassSurface({ accent, radius: 18, blur: 16 });

  return (
    <div
      style={{
        ...surface,
        border: `1px solid ${open ? hexToRgba(accent, 0.34) : 'rgba(255,255,255,0.10)'}`,
      }}
    >
      <GlassSheen accent={accent} />
      <div style={{ position: 'relative', zIndex: 1 }}>
        <button type="button" onClick={() => setOpen((o) => !o)} style={accordionHeader(open, accent)}>
          <div style={accordionIconBadge(accent)}>{icon}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={accordionTitle}>{title}</div>
            <div style={accordionSubtitle}>{subtitle}</div>
          </div>
          <div style={accordionChevron(open, accent)}>
            <ChevronDown size={20} />
          </div>
        </button>

        {open && <div style={accordionBody}>{children}</div>}
      </div>
    </div>
  );
}
