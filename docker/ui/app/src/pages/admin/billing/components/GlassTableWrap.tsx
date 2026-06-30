/**
 * GlassTableWrap — a frosted, horizontally-scrollable shell for a raw <table>.
 * Mirrors the rcf-glass GlassTable surface so every billing table reads as one
 * pane of glass. The caller supplies the <thead>/<tbody> via children.
 */

import type { ReactNode } from 'react';
import { GlassPanel } from '../../../../components/glass/GlassCard';

export function GlassTableWrap({ children }: { children: ReactNode }) {
  return (
    <GlassPanel padding={0} blur={20}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>{children}</table>
      </div>
    </GlassPanel>
  );
}
