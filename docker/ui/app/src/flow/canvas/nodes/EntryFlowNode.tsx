/**
 * Entry (trigger) placeholder node (P0). Exactly one per flow — "the call
 * arrives here". Has a source handle only (no input). Demonstrates a second
 * custom-node type alongside GenericFlowNode.
 */
import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { RFNode } from '../../store/serialize';
import { NEXT_HANDLE } from '../handles';

const ACCENT = '#22d3ee';

function EntryFlowNodeImpl({ data, selected }: NodeProps<RFNode>) {
  return (
    <div
      style={{
        minWidth: 160,
        borderRadius: 999,
        padding: '10px 18px',
        background: `linear-gradient(135deg, ${ACCENT}22 0%, ${ACCENT}0d 100%)`,
        border: `1px solid ${selected ? ACCENT : `${ACCENT}55`}`,
        boxShadow: selected
          ? `0 0 0 1px ${ACCENT}, 0 6px 20px -6px ${ACCENT}66`
          : `0 4px 14px -8px ${ACCENT}66`,
        color: '#e2e8f0',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        justifyContent: 'center',
        transition: 'border-color 0.15s, box-shadow 0.15s',
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: ACCENT,
          boxShadow: `0 0 8px ${ACCENT}`,
          flexShrink: 0,
        }}
      />
      <span style={{ fontSize: '0.8rem', fontWeight: 700, letterSpacing: '-0.01em' }}>
        {data.label || 'Call Arrives'}
      </span>

      <Handle
        type="source"
        id={NEXT_HANDLE}
        position={Position.Bottom}
        style={{ background: ACCENT, width: 9, height: 9, border: 'none' }}
      />
    </div>
  );
}

export const EntryFlowNode = memo(EntryFlowNodeImpl);
