import { useState, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApiDid } from '../types/apiDid';
import { updateApiDid } from '../api/apiDids';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { useToast } from '../components/ui/Toast';
import { fmt } from '../utils/format';

interface ApiDidCardProps {
  did: ApiDid;
  /** When false, fields render read-only (readonly users / admin customer-view). */
  canEdit?: boolean;
  /** Admin list view: show which customer owns this DID. */
  showCustomer?: boolean;
}

// Each editable field tracks its own dirty/saved state independently.
interface FieldState {
  value: string;
  savedFlash: boolean;
}

/**
 * Validate a webhook URL. Empty is allowed only for optional fields (caller
 * passes `required`). We require https:// for all non-empty values — webhooks
 * carry call state and must not be sent in the clear.
 *
 * Returns an error string, or null when valid.
 */
function validateWebhookUrl(value: string, required: boolean): string | null {
  const trimmed = value.trim();
  if (!trimmed) return required ? 'This URL is required' : null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'Enter a valid URL';
  }
  if (parsed.protocol !== 'https:') return 'URL must use https://';
  return null;
}

export function ApiDidCard({ did, canEdit = true, showCustomer = false }: ApiDidCardProps) {
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const [voiceField, setVoiceField] = useState<FieldState>({
    value: did.voice_url,
    savedFlash: false,
  });

  const [fallbackField, setFallbackField] = useState<FieldState>({
    value: did.fallback_url ?? '',
    savedFlash: false,
  });

  const [callbackField, setCallbackField] = useState<FieldState>({
    value: did.status_callback ?? '',
    savedFlash: false,
  });

  const voiceIsDirty = voiceField.value !== did.voice_url;
  const fallbackIsDirty = fallbackField.value !== (did.fallback_url ?? '');
  const callbackIsDirty = callbackField.value !== (did.status_callback ?? '');

  const voiceError = validateWebhookUrl(voiceField.value, true);
  const fallbackError = validateWebhookUrl(fallbackField.value, false);
  const callbackError = validateWebhookUrl(callbackField.value, false);

  // --- Voice URL mutation ---
  const voiceMutation = useMutation({
    mutationFn: (value: string) => updateApiDid(did.id, { voice_url: value }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['api-dids'] });
      setVoiceField((prev) => ({ ...prev, savedFlash: true }));
      setTimeout(() => setVoiceField((prev) => ({ ...prev, savedFlash: false })), 1800);
      toastOk('Voice URL saved');
    },
    onError: (error: Error) => {
      toastErr(error.message ?? 'Failed to save voice URL');
    },
  });

  // --- Fallback URL mutation ---
  const fallbackMutation = useMutation({
    mutationFn: (value: string) => updateApiDid(did.id, { fallback_url: value.trim() || null }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['api-dids'] });
      setFallbackField((prev) => ({ ...prev, savedFlash: true }));
      setTimeout(() => setFallbackField((prev) => ({ ...prev, savedFlash: false })), 1800);
      toastOk('Fallback URL saved');
    },
    onError: (error: Error) => {
      toastErr(error.message ?? 'Failed to save fallback URL');
    },
  });

  // --- Status callback mutation ---
  const callbackMutation = useMutation({
    mutationFn: (value: string) => updateApiDid(did.id, { status_callback: value.trim() || null }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['api-dids'] });
      setCallbackField((prev) => ({ ...prev, savedFlash: true }));
      setTimeout(() => setCallbackField((prev) => ({ ...prev, savedFlash: false })), 1800);
      toastOk('Status callback URL saved');
    },
    onError: (error: Error) => {
      toastErr(error.message ?? 'Failed to save status callback');
    },
  });

  const handleVoiceSave = useCallback(() => {
    if (voiceError) {
      toastErr(voiceError);
      return;
    }
    voiceMutation.mutate(voiceField.value.trim());
  }, [voiceField.value, voiceError, voiceMutation, toastErr]);

  const handleFallbackSave = useCallback(() => {
    if (fallbackError) {
      toastErr(fallbackError);
      return;
    }
    fallbackMutation.mutate(fallbackField.value.trim());
  }, [fallbackField.value, fallbackError, fallbackMutation, toastErr]);

  const handleCallbackSave = useCallback(() => {
    if (callbackError) {
      toastErr(callbackError);
      return;
    }
    callbackMutation.mutate(callbackField.value.trim());
  }, [callbackField.value, callbackError, callbackMutation, toastErr]);

  const accent = '#3b82f6';

  return (
    <div
      className="glass-surface glass-hover"
      style={{
        padding: '24px',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Top accent line */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 32,
          right: 32,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${accent}80, transparent)`,
          opacity: 0.35,
        }}
      />

      {/* Header: DID + status badge */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 20,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: '1.2rem',
              fontWeight: 700,
              color: '#e2e8f0',
              lineHeight: 1.3,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              letterSpacing: '-0.01em',
            }}
          >
            {fmt(did.did)}
          </div>
          <div
            style={{
              fontSize: '0.72rem',
              fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
              color: '#718096',
              marginTop: 3,
            }}
          >
            {did.did}
            {showCustomer && (did.customer_name || did.customer_id) && (
              <span style={{ color: '#475569' }}>
                {'  ·  '}
                {did.customer_name ?? `Customer ${did.customer_id}`}
              </span>
            )}
          </div>
        </div>
        <div style={{ flexShrink: 0, marginTop: 2 }}>
          <Badge variant={did.enabled ? 'active' : 'disabled'}>
            {did.enabled ? 'Active' : 'Disabled'}
          </Badge>
        </div>
      </div>

      {/* Voice URL field */}
      <UrlField
        id={`apidid-voice-${did.id}`}
        label="Voice URL"
        value={voiceField.value}
        placeholder="https://your-app.com/voice"
        isDirty={voiceIsDirty}
        savedFlash={voiceField.savedFlash}
        isSaving={voiceMutation.isPending}
        error={voiceIsDirty ? voiceError : null}
        readOnly={!canEdit}
        onChange={(v) => setVoiceField((prev) => ({ ...prev, value: v }))}
        onSave={handleVoiceSave}
        note="Called when a call arrives on this number"
      />

      {/* Fallback URL field */}
      <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid rgba(59,130,246,0.10)' }}>
        <UrlField
          id={`apidid-fallback-${did.id}`}
          label="Fallback URL"
          labelSuffix="optional"
          value={fallbackField.value}
          placeholder="https://your-app.com/fallback"
          isDirty={fallbackIsDirty}
          savedFlash={fallbackField.savedFlash}
          isSaving={fallbackMutation.isPending}
          error={fallbackIsDirty ? fallbackError : null}
          readOnly={!canEdit}
          onChange={(v) => setFallbackField((prev) => ({ ...prev, value: v }))}
          onSave={handleFallbackSave}
          note="Used if the Voice URL is unreachable or errors"
        />
      </div>

      {/* Status Callback URL field */}
      <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid rgba(59,130,246,0.10)' }}>
        <UrlField
          id={`apidid-cb-${did.id}`}
          label="Status Callback URL"
          labelSuffix="optional"
          value={callbackField.value}
          placeholder="https://your-app.com/status"
          isDirty={callbackIsDirty}
          savedFlash={callbackField.savedFlash}
          isSaving={callbackMutation.isPending}
          error={callbackIsDirty ? callbackError : null}
          readOnly={!canEdit}
          onChange={(v) => setCallbackField((prev) => ({ ...prev, value: v }))}
          onSave={handleCallbackSave}
          note="Receives call lifecycle events (answered, completed, etc.)"
        />
      </div>
    </div>
  );
}

interface UrlFieldProps {
  id: string;
  label: string;
  labelSuffix?: string;
  value: string;
  placeholder: string;
  isDirty: boolean;
  savedFlash: boolean;
  isSaving: boolean;
  /** Validation error to surface (only when dirty). */
  error: string | null;
  /** When true, the input and save button are disabled. */
  readOnly: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  note: string;
}

function UrlField({
  id,
  label,
  labelSuffix,
  value,
  placeholder,
  isDirty,
  savedFlash,
  isSaving,
  error,
  readOnly,
  onChange,
  onSave,
  note,
}: UrlFieldProps) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') onSave();
  };

  const borderColor = error
    ? '#ef4444'
    : savedFlash
    ? '#22c55e'
    : isDirty
    ? '#3b82f6'
    : 'rgba(59,130,246,0.14)';

  const boxShadow = error
    ? '0 0 0 3px rgba(239,68,68,0.18)'
    : savedFlash
    ? '0 0 0 3px rgba(34,197,94,0.2)'
    : isDirty
    ? '0 0 0 3px rgba(59,130,246,0.2)'
    : 'none';

  const errorId = `${id}-error`;

  return (
    <div>
      <label
        htmlFor={id}
        style={{
          display: 'block',
          fontSize: '0.7rem',
          fontWeight: 700,
          color: '#718096',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginBottom: 8,
        }}
      >
        {label}
        {labelSuffix && (
          <span
            style={{
              marginLeft: 6,
              color: 'rgba(113,128,150,0.7)',
              fontWeight: 400,
              textTransform: 'none',
              letterSpacing: 'normal',
              fontSize: '0.68rem',
            }}
          >
            ({labelSuffix})
          </span>
        )}
      </label>

      <div className="flex gap-2 items-center">
        <input
          id={id}
          type="url"
          value={value}
          placeholder={placeholder}
          disabled={isSaving || readOnly}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: '0.88rem',
            padding: '8px 12px',
            borderRadius: 8,
            border: `1px solid ${borderColor}`,
            background: 'rgba(19,21,29,0.8)',
            color: '#e2e8f0',
            outline: 'none',
            transition: 'border-color 0.15s, box-shadow 0.15s',
            boxShadow,
            opacity: isSaving ? 0.5 : 1,
          }}
        />

        {!readOnly && (
          <Button
            variant="success"
            size="sm"
            disabled={!isDirty || isSaving || error !== null}
            loading={isSaving}
            onClick={onSave}
          >
            Save
          </Button>
        )}
      </div>

      {error ? (
        <div id={errorId} role="alert" style={{ marginTop: 8, fontSize: '0.72rem', color: '#f87171' }}>
          {error}
        </div>
      ) : (
        <div
          style={{
            marginTop: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: '0.72rem',
            color: '#718096',
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 14,
              height: 14,
              borderRadius: '50%',
              border: '1px solid rgba(113,128,150,0.5)',
              fontSize: '0.55rem',
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            i
          </span>
          <span>{note}</span>
        </div>
      )}
    </div>
  );
}
