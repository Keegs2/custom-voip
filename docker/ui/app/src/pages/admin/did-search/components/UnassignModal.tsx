/**
 * UnassignModal — confirms returning an assigned DID to the available pool. Uses
 * the shared <Modal> chrome; the live POST /unassign mutation comes from
 * `useUnassignAction`.
 *
 * React #310: the action hook is called unconditionally at the top, before the
 * `if (!did)` guard.
 */

import { Button } from '../../../../components/ui/Button';
import { Modal } from '../../../../components/ui/Modal';
import { GLASS } from '../../../../components/glass/glass';
import { fmt } from '../../../../utils/format';
import type { DidInventoryItem } from '../../../../types/didInventory';
import { useUnassignAction } from '../hooks';
import { dangerNote } from '../styles';

interface UnassignModalProps {
  did: DidInventoryItem | null;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function UnassignModal({ did, open, onClose, onSuccess }: UnassignModalProps) {
  // ALL hooks first (React #310) — the guard comes after.
  const action = useUnassignAction(did, () => {
    onSuccess();
    onClose();
  });

  if (!did) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Unassign Number"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={action.isPending} onClick={action.submit}>
            Unassign
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ fontSize: '0.85rem', color: GLASS.textMuted, lineHeight: 1.6 }}>
          This will remove <strong style={{ color: GLASS.text }}>{fmt(did.did)}</strong> from{' '}
          <strong style={{ color: GLASS.text }}>{did.customer_name ?? 'this customer'}</strong> and
          return it to the available pool. This action takes effect immediately.
        </p>
        <div style={dangerNote}>
          Any active routing rules for this number will stop working immediately.
        </div>
      </div>
    </Modal>
  );
}
