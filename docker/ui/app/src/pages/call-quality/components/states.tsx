/**
 * Shared inline states for the Call Quality page. Currently the CDR-load error
 * banner — a frosted danger surface with a Retry action.
 */

import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../components/glass/glass';
import { IconError } from './icons';

export function ErrorBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <GlassPanel padding="16px 20px" accent={GLASS.danger}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: GLASS.danger, fontSize: '0.85rem' }}>
        <IconError />
        <span style={{ color: GLASS.text }}>Unable to load CDR data. The CDR service may be unavailable.</span>
        <button
          onClick={onRetry}
          style={{
            marginLeft: 'auto',
            padding: '5px 14px',
            fontSize: '0.76rem',
            fontWeight: 600,
            borderRadius: 8,
            border: `1px solid ${hexToRgba(GLASS.danger, 0.4)}`,
            background: hexToRgba(GLASS.danger, 0.12),
            color: GLASS.danger,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Retry
        </button>
      </div>
    </GlassPanel>
  );
}
