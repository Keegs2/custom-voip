/**
 * GlassApiDidCard — one programmable number as a frosted, lift-on-hover glass
 * card. Editable Voice URL + Status Callback delegate to <WebhookField>; all
 * state + live PATCH mutations come from `useApiDidEditor`.
 */

import { GlassCard, GlassChip } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import { Button } from '../../../components/ui/Button';
import { fmt } from '../../../utils/format';
import type { ApiDid } from '../../../types/apiDid';
import { useApiDidEditor } from '../hooks';
import { WebhookField } from './WebhookField';
import {
  cardInset,
  cardHeader,
  cardDid,
  cardSub,
  cardSection,
  cardActions,
  toggleBtn,
} from '../styles';

interface GlassApiDidCardProps {
  did: ApiDid;
  isAdmin: boolean;
  canManage: boolean;
  showCustomer: boolean;
  onDelete: (d: ApiDid) => void;
  deleting: boolean;
  index: number;
}

export function GlassApiDidCard({ did, isAdmin, canManage, showCustomer, onDelete, deleting, index }: GlassApiDidCardProps) {
  const ed = useApiDidEditor(did);
  const accent = did.enabled ? GLASS.accent : GLASS.textFaint;

  return (
    <GlassCard index={index} accent={accent}>
      <div style={cardInset}>
        {/* Header: DID + status */}
        <div style={cardHeader}>
          <div style={{ minWidth: 0 }}>
            <div style={cardDid}>{fmt(did.did)}</div>
            <div style={cardSub}>
              {showCustomer && did.customer_name ? `${did.customer_name} · ` : ''}
              {did.did} · added {new Date(did.created_at).toLocaleDateString()}
            </div>
          </div>
          <GlassChip
            label={did.enabled ? 'Active' : 'Disabled'}
            color={did.enabled ? GLASS.accent : GLASS.danger}
            dot
          />
        </div>

        <WebhookField
          label="Voice URL"
          hint="Called with an HTTP POST when a call arrives — return TwiML to control the call."
          value={ed.voice}
          saved={did.voice_url}
          onChange={ed.setVoice}
          onSave={ed.saveVoice}
          saving={ed.voiceSaving}
          readOnly={!canManage}
        />

        <div style={cardSection}>
          <WebhookField
            label="Status Callback URL"
            optional
            hint="Receives call lifecycle events (initiated, ringing, answered, completed)."
            value={ed.callback}
            saved={did.status_callback ?? ''}
            onChange={ed.setCallback}
            onSave={ed.saveCallback}
            saving={ed.callbackSaving}
            readOnly={!canManage}
          />
        </div>

        {canManage && (
          <div style={cardActions}>
            <button
              type="button"
              disabled={ed.toggling}
              onClick={ed.toggleEnabled}
              style={toggleBtn(did.enabled, ed.toggling)}
            >
              {did.enabled ? 'Disable number' : 'Enable number'}
            </button>
            {isAdmin && (
              <Button variant="danger" size="sm" loading={deleting} onClick={() => onDelete(did)}>
                Delete
              </Button>
            )}
          </div>
        )}
      </div>
    </GlassCard>
  );
}
