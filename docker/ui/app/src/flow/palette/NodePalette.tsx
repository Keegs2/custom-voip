/**
 * Draggable / click-to-add node palette for the IVR builder.
 *
 * Drag: sets the node type on the drag payload; the canvas reads it in `onDrop`
 * and places the node under the cursor. Click: adds the node at a default
 * canvas position. Both go through the store's `addNode`.
 *
 * React #310: store hooks are read unconditionally at the top.
 */
import { useFlowStore } from '../store/flowStore';
import { IVR_PALETTE, NODE_META } from '../model/palette';
import type { NodeType } from '../model/types';

/** Custom MIME used to carry the node type across the HTML5 DnD boundary. */
export const PALETTE_DND_MIME = 'application/revup-flow-node';

export function NodePalette() {
  const addNode = useFlowStore((s) => s.addNode);
  const setSelected = useFlowStore((s) => s.setSelected);

  const handleClick = (type: NodeType) => {
    // Stagger click-adds by the current node count so stacked adds stay visible
    // (deterministic — avoids impure Math.random during a render-adjacent path).
    const n = useFlowStore.getState().nodes.length;
    const node = addNode(type, { x: 320 + (n % 6) * 26, y: 240 + (n % 6) * 30 });
    setSelected(node.id);
  };

  return (
    <div
      style={{
        width: 188,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 12,
        overflowY: 'auto',
        background: '#13151d',
        borderRight: '1px solid rgba(42,47,69,0.6)',
      }}
    >
      <div
        style={{
          fontSize: '0.62rem',
          fontWeight: 800,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: '#4a5568',
          padding: '2px 2px 6px',
        }}
      >
        Verbs
      </div>

      {IVR_PALETTE.map((type) => {
        const meta = NODE_META[type];
        return (
          <button
            key={type}
            type="button"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(PALETTE_DND_MIME, type);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onClick={() => handleClick(type)}
            title={meta.blurb}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              padding: '8px 10px',
              borderRadius: 9,
              textAlign: 'left',
              cursor: 'grab',
              color: '#cbd5e1',
              background: 'rgba(26,29,39,0.9)',
              border: '1px solid rgba(42,47,69,0.8)',
              transition: 'border-color 0.15s, background 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = `${meta.accent}88`;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'rgba(42,47,69,0.8)';
            }}
          >
            <span
              style={{
                width: 22,
                height: 22,
                borderRadius: 6,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '0.74rem',
                fontWeight: 800,
                color: meta.accent,
                background: `${meta.accent}1f`,
                flexShrink: 0,
              }}
            >
              {meta.glyph}
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <span style={{ fontSize: '0.76rem', fontWeight: 600 }}>{meta.label}</span>
              <span
                style={{
                  fontSize: '0.6rem',
                  color: '#64748b',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {meta.blurb}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
