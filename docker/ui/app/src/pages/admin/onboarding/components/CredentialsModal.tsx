/**
 * CredentialsModal — shown after a successful approval. Surfaces the new
 * customer's login email + one-time temporary password (copyable) and the list
 * of provisioned DIDs, inside the shared (already-glassy) Modal primitive.
 */

import { useState, useCallback } from 'react';
import { Modal } from '../../../../components/ui/Modal';
import { Button } from '../../../../components/ui/Button';
import { useToast } from '../../../../components/ui/ToastContext';
import { GLASS } from '../../../../components/glass/glass';
import { fmt } from '../../../../utils/format';
import type { ApproveResponse } from '../../../../types/onboarding';
import {
  modalBanner,
  credBox,
  credCode,
  provisionedDidRow,
  fieldLabel,
  fieldValue,
  sectionLabel,
  MONO,
} from '../styles';

interface CredentialsModalProps {
  result: ApproveResponse;
  onClose: () => void;
}

export function CredentialsModal({ result, onClose }: CredentialsModalProps) {
  const [copied, setCopied] = useState(false);
  const { toastOk } = useToast();

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(result.user.temp_password).then(() => {
      setCopied(true);
      toastOk('Password copied to clipboard');
      setTimeout(() => setCopied(false), 2500);
    });
  }, [result.user.temp_password, toastOk]);

  return (
    <Modal
      open
      onClose={onClose}
      title="Account Provisioned"
      maxWidth="max-w-md"
      footer={
        <Button variant="primary" size="sm" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Success banner */}
        <div style={modalBanner(GLASS.success)}>
          Customer <strong style={{ color: '#86efac' }}>{result.customer.name}</strong> has been
          provisioned with {result.dids.length} DID{result.dids.length !== 1 ? 's' : ''}.
        </div>

        {/* Credentials block */}
        <div style={credBox}>
          <div>
            <span style={fieldLabel}>Login Email</span>
            <span style={{ ...fieldValue, fontFamily: MONO, fontSize: '0.85rem' }}>
              {result.user.email}
            </span>
          </div>

          <div>
            <span style={fieldLabel}>Temporary Password</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
              <code style={credCode}>{result.user.temp_password}</code>
              <Button variant="ghost" size="xs" onClick={handleCopy} style={{ flexShrink: 0 }}>
                {copied ? 'Copied!' : 'Copy'}
              </Button>
            </div>
          </div>
        </div>

        {/* Warning */}
        <div style={modalBanner(GLASS.warning)}>
          This temporary password will not be shown again. Send it to the customer securely.
        </div>

        {/* Provisioned DIDs */}
        {result.dids.length > 0 && (
          <div>
            <div style={sectionLabel(GLASS.accent)}>Provisioned DIDs</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {result.dids.map((d) => (
                <div key={d.did} style={provisionedDidRow}>
                  <span style={{ fontFamily: MONO, fontSize: '0.82rem', color: GLASS.text }}>
                    {fmt(d.did)}
                  </span>
                  <span style={{ fontSize: '0.75rem', color: GLASS.textMuted }}>
                    → {fmt(d.forward_to)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
