/**
 * Menu (Gather) node — collects DTMF and branches per key. It exposes one
 * source handle per enabled digit (`config.digits`), plus a `timeout` and a
 * `noMatch` handle. These handle ids become the compiled `branches` map (see
 * `compile/ivr.ts` + `handles.ts`).
 *
 * Handles are absolutely positioned by the runtime relative to the node box, so
 * each option row and its right-edge handle are placed at the SAME computed
 * `top` to stay aligned regardless of how many options exist.
 *
 * React #310: no hooks here; any added later must precede early returns.
 */
import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { RFNode } from '../../store/serialize';
import { NODE_META } from '../../model/palette';
import { IN_HANDLE, MENU_NOMATCH, MENU_TIMEOUT } from '../handles';

const ACCENT = NODE_META.menu.accent;

const HEADER_H = 38;
const PROMPT_H = 24;
const ROW_H = 26;
const PAD = 8;

interface OptionRow {
  handle: string;
  label: string;
  muted?: boolean;
}

function MenuNodeImpl({ data, selected }: NodeProps<RFNode>) {
  const config = data.config;
  const digits = config.type === 'menu' ? config.digits : [];
  const promptText = config.type === 'menu' ? config.prompt : '';

  const rows: OptionRow[] = [
    ...digits.map((d) => ({ handle: d, label: `Press ${d}` })),
    { handle: MENU_TIMEOUT, label: 'Timeout', muted: true },
    { handle: MENU_NOMATCH, label: 'No match', muted: true },
  ];

  const base = HEADER_H + (promptText ? PROMPT_H : 0) + PAD;
  const height = base + rows.length * ROW_H + PAD;

  return (
    <div
      style={{
        position: 'relative',
        width: 210,
        height,
        borderRadius: 12,
        background: 'linear-gradient(135deg, #1a1d27 0%, #13151d 100%)',
        border: `1px solid ${selected ? ACCENT : 'rgba(42,47,69,0.8)'}`,
        boxShadow: selected
          ? `0 0 0 1px ${ACCENT}, 0 6px 20px -6px ${ACCENT}66`
          : '0 4px 14px -6px rgba(0,0,0,0.6)',
        color: '#e2e8f0',
      }}
    >
      <Handle
        type="target"
        id={IN_HANDLE}
        position={Position.Top}
        style={{ background: ACCENT, width: 9, height: 9, border: 'none' }}
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
            color: ACCENT,
            background: `${ACCENT}1f`,
          }}
        >
          #
        </span>
        <span style={{ fontSize: '0.8rem', fontWeight: 600, letterSpacing: '-0.01em' }}>
          {data.label || 'Menu'}
        </span>
      </div>

      {/* Prompt preview */}
      {promptText ? (
        <div
          style={{
            position: 'absolute',
            top: HEADER_H,
            left: 0,
            right: 0,
            height: PROMPT_H,
            padding: '0 12px',
            display: 'flex',
            alignItems: 'center',
            fontSize: '0.66rem',
            color: '#94a3b8',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          “{promptText.slice(0, 34)}”
        </div>
      ) : null}

      {/* Option rows + per-option source handles */}
      {rows.map((row, i) => {
        const top = base + i * ROW_H;
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
                fontWeight: row.muted ? 500 : 600,
                color: row.muted ? '#64748b' : '#cbd5e1',
                justifyContent: 'space-between',
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
                background: row.muted ? '#64748b' : ACCENT,
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

export const MenuNode = memo(MenuNodeImpl);
