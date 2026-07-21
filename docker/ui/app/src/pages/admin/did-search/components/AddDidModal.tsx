/**
 * AddDidModal — self-service add of a single DID to inventory. Uses the shared
 * <Modal> chrome; all form state + the live POST /numbers mutation come from
 * `useAddDidForm`. The backend normalizes the number (10-digit / 11-digit /
 * E.164 → E.164) and stamps the owning environment from its own DEPLOY_ENV, so
 * the form only collects the number plus optional state/notes and surfaces which
 * environment will own it.
 *
 * React #310: every hook is called unconditionally at the top; there is no
 * early return before them.
 */

import { Button } from '../../../../components/ui/Button';
import { Modal } from '../../../../components/ui/Modal';
import { FormField } from '../../../../components/ui/FormField';
import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import type { DidAllocatedEnv } from '../../../../types/didInventory';
import { ENV_META } from '../types';
import { useAddDidForm, useDidStats } from '../hooks';
import { EnvBadge } from './Chips';

interface AddDidModalProps {
  open: boolean;
  onClose: () => void;
}

/** Narrow the API's free-form deploy_env string to the EnvBadge union. Unknown
 *  values fall through to `undefined`, which EnvBadge renders as Production. */
function toAllocatedEnv(value: string | undefined): DidAllocatedEnv | undefined {
  return value && value in ENV_META ? (value as DidAllocatedEnv) : undefined;
}

export function AddDidModal({ open, onClose }: AddDidModalProps) {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const form = useAddDidForm(open, onClose);
  const { data: stats } = useDidStats();

  const ownedEnv = toAllocatedEnv(stats?.deploy_env);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add DID to Inventory"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={form.isPending}
            disabled={!form.did.trim() || form.isPending}
            onClick={form.submit}
          >
            Add DID
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Owning-environment hint */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '11px 14px',
            background: hexToRgba(GLASS.accent, 0.06),
            border: `1px solid ${hexToRgba(GLASS.accent, 0.18)}`,
            borderRadius: 12,
          }}
        >
          <span style={{ fontSize: '0.78rem', color: GLASS.textMuted }}>
            Owned by this environment:
          </span>
          <EnvBadge env={ownedEnv} />
        </div>

        {/* Phone number */}
        <FormField
          as="input"
          label="Phone number"
          required
          value={form.did}
          onChange={(e) => form.setDid((e.target as HTMLInputElement).value)}
          placeholder="+15084330693 or 5084330693"
          hint="10-digit, 11-digit, or E.164 — we'll normalize it"
        />

        {/* State */}
        <FormField
          as="input"
          label="State (optional)"
          value={form.state}
          onChange={(e) => form.setState((e.target as HTMLInputElement).value)}
          placeholder="MA"
        />

        {/* Notes */}
        <FormField
          as="textarea"
          label="Notes (optional)"
          value={form.notes}
          onChange={(e) => form.setNotes((e.target as HTMLTextAreaElement).value)}
          placeholder="Internal note about this number…"
        />
      </div>
    </Modal>
  );
}
