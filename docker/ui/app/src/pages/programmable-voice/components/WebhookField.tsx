/**
 * WebhookField — an editable webhook URL field (copy + save), presentational.
 * Validation/dirty state is derived from props; the live save is owned by the
 * parent card's editor hook. Copy uses the toast system for feedback.
 *
 * React #310: the single hook (useToast) sits at the top, before any return.
 */

import { Copy } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { useToast } from '../../../components/ui/Toast';
import { isValidUrl, copyText } from '../hooks';
import {
  fieldLabel,
  fieldLabelOptional,
  urlInput,
  copyBtn,
  fieldHint,
  infoDot,
} from '../styles';

interface WebhookFieldProps {
  label: string;
  optional?: boolean;
  hint: string;
  value: string;
  saved: string;
  onChange: (v: string) => void;
  onSave: () => void;
  saving: boolean;
  readOnly: boolean;
}

export function WebhookField({ label, optional, hint, value, saved, onChange, onSave, saving, readOnly }: WebhookFieldProps) {
  const { toastOk, toastErr } = useToast();
  const dirty = value.trim() !== saved.trim();
  const invalid = value.trim().length > 0 && !isValidUrl(value.trim());

  async function handleCopy() {
    if (!saved.trim()) { toastErr('Nothing to copy yet'); return; }
    const ok = await copyText(saved.trim());
    if (ok) toastOk(`${label} copied`);
    else toastErr('Copy failed — copy manually');
  }

  return (
    <div>
      <label style={fieldLabel}>
        {label}
        {optional && <span style={fieldLabelOptional}>(optional)</span>}
      </label>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="url"
          value={value}
          readOnly={readOnly}
          placeholder="https://your-app.com/voice"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !readOnly) onSave(); }}
          style={urlInput(dirty, invalid)}
        />
        <button type="button" onClick={() => void handleCopy()} title="Copy to clipboard" style={copyBtn}>
          <Copy size={13} />
          Copy
        </button>
        {!readOnly && (
          <Button variant="success" size="sm" disabled={!dirty || invalid} loading={saving} onClick={onSave}>
            Save
          </Button>
        )}
      </div>

      <p style={fieldHint(invalid)}>
        <span style={infoDot}>i</span>
        {invalid ? 'Enter a valid http(s) URL' : hint}
      </p>
    </div>
  );
}
