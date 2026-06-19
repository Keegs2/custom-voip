/**
 * Shared telephony step node — covers every linear IVR verb (say, play, pause,
 * dial, record, redirect, reject, hangup, conference) plus the UCaaS
 * find-me/follow-me verbs (ringGroup, voicemail) and the SIP-trunk inbound
 * delivery verb (route). A dark-palette card with a
 * target handle (top) and, unless the verb is terminal (hangup/reject/voicemail),
 * a single `next` source handle (bottom).
 *
 * `menu` is NOT rendered here — it has per-digit handles (see MenuNode).
 *
 * React #310: this component takes no hooks, so ordering is moot; if any are
 * added later they MUST sit above any early return.
 */
import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { RFNode } from '../../store/serialize';
import type { NodeConfig, NodeType } from '../../model/types';
import { defaultLabel } from '../../model/defaults';
import { NODE_META, DEFAULT_ACCENT } from '../../model/palette';
import { IN_HANDLE, NEXT_HANDLE, isTerminalType } from '../handles';

/** One-line summary of a node's config, shown under the title. */
function summarize(config: NodeConfig): string {
  switch (config.type) {
    case 'say':
      return config.text ? `"${config.text.slice(0, 40)}"` : '(no text)';
    case 'play':
      return config.url ? config.url.slice(0, 40) : '(no audio URL)';
    case 'pause':
      return `${config.seconds || 1}s`;
    case 'dial':
      return config.number || '(no destination)';
    case 'record':
      return `max ${config.maxLength ?? '∞'}s`;
    case 'redirect':
      return config.url ? config.url.slice(0, 40) : '(no URL)';
    case 'reject':
      return config.reason || 'Reject call';
    case 'hangup':
      return 'End call';
    case 'conference':
      return config.room ? `room "${config.room}"` : '(no room)';
    case 'ringGroup': {
      const live = config.legs.filter((l) => l.to.trim()).length;
      return `${config.strategy} · ${live} dest${live === 1 ? '' : 's'}`;
    }
    case 'route': {
      const live = config.endpoints.filter((e) => e.to.trim()).length;
      return `${config.strategy} · ${live} endpoint${live === 1 ? '' : 's'}`;
    }
    case 'voicemail':
      return config.mailbox ? `mailbox ${config.mailbox}` : 'Leave a message';
    default:
      return '';
  }
}

function StepNodeImpl({ data, type, selected }: NodeProps<RFNode>) {
  const nodeType = (type ?? 'say') as NodeType;
  const meta = NODE_META[nodeType];
  const accent = meta?.accent ?? DEFAULT_ACCENT;
  const title = data.label || defaultLabel(nodeType);
  const terminal = isTerminalType(nodeType);

  return (
    <div
      style={{
        minWidth: 168,
        maxWidth: 230,
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
        id={IN_HANDLE}
        position={Position.Top}
        style={{ background: accent, width: 9, height: 9, border: 'none' }}
      />

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
          {meta?.glyph ?? '•'}
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

      <div
        style={{
          padding: '7px 12px 9px',
          fontSize: '0.68rem',
          color: '#94a3b8',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {summarize(data.config)}
      </div>

      {!terminal && (
        <Handle
          type="source"
          id={NEXT_HANDLE}
          position={Position.Bottom}
          style={{ background: accent, width: 9, height: 9, border: 'none' }}
        />
      )}
    </div>
  );
}

export const StepNode = memo(StepNodeImpl);
