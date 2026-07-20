/**
 * Loading / error presentational states for the Programmable Voice page. All
 * frosted glass, driven by props.
 */

import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../components/glass/glass';
import { shimmerLine } from '../styles';

function ShimmerLine({ w, h = 14, mb = 0 }: { w: string | number; h?: number; mb?: number }) {
  return <div style={shimmerLine(w, h, mb)} />;
}

function SkeletonCard() {
  return (
    <GlassPanel padding="22px 24px">
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 22 }}>
        <ShimmerLine w={150} h={22} />
        <ShimmerLine w={70} h={22} />
      </div>
      <ShimmerLine w={90} h={12} mb={10} />
      <ShimmerLine w="100%" h={36} mb={20} />
      <ShimmerLine w={120} h={12} mb={10} />
      <ShimmerLine w="100%" h={36} />
    </GlassPanel>
  );
}

export function LoadingState() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 16 }}>
      {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
    </div>
  );
}

export function ErrorState() {
  return (
    <GlassPanel padding="20px 24px" accent={GLASS.danger}>
      <div
        style={{
          fontSize: '0.875rem',
          color: '#fca5a5',
          background: hexToRgba(GLASS.danger, 0.08),
          border: `1px solid ${hexToRgba(GLASS.danger, 0.24)}`,
          borderRadius: 12,
          padding: '14px 18px',
        }}
      >
        Unable to load API numbers. Please try refreshing the page.
      </div>
    </GlassPanel>
  );
}

export function NoMatchState({ search }: { search: string }) {
  return (
    <GlassPanel padding="32px 24px">
      <p style={{ fontSize: '0.85rem', color: GLASS.textMuted, textAlign: 'center', margin: 0 }}>
        No numbers match “{search}”.
      </p>
    </GlassPanel>
  );
}
