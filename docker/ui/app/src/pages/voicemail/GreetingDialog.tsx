/**
 * GreetingDialog — make a custom greeting, entirely in the browser:
 *
 *   Record  → mic (Web Audio PCM capture, auto-stop at 2:00) ─┐
 *   Upload  → any audio file → decodeAudioData ───────────────┤
 *                                                            ↓
 *           downmix → 16 kHz (OfflineAudioContext) → PCM16 WAV → limits (≤ 2:00, ≤ 5 MB)
 *                                                            ↓
 *           preview (plays the local WAV) → label → Save → POST raw audio/wav
 *
 * Nothing is uploaded until Save. The capture, conversion and preview are
 * the shared useAudioCapture + AudioCapturePanel (the IVR prompt dialog uses
 * the same pair at 8 kHz); the preview URL is revoked when replaced or when
 * the dialog closes, and recording is cancelled (mic released) if the dialog
 * closes mid-take.
 */
import { useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Greeting, Mailbox } from '../../types/voicemail';
import { uploadGreeting } from '../../api/voicemail';
import { useToast } from '../../components/ui/ToastContext';
import { VmDialog } from './VmDialog';
import { AudioCapturePanel } from './AudioCapturePanel';
import { useAudioCapture } from './useAudioCapture';
import { invalidateVoicemail, vmErrorText } from './voicemailData';
import type { GreetingAudio } from './audio/transcode';

export interface GreetingDialogProps {
  mailbox: Mailbox;
  onClose: () => void;
  onSaved?: (greeting: Greeting) => void;
}

function defaultLabel(): string {
  const d = new Date();
  return `Greeting ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

export function GreetingDialog({ mailbox, onClose, onSaved }: GreetingDialogProps) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const queryClient = useQueryClient();
  const { toastOk } = useToast();
  const capture = useAudioCapture();
  const [label, setLabel] = useState(defaultLabel);
  const [activate, setActivate] = useState(true);
  const labelId = useId();
  const activateId = useId();

  const save = useMutation({
    mutationFn: (audio: GreetingAudio) =>
      uploadGreeting(mailbox.id, audio.wav, { label: label.trim() || 'Greeting', activate }),
    onSuccess: (greeting) => {
      invalidateVoicemail(queryClient);
      toastOk(activate ? 'Greeting saved — callers hear it now.' : 'Greeting saved.');
      onSaved?.(greeting);
      onClose();
    },
  });

  // ── Derived (after all hooks) ──
  const ready = capture.ready;

  const closeSafely = () => {
    if (save.isPending) return;
    onClose();
  };

  return (
    <VmDialog
      title="Add a greeting"
      sub={
        <>
          For <strong>{mailbox.label}</strong>. Up to 2 minutes. Callers hear it before the beep.
        </>
      }
      onClose={closeSafely}
      busy={save.isPending}
      width={560}
      footer={
        <>
          <button type="button" className="dl-btn dl-btn-ghost" onClick={closeSafely} disabled={save.isPending}>
            Cancel
          </button>
          <button
            type="button"
            className="dl-btn dl-btn-primary"
            disabled={!ready || save.isPending || label.trim().length === 0}
            onClick={() => ready && save.mutate(ready.audio)}
          >
            {save.isPending && <span className="vm-spin vm-spin-light" aria-hidden="true" />}
            {save.isPending ? 'Saving…' : 'Save greeting'}
          </button>
        </>
      }
    >
      <AudioCapturePanel
        capture={capture}
        busy={save.isPending}
        onSourceSwitched={() => save.reset()}
        previewLabel="greeting preview"
      >
        <div className="vm-field">
          <label className="dl-flabel" htmlFor={labelId}>
            Name
          </label>
          <input
            id={labelId}
            className="dl-input vm-input-full"
            value={label}
            maxLength={120}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <label className="vm-check" htmlFor={activateId}>
          <input id={activateId} type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
          Use this greeting now
        </label>
      </AudioCapturePanel>

      {save.isError && (
        <div className="dl-banner dl-banner-err vm-gap-top" role="alert">
          {vmErrorText(save.error, 'The greeting couldn’t be saved. Try again.')}
        </div>
      )}
    </VmDialog>
  );
}
