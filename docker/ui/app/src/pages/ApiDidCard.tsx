import { useState, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApiDid, ApiDidUpdate } from '../types/apiDid';
import { apiRequest } from '../api/client';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { useToast } from '../components/ui/Toast';
import { fmt } from '../utils/format';
import { cn } from '../utils/cn';

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

  return (
    <div
      className={cn(
        'bg-[#1a1d27] border border-[#2a2f45] rounded-xl p-5',
        'shadow-[0_1px_3px_rgba(0,0,0,.4)]',
        'transition-all duration-200 hover:border-[#363c57]',
      )}
    >
      {/* Header: DID + status badge */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <div className="text-[1.2rem] font-bold text-[#e2e8f0] leading-snug truncate">
            {fmt(did.did)}
          </div>
          <div className="text-[0.72rem] font-mono text-[#718096] mt-0.5">
            {did.did}
          </div>
        </div>
        <div className="flex-shrink-0 mt-0.5">
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
      <div className="mt-3.5 pt-3.5 border-t border-[#2a2f45]">
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
        className="block text-[0.7rem] font-bold text-[#718096] uppercase tracking-[0.7px] mb-1.5"
      >
        {label}
        {labelSuffix && (
          <span className="ml-1.5 text-[#718096]/70 normal-case font-normal tracking-normal text-[0.68rem]">
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
          className={cn(
            'flex-1 min-w-0',
            'text-[0.88rem] px-3 py-[8px] rounded-lg',
            'border bg-[#1e2130] text-[#e2e8f0]',
            'outline-none transition-[border-color,box-shadow] duration-150',
            'placeholder:text-[#718096] placeholder:text-[0.82rem]',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            savedFlash
              ? 'border-[#22c55e] shadow-[0_0_0_3px_rgba(34,197,94,0.2)]'
              : isDirty
              ? 'border-[#3b82f6] shadow-[0_0_0_3px_rgba(59,130,246,0.2)]'
              : 'border-[#2a2f45] focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.28)]',
          )}
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

      <div className="mt-1.5 flex items-center gap-1.5 text-[0.72rem] text-[#718096]">
        <span
          className={cn(
            'inline-flex items-center justify-center',
            'w-3.5 h-3.5 rounded-full border border-[#718096]/50',
            'text-[0.55rem] font-bold flex-shrink-0',
          )}
        >
          i
        </span>
        <span>{note}</span>
      </div>
    </div>
  );
}
