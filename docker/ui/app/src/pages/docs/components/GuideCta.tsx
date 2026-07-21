/**
 * GuideCta — the sign-up / next-step call-to-action that closes every product
 * guide's "Getting started" section.
 *
 * A prospect reading these docs is logged out, so the primary action routes to
 * the public homepage (`/`), where the sidebar Request Access + Sign In forms
 * live — the real front door for creating an account. A secondary ghost link
 * returns to the docs hub so a reader can keep comparing products.
 *
 * React #310: the single hover hook sits unconditionally at the top.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BookOpen } from 'lucide-react';
import { DOCS, ctaCard, ctaTitle, ctaBody, ctaButton, ctaButtonGhost } from '../styles';

interface GuideCtaProps {
  /** Headline, e.g. "Ready to point your first number?". */
  title: string;
  /** Supporting line under the headline. */
  body: string;
  /** Primary button label (defaults to "Request access"). */
  primaryLabel?: string;
  accent?: string;
}

export function GuideCta({ title, body, primaryLabel = 'Request access', accent = DOCS.accent }: GuideCtaProps) {
  // ALL hooks first (React #310).
  const [hovered, setHovered] = useState(false);

  return (
    <div style={ctaCard(accent)}>
      <div style={{ minWidth: 0 }}>
        <div style={ctaTitle}>{title}</div>
        <div style={ctaBody}>{body}</div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Link
          to="/"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          style={{
            ...ctaButton(accent),
            transform: hovered ? 'translateY(-1px)' : 'translateY(0)',
          }}
        >
          {primaryLabel}
          <ArrowRight size={15} strokeWidth={2.2} />
        </Link>
        <Link to="/docs" style={ctaButtonGhost(accent)}>
          <BookOpen size={14} strokeWidth={2} />
          All product guides
        </Link>
      </div>
    </div>
  );
}
