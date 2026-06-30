/**
 * GlassTable — a frosted panel wrapping a horizontally-scrollable table. The
 * shared chrome (glass surface, scroll container, collapsed borders) for every
 * dense live-ops monitoring table. Callers supply their own <thead>/<tbody> via
 * `head` + `children` and use the `th`/`td` style objects from shared/styles.
 */

import type { ReactNode } from 'react';
import { GlassPanel } from '../../../components/glass/GlassCard';

export function GlassTable({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <GlassPanel padding={0} blur={20}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          {head}
          <tbody>{children}</tbody>
        </table>
      </div>
    </GlassPanel>
  );
}
