/**
 * Generic placeholder custom node (P0). A titled dark-palette card with one
 * target handle (top) and one source handle (bottom) — just enough to prove
 * custom-node rendering and edge connection. The real telephony node palette
 * (SayNode, MenuNode with per-digit handles, DialNode, …) is P1.
 *
 * React #310: this component has no hooks, so there is nothing to order — but
 * any hooks added later MUST stay above any early return.
 */
import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { RFNode } from '../../store/serialize';
import { defaultLabel } from '../../model/defaults';

/** Accent per node type so the placeholder reads like the eventual palette. */
const TYPE_ACCENT: Record<string, string> = {
  entry: '#22d3ee',
  menu: '#c084fc',
  dial: '#4ade80',
  ringGroup: '#4ade80',
  schedule: '#fbbf24',
  condition: '#fbbf24',
  hangup: '#ef4444',
  reject: '#ef4444',
};

function GenericFlowNodeImpl({ data, type, selected }: NodeProps<RFNode>) {
  const accent = (type && TYPE_ACCENT[type]) || '#3b82f6';
  const title = data.label || (type ? defaultLabel(type as never) : 'Node');

  return (
    <div
      style={{
        minWidth: 160,
        borderRadius: 12,
        background: 'linear-gradient(135deg, #1a1d27 0%, #13151d 100%)',
        border: `1px solid ${selected ? accent : 'rgba(42,47,69,0.8)'}`,
        boxShadow: selected
          ? `0 0 0 1px ${accent}, 0 6px 20px -6px ${accent}66`
          : '0 4px 14px -6px rgba(0,0,0,0.6)',
        color: '#e2e8f0',
        overflow: 'hidden',
        transition: 'border-color 0.15s, box-shadow 0.15s',
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: accent, width: 9, height: 9, border: 'none' }}
      />

      {/* Title bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid rgba(42,47,69,0.6)',
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: accent,
            boxShadow: `0 0 6px ${accent}`,
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: '0.8rem',
            fontWeight: 600,
            letterSpacing: '-0.01em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </span>
      </div>

      {/* Type subtitle */}
      <div style={{ padding: '6px 12px 10px', fontSize: '0.65rem', color: '#64748b' }}>
        {type ?? 'node'}
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: accent, width: 9, height: 9, border: 'none' }}
      />
    </div>
  );
}

export const GenericFlowNode = memo(GenericFlowNodeImpl);
