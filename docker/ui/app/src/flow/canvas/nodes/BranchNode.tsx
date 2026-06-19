/**
 * Two-way branch node — renders the rich-RCF `schedule` (time-of-day) and
 * `condition` (caller-ID) verbs. Exposes exactly two labelled source handles —
 * a positive "guard satisfied" branch and a negative fall-through branch — whose
 * ids (`inWindow`/`otherwise`, `match`/`noMatch`) are the SAME ids the RCF rich
 * compiler walks (see `handles.ts` + `compile/rcf.ts`).
 *
 * Layout mirrors `MenuNode`: each option row and its right-edge handle share a
 * computed `top` so they stay aligned.
 *
 * React #310: this component takes no hooks; any added later MUST precede any
 * early return.
 */
import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { RFNode } from '../../store/serialize';
import type { NodeConfig, NodeType } from '../../model/types';
import { defaultLabel } from '../../model/defaults';
import { NODE_META, DEFAULT_ACCENT } from '../../model/palette';
import { IN_HANDLE, branchHandles } from '../handles';

const HEADER_H = 38;
const SUB_H = 22;
const ROW_H = 26;
const PAD = 8;

/** One-line summary of a branch node's guard, shown under the title. */
function summarize(config: NodeConfig): string {
  if (config.type === 'schedule') {
    const days = config.days.length ? config.days.join(' ') : '(no days)';
    return `${days} · ${config.start}-${config.end}`;
  }
  if (config.type === 'condition') {
    if (config.callerId.equals?.trim()) return `caller = ${config.callerId.equals.trim()}`;
    if (config.callerId.prefix?.trim()) return `caller ~ ${config.callerId.prefix.trim()}*`;
    return '(no caller-ID rule)';
  }
  return '';
}

function BranchNodeImpl({ data, type, selected }: NodeProps<RFNode>) {
  const nodeType = (type ?? 'condition') as NodeType;
  const meta = NODE_META[nodeType];
  const accent = meta?.accent ?? DEFAULT_ACCENT;
  const title = data.label || defaultLabel(nodeType);
  const rows = branchHandles(nodeType) ?? [];
  const subtitle = summarize(data.config);

  const base = HEADER_H + (subtitle ? SUB_H : 0) + PAD;
  const height = base + rows.length * ROW_H + PAD;

  return (
    <div
      style={{
        position: 'relative',
        width: 200,
        height,
        borderRadius: 12,
        background: 'linear-gradient(135deg, #1a1d27 0%, #13151d 100%)',
        border: `1px solid ${selected ? accent : 'rgba(42,47,69,0.8)'}`,
        boxShadow: selected
          ? `0 0 0 1px ${accent}, 0 6px 20px -6px ${accent}66`
          : '0 4px 14px -6px rgba(0,0,0,0.6)',
        color: '#e2e8f0',
      }}
    >
      <Handle
        type="target"
        id={IN_HANDLE}
        position={Position.Top}
        style={{ background: accent, width: 9, height: 9, border: 'none' }}
      />

      {/* Header */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: HEADER_H,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 12px',
          borderBottom: '1px solid rgba(42,47,69,0.6)',
        }}
      >
        <span
          style={{
            width: 18,
            height: 18,
            borderRadius: 5,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '0.7rem',
            fontWeight: 800,
            color: accent,
            background: `${accent}1f`,
            flexShrink: 0,
          }}
        >
          {meta?.glyph ?? '◇'}
        </span>
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

      {/* Guard summary */}
      {subtitle ? (
        <div
          style={{
            position: 'absolute',
            top: HEADER_H,
            left: 0,
            right: 0,
            height: SUB_H,
            padding: '0 12px',
            display: 'flex',
            alignItems: 'center',
            fontSize: '0.64rem',
            color: '#94a3b8',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {subtitle}
        </div>
      ) : null}

      {/* Branch rows + per-branch source handles */}
      {rows.map((row, i) => {
        const top = base + i * ROW_H;
        const dotColor = row.positive ? accent : '#64748b';
        return (
          <div key={row.handle}>
            <div
              style={{
                position: 'absolute',
                top,
                left: 0,
                right: 0,
                height: ROW_H,
                display: 'flex',
                alignItems: 'center',
                padding: '0 16px 0 12px',
                fontSize: '0.7rem',
                fontWeight: row.positive ? 600 : 500,
                color: row.positive ? '#cbd5e1' : '#64748b',
              }}
            >
              <span>{row.label}</span>
            </div>
            <Handle
              type="source"
              id={row.handle}
              position={Position.Right}
              style={{
                top: top + ROW_H / 2,
                background: dotColor,
                width: 9,
                height: 9,
                border: 'none',
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

export const BranchNode = memo(BranchNodeImpl);
