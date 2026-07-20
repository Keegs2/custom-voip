/**
 * GlassModalShell — the shared frosted modal scaffold (backdrop + glass card +
 * specular sheen) used by every conference dialog. Click-outside-to-close is
 * handled here; each modal supplies its own header/body/footer as children.
 *
 * The inner wrapper is a flex column with `minHeight: 0` so a child can declare
 * a fixed header/footer and a scrolling middle region (used by the invite modal).
 */

import type { ReactNode } from 'react';
import { GlassSheen } from '../../../components/glass/GlassCard';
import { modalBackdrop, modalCard } from '../styles';

interface GlassModalShellProps {
  onClose: () => void;
  maxWidth: number;
  maxHeight?: string;
  children: ReactNode;
}

export function GlassModalShell({ onClose, maxWidth, maxHeight, children }: GlassModalShellProps) {
  return (
    <div
      style={modalBackdrop}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={modalCard(maxWidth, maxHeight)}>
        <GlassSheen />
        <div
          style={{
            position: 'relative',
            zIndex: 1,
            flex: '1 1 auto',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
