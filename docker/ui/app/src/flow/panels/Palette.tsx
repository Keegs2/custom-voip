/**
 * Palette — the IVR blocks, grouped in the order callers meet them. Drag a
 * block onto the canvas, or activate it (click / Enter): it is added after
 * the selected block's first free exit and connected, or — with nothing
 * selected — beside the flow. Either way the new block is selected, so its
 * settings open at once.
 */
import type { CSSProperties, DragEvent } from 'react';
import { BLOCKS, PALETTE_GROUPS, outHandles } from '../model/blocks';
import { useFlowStoreApi } from '../store/flowStore';
import type { IvrNodeType } from '../../types/ivr';
import { BlockIcon } from '../canvas/BlockIcon';
import { BLOCK_DND_MIME } from '../canvas/FlowCanvas';

export function Palette({ disabled, previewing }: { disabled: boolean; previewing: boolean }) {
  const store = useFlowStoreApi();

  const add = (type: IvrNodeType) => {
    const s = store.getState();
    const sel = s.selectedId ? s.nodes.find((n) => n.id === s.selectedId) : undefined;
    const free = sel ? outHandles(sel).find((h) => !s.edges.some((e) => e.source === sel.id && e.sourceHandle === h.id)) : undefined;
    let id: string;
    if (sel && free) {
      id = s.addBlock(type, { from: { source: sel.id, handle: free.id } });
    } else {
      const maxX = Math.max(0, ...s.nodes.map((n) => n.position.x));
      const minY = Math.min(0, ...s.nodes.map((n) => n.position.y));
      id = s.addBlock(type, { position: { x: maxX + 320, y: minY } });
    }
    store.getState().focusBlock(id);
  };

  const onDragStart = (e: DragEvent, type: IvrNodeType) => {
    e.dataTransfer.setData(BLOCK_DND_MIME, type);
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <div className="ivr-palette">
      <p className="ivr-side-hint">
        {previewing
          ? 'You are looking at a published version. Go back to your draft to edit.'
          : disabled
            ? 'This flow is view-only.'
            : 'Drag a block onto the canvas, or click one to add it after the selected block.'}
      </p>
      {PALETTE_GROUPS.map((g) => (
        <section key={g.id} className="ivr-pal-group" aria-labelledby={`ivr-pal-${g.id}`}>
          <h3 id={`ivr-pal-${g.id}`} className="ivr-pal-h">
            {g.label}
          </h3>
          <ul className="ivr-pal-list">
            {g.types.map((t) => (
              <li key={t}>
                <button
                  type="button"
                  className="ivr-pal-item"
                  style={{ '--ivr-hue': `var(--ivr-${t})`, '--ivr-ink': `var(--ivr-${t}-ink)` } as CSSProperties}
                  draggable={!disabled}
                  disabled={disabled}
                  onDragStart={(e) => onDragStart(e, t)}
                  onClick={() => add(t)}
                  aria-label={`Add ${BLOCKS[t].label}: ${BLOCKS[t].description}`}
                >
                  <span className="ivr-pal-icon">
                    <BlockIcon type={t} size={15} />
                  </span>
                  <span className="ivr-pal-text">
                    <span className="ivr-pal-name">{BLOCKS[t].label}</span>
                    <span className="ivr-pal-desc">{BLOCKS[t].hint}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
