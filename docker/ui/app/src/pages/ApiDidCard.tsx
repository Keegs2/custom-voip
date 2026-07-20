/**
 * ApiDidCard — one API DID rendered as a frosted, lift-on-hover glass card with
 * inline Voice URL + Status Callback editors (each tracks its own dirty / saved
 * flash state and saves independently via PATCH /api-dids/:id).
 *
 * Self-contained on the canonical glass kit (GlassCard / GlassChip / GLASS).
 *
 * React #310: all hooks sit unconditionally at the top of each component.
 */

import { useState, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApiDid, ApiDidUpdate } from '../types/apiDid';
import { apiRequest } from '../api/client';
import { GlassCard, GlassChip } from '../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../components/glass/glass';
import { Button } from '../components/ui/Button';
import { useToast } from '../components/ui/Toast';
import { fmt } from '../utils/format';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

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

  const [voiceField, setVoiceField] = useState<FieldState>({ value: did.voice_url, savedFlash: false });
  const [callbackField, setCallbackField] = useState<FieldState>({ value: did.status_callback ?? '', savedFlash: false });

  const voiceIsDirty = voiceField.value !== did.voice_url;
  const callbackIsDirty = callbackField.value !== (did.status_callback ?? '');

  const voiceMutation = useMutation({
    mutationFn: (value: string) => updateApiDid(did.id, { voice_url: value }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['api-dids'] });
      setVoiceField((prev) => ({ ...prev, savedFlash: true }));
      setTimeout(() => setVoiceField((prev) => ({ ...prev, savedFlash: false })), 1800);
      toastOk('Voice URL saved');
    },
    onError: (error: Error) => toastErr(error.message ?? 'Failed to save voice URL'),
  });

  const callbackMutation = useMutation({
    mutationFn: (value: string) => updateApiDid(did.id, { status_callback: value.trim() || null }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['api-dids'] });
      setCallbackField((prev) => ({ ...prev, savedFlash: true }));
      setTimeout(() => setCallbackField((prev) => ({ ...prev, savedFlash: false })), 1800);
      toastOk('Status callback URL saved');
    },
    onError: (error: Error) => toastErr(error.message ?? 'Failed to save status callback'),
  });

  const handleVoiceSave = useCallback(() => {
    const trimmed = voiceField.value.trim();
    if (!trimmed) { toastErr('Voice URL cannot be empty'); return; }
    voiceMutation.mutate(trimmed);
  }, [voiceField.value, voiceMutation, toastErr]);

  const handleCallbackSave = useCallback(() => {
    callbackMutation.mutate(callbackField.value.trim());
  }, [callbackField.value, callbackMutation]);

  const accent = did.enabled ? GLASS.accent : GLASS.textFaint;

  return (
    <GlassCard accent={accent}>
      <div style={{ padding: '22px 24px' }}>
        {/* Header: DID + status badge */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 20 }}>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: '1.2rem',
                fontWeight: 800,
                fontFamily: MONO,
                color: GLASS.text,
                lineHeight: 1.3,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                letterSpacing: '0.01em',
                textShadow: '0 1px 12px rgba(0,0,0,0.5)',
              }}
            >
              {fmt(did.did)}
            </div>
            <div style={{ fontSize: '0.72rem', fontFamily: MONO, color: GLASS.textMuted, marginTop: 3 }}>
              {did.did}
            </div>
          </div>
          <GlassChip label={did.enabled ? 'Active' : 'Disabled'} color={did.enabled ? GLASS.accent : GLASS.danger} dot />
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
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
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
    </GlassCard>
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

function UrlField({ id, label, labelSuffix, value, placeholder, isDirty, savedFlash, isSaving, onChange, onSave, note }: UrlFieldProps) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') onSave();
  };

  const border = savedFlash
    ? hexToRgba(GLASS.success, 0.6)
    : isDirty
      ? hexToRgba(GLASS.accent, 0.55)
      : 'rgba(255,255,255,0.12)';
  const ring = savedFlash
    ? `0 0 0 3px ${hexToRgba(GLASS.success, 0.2)}`
    : isDirty
      ? `0 0 0 3px ${hexToRgba(GLASS.accent, 0.18)}`
      : 'inset 0 1px 0 rgba(255,255,255,0.04)';

  return (
    <div>
      <label
        htmlFor={id}
        style={{
          display: 'block',
          fontSize: '0.7rem',
          fontWeight: 700,
          color: GLASS.textMuted,
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
              color: hexToRgba(GLASS.textMuted, 0.7),
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
            fontSize: '0.85rem',
            fontFamily: MONO,
            padding: '8px 12px',
            borderRadius: 10,
            border: `1px solid ${border}`,
            background: 'rgba(8,10,15,0.5)',
            color: GLASS.text,
            outline: 'none',
            transition: 'border-color 0.15s, box-shadow 0.15s',
            boxShadow: ring,
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            opacity: isSaving ? 0.5 : 1,
          }}
        />

        <Button variant="success" size="sm" disabled={!isDirty || isSaving} loading={isSaving} onClick={onSave}>
          Save
        </Button>
      </div>

      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.72rem', color: GLASS.textMuted }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 14,
            height: 14,
            borderRadius: '50%',
            border: '1px solid rgba(148,163,184,0.5)',
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
