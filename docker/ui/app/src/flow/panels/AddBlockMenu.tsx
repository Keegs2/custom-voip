/**
 * AddBlockMenu — "Add" on a free exit of a block (canvas): choose what
 * comes next; the new block is created, connected to that exit and
 * selected, so its settings open straight away.
 */
import type { CSSProperties } from 'react';
import { VmDialog } from '../../pages/voicemail/VmDialog';
import { BLOCKS, PALETTE_GROUPS, handleLabel } from '../model/blocks';
import { blockTitle } from '../model/summary';
import { useFlow, useFlowStoreApi } from '../store/flowStore';
import { BlockIcon } from '../canvas/BlockIcon';

export interface AddRequest {
  source: string;
  handle: string;
}

export function AddBlockMenu({ request, onClose }: { request: AddRequest; onClose: () => void }) {
  const store = useFlowStoreApi();
  const source = useFlow((s) => s.nodes.find((n) => n.id === request.source) ?? null);
  const where = source ? `${source.type === 'entry' ? 'Start' : blockTitle(source)} → ${handleLabel(source, request.handle)}` : '';
  return (
    <VmDialog title="What happens next?" sub={where ? <>After <strong>{where}</strong>.</> : undefined} onClose={onClose} width={520}>
      <div className="ivr-addmenu">
        {PALETTE_GROUPS.map((g) => (
          <section key={g.id} aria-label={g.label}>
            <h3 className="ivr-pal-h">{g.label}</h3>
            <div className="ivr-addmenu-row">
              {g.types.map((t, i) => (
                <button
                  key={t}
                  type="button"
                  className="ivr-pal-item"
                  style={{ '--ivr-hue': `var(--ivr-${t})`, '--ivr-ink': `var(--ivr-${t}-ink)` } as CSSProperties}
                  data-autofocus={g.id === 'talk' && i === 0 ? true : undefined}
                  onClick={() => {
                    const id = store.getState().addBlock(t, { from: { source: request.source, handle: request.handle } });
                    store.getState().focusBlock(id);
                    onClose();
                  }}
                >
                  <span className="ivr-pal-icon">
                    <BlockIcon type={t} size={15} />
                  </span>
                  <span className="ivr-pal-text">
                    <span className="ivr-pal-name">{BLOCKS[t].label}</span>
                    <span className="ivr-pal-desc">{BLOCKS[t].description}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </VmDialog>
  );
}
