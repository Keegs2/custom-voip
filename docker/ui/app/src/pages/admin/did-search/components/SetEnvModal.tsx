/**
 * SetEnvModal — changes which environment (prod / sandbox / reserved) owns a DID
 * for call routing. Uses the shared <Modal> glass chrome; the env-picker state and
 * the live POST /numbers/{did}/allocation mutation come from `useSetAllocation`.
 *
 * The three environments render as a segmented control tinted by ENV_META so it
 * matches the EnvBadge shown in the inventory table.
 *
 * React #310: the action hook is called unconditionally at the top, before the
 * `if (!did)` guard.
 */

import type { CSSProperties } from 'react';
import { Button } from '../../../../components/ui/Button';
import { Modal } from '../../../../components/ui/Modal';
import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import { fmt } from '../../../../utils/format';
import type { DidAllocatedEnv, DidInventoryItem } from '../../../../types/didInventory';
import { ENV_META } from '../types';
import { useSetAllocation } from '../hooks';

interface SetEnvModalProps {
  did: DidInventoryItem | null;
  open: boolean;
  onClose: () => void;
}

/** The three owning environments, in display order. */
const ENV_ORDER: ReadonlyArray<DidAllocatedEnv> = ['prod', 'sandbox', 'reserved'];

function segmentStyle(active: boolean, color: string): CSSProperties {
  return {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    padding: '11px 10px',
    borderRadius: 11,
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '0.8rem',
    fontWeight: active ? 700 : 500,
    color: active ? color : GLASS.textMuted,
    background: active ? hexToRgba(color, 0.14) : 'rgba(255,255,255,0.03)',
    border: `1px solid ${active ? hexToRgba(color, 0.4) : 'rgba(255,255,255,0.10)'}`,
    boxShadow: active
      ? `inset 0 1px 0 rgba(255,255,255,0.10), 0 0 0 3px ${hexToRgba(color, 0.1)}`
      : 'inset 0 1px 0 rgba(255,255,255,0.05)',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    transition: 'background 0.18s, color 0.18s, border-color 0.18s, box-shadow 0.18s',
  };
}

export function SetEnvModal({ did, open, onClose }: SetEnvModalProps) {
  // ALL hooks first (React #310) — the guard comes after.
  const action = useSetAllocation(did, onClose);

  if (!did) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Set Environment — ${fmt(did.did)}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={action.isPending}
            disabled={action.isPending}
            onClick={action.submit}
          >
            Save
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ fontSize: '0.85rem', color: GLASS.textMuted, lineHeight: 1.6 }}>
          Controls which environment owns this number for call routing.
        </p>

        <div
          role="radiogroup"
          aria-label="Owning environment"
          style={{ display: 'flex', gap: 10 }}
        >
          {ENV_ORDER.map((env) => {
            const meta = ENV_META[env];
            const active = action.selectedEnv === env;
            return (
              <button
                key={env}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => action.setSelectedEnv(env)}
                style={segmentStyle(active, meta.color)}
              >
                <span
                  aria-hidden
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: meta.color,
                    boxShadow: active ? `0 0 8px ${meta.color}` : 'none',
                    opacity: active ? 1 : 0.55,
                  }}
                />
                {meta.label}
              </button>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
