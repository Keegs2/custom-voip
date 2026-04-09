import { useState, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApiDid, ApiDidUpdate } from '../types/apiDid';
import { apiRequest } from '../api/client';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { useToast } from '../components/ui/Toast';
import { fmt } from '../utils/format';

interface ApiDidCardProps {
  did: ApiDid;
}

async function updateApiDid(id: number, data: ApiDidUpdate): Promise<ApiDid> {
  return apiRequest('PATCH', `/api-dids/${id}`, data);
}

// Each editable field tracks its own dirty/saved state independently.
interface FieldState {
  value: string;
  savedFlash: boolean;
}

export function ApiDidCard({ did }: ApiDidCardProps) {
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const [voiceField, setVoiceField] = useState<FieldState>({
    value: did.voice_url,
    savedFlash: false,
  });

  const [callbackField, setCallbackField] = useState<FieldState>({
    value: did.status_callback ?? '',
    savedFlash: false,
  });

  const voiceIsDirty = voiceField.value !== did.voice_url;
  const callbackIsDirty = callbackField.value !== (did.status_callback ?? '');

  // --- Voice URL mutation ---
  const voiceMutation = useMutation({
    mutationFn: (value: string) =>
      updateApiDid(did.id, { voice_url: value }),

    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['api-dids'] });
      setVoiceField((prev) => ({ ...prev, savedFlash: true }));
      setTimeout(
        () => setVoiceField((prev) => ({ ...prev, savedFlash: false })),
        1800,
      );
      toastOk('Voice URL saved');
    },

    onError: (error: Error) => {
      toastErr(error.message ?? 'Failed to save voice URL');
    },
  });

  // --- Status callback mutation ---
  const callbackMutation = useMutation({
    mutationFn: (value: string) =>
      updateApiDid(did.id, { status_callback: value.trim() || null }),

    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['api-dids'] });
      setCallbackField((prev) => ({ ...prev, savedFlash: true }));
      setTimeout(
        () => setCallbackField((prev) => ({ ...prev, savedFlash: false })),
        1800,
      );
      toastOk('Status callback URL saved');
    },

    onError: (error: Error) => {
      toastErr(error.message ?? 'Failed to save status callback');
    },
  });

  const handleVoiceSave = useCallback(() => {
    const trimmed = voiceField.value.trim();
    if (!trimmed) {
      toastErr('Voice URL cannot be empty');
      return;
    }
    voiceMutation.mutate(trimmed);
  }, [voiceField.value, voiceMutation, toastErr]);

  const handleCallbackSave = useCallback(() => {
    callbackMutation.mutate(callbackField.value.trim());
  }, [callbackField.value, callbackMutation]);

  const accent = '#a855f7';

  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 16,
        padding: '24px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
        transition: 'border-color 0.3s, box-shadow 0.3s',
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
              fontFamily: 'monospace',
              color: '#718096',
              marginTop: 3,
            }}
          >
            {did.did}
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
        onChange={(v) => setVoiceField((prev) => ({ ...prev, value: v }))}
        onSave={handleVoiceSave}
        note="Called when a call arrives on this number"
      />

      {/* Status Callback URL field */}
      <div
        style={{
          marginTop: 16,
          paddingTop: 16,
          borderTop: '1px solid rgba(42,47,69,0.5)',
        }}
      >
        <UrlField
          id={`apidid-cb-${did.id}`}
          label="Status Callback URL"
          labelSuffix="optional"
          value={callbackField.value}
          placeholder="https://your-app.com/status"
          isDirty={callbackIsDirty}
          savedFlash={callbackField.savedFlash}
          isSaving={callbackMutation.isPending}
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
  onChange,
  onSave,
  note,
}: UrlFieldProps) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') onSave();
  };

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
          letterSpacing: '0.07em',
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
          disabled={isSaving}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: '0.88rem',
            padding: '8px 12px',
            borderRadius: 8,
            border: `1px solid ${
              savedFlash
                ? '#22c55e'
                : isDirty
                ? '#3b82f6'
                : 'rgba(42,47,69,0.8)'
            }`,
            background: 'rgba(19,21,29,0.8)',
            color: '#e2e8f0',
            outline: 'none',
            transition: 'border-color 0.15s, box-shadow 0.15s',
            boxShadow: savedFlash
              ? '0 0 0 3px rgba(34,197,94,0.2)'
              : isDirty
              ? '0 0 0 3px rgba(59,130,246,0.2)'
              : 'none',
            opacity: isSaving ? 0.5 : 1,
          }}
        />

        <Button
          variant="success"
          size="sm"
          disabled={!isDirty || isSaving}
          loading={isSaving}
          onClick={onSave}
        >
          Save
        </Button>
      </div>

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
    </div>
  );
}
