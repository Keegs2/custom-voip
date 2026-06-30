/**
 * QueueRow — one frosted, expandable ACD queue. Collapsed it shows the queue
 * name + a depth chip; expanded it drills into the live waiting-member roster.
 * Open/closed state is owned by the page (controlled).
 */

import { ChevronRight, Users } from 'lucide-react';
import { GlassCard } from '../../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import type { QueueSummary } from '../../../../types/queue';
import { QueueMembersPanel } from './QueueMembersPanel';

interface QueueRowProps {
  queue: QueueSummary;
  index: number;
  isOpen: boolean;
  onToggle: () => void;
}

export function QueueRow({ queue, index, isOpen, onToggle }: QueueRowProps) {
  const hasDepth = queue.depth > 0;
  const depthColor = hasDepth ? GLASS.warning : GLASS.textMuted;

  return (
    <GlassCard index={index} style={{ padding: 0 }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 18px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'inherit',
        }}
      >
        <ChevronRight
          size={16}
          color={GLASS.textFaint}
          style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s', flexShrink: 0 }}
        />
        <Users size={15} color={GLASS.blue} style={{ flexShrink: 0 }} />
        <span style={{ flex: 1, fontSize: '0.9rem', fontWeight: 600, color: GLASS.text }}>{queue.name}</span>
        <span
          style={{
            fontSize: '0.72rem',
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
            padding: '5px 11px',
            borderRadius: 999,
            color: depthColor,
            background: hexToRgba(depthColor, hasDepth ? 0.12 : 0.06),
            border: `1px solid ${hexToRgba(depthColor, hasDepth ? 0.3 : 0.16)}`,
          }}
        >
          {queue.depth} waiting
        </span>
      </button>
      {isOpen && (
        <div style={{ padding: '0 18px 16px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <QueueMembersPanel name={queue.name} />
        </div>
      )}
    </GlassCard>
  );
}
