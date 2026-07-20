/**
 * Shared chrome: the back-to-customers button plus the full-page loading and
 * error states — all frosted glass.
 */

import { useState } from 'react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { Spinner } from '../../../../components/ui/Spinner';
import { backBtn, stateIconWrap } from '../styles';
import { IconLeftArrow, IconWarning } from './icons';

export function BackButton({ onClick }: { onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={backBtn(hovered)}
    >
      <IconLeftArrow />
      Customers
    </button>
  );
}

export function LoadingState() {
  return (
    <GlassPanel padding="56px 40px">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          color: GLASS.textMuted,
          fontSize: '0.9rem',
        }}
      >
        <Spinner /> Loading customer…
      </div>
    </GlassPanel>
  );
}

export function ErrorState({ onBack }: { onBack: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <BackButton onClick={onBack} />
      <GlassPanel accent={GLASS.danger} padding="40px 36px">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 12 }}>
          <div style={stateIconWrap(GLASS.danger)}>
            <IconWarning />
          </div>
          <div style={{ fontSize: '1.05rem', fontWeight: 700, color: GLASS.text }}>
            Couldn't load this customer
          </div>
          <div style={{ fontSize: '0.85rem', color: GLASS.textMuted, maxWidth: 360, lineHeight: 1.5 }}>
            The account may not exist or the request failed. Try again from the customer list.
          </div>
        </div>
      </GlassPanel>
    </div>
  );
}
