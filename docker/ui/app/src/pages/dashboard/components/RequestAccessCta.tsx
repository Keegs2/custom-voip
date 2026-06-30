/**
 * RequestAccessCta — the bottom call-to-action shown to unauthenticated visitors
 * on the public homepage. Wrapped in a frosted GlassPanel; the button dispatches
 * the global `open-access-request` event (handled by the access-request modal).
 *
 * React #310: useState sits unconditionally at the top — no early return above.
 */

import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { GlassPanel } from '../../../components/glass/GlassCard';
import { ctaInner, ctaEyebrow, ctaButton, ctaFinePrint } from '../styles';

interface RequestAccessCtaProps {
  onRequestAccess: () => void;
}

export function RequestAccessCta({ onRequestAccess }: RequestAccessCtaProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <GlassPanel padding={0}>
      <div style={ctaInner}>
        <p style={ctaEyebrow}>Carrier-grade call forwarding, ready to deploy</p>

        <button
          type="button"
          onClick={onRequestAccess}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          style={ctaButton(hovered)}
        >
          Request Access
          <ArrowRight size={16} strokeWidth={2.5} />
        </button>

        <p style={ctaFinePrint}>
          A Granite solution engineer will respond within 1 business day.
        </p>
      </div>
    </GlassPanel>
  );
}
