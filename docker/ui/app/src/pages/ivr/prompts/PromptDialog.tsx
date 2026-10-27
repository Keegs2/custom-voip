/**
 * PromptDialog — make a new message (contract §8.2 prompts, §4 audio):
 *
 *   Type text → choose a voice → Preview (rendered, not stored) → Save (TTS)
 *   Record    ┐ the shared voicemail capture (useAudioCapture +
 *   Upload    ┘ AudioCapturePanel) at 8 kHz mono PCM16 — the canonical
 *               prompt format — then a multipart upload
 *
 * Opened from the Messages panel and inline from Play message / Menu /
 * Hang up blocks (`onCreated` lets a block pick the new message at once).
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Mic, Type, Upload, Volume2 } from 'lucide-react';
import { createTtsPrompt, previewTts, uploadPrompt } from '../../../api/ivr';
import type { Prompt } from '../../../types/ivr';
import { useToast } from '../../../components/ui/ToastContext';
import { Select, type SelectOption } from '../../../components/ui/Select';
import { VmDialog } from '../../voicemail/VmDialog';
import { Player } from '../../voicemail/Player';
import { AudioCapturePanel } from '../../voicemail/AudioCapturePanel';
import { useAudioCapture, type CaptureSource } from '../../voicemail/useAudioCapture';
import { useIvrWorkspace } from '../IvrContext';
import { invalidateIvr, ivrErrorText, ivrKeys, useVoices } from '../ivrData';
import { voiceLabel } from '../format';

/** The prompt format (docs/IVR_INTERFACES.md §4): 8 kHz mono PCM16. */
export const PROMPT_SAMPLE_RATE = 8000;
export const TTS_MAX_CHARS = 1000;

type Mode = 'tts' | CaptureSource;

export interface PromptDialogProps {
  onClose: () => void;
  onCreated?: (prompt: Prompt) => void;
  /** Where it opened from, for the subtitle ("for the Main menu block"). */
  forWhat?: string;
}

function defaultName(text: string): string {
  // The first sentence, up to ~7 words: "Thanks for calling Granite Telephony".
  const sentence = text.trim().replace(/\s+/g, ' ').split(/(?<=[.!?])\s/)[0].replace(/[.!?]+$/, '');
  const words = sentence.split(' ').slice(0, 7).join(' ');
  if (words) return words.length > 60 ? `${words.slice(0, 57)}…` : words;
  const d = new Date();
  return `Message ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

export function PromptDialog({ onClose, onCreated, forWhat }: PromptDialogProps) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const ws = useIvrWorkspace();
  const queryClient = useQueryClient();
  const { toastOk } = useToast();
  const voices = useVoices(ws.scope);
  const capture = useAudioCapture({ sampleRate: PROMPT_SAMPLE_RATE, noun: 'message', initialSource: 'record' });
  const [pickedMode, setMode] = useState<Mode>('tts');
  const [text, setText] = useState('');
  const [voice, setVoice] = useState<string>('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  const ids = { name: useId(), text: useId(), voice: useId(), mode: useId() };

  // Free the preview audio when it is replaced or the dialog closes.
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const voiceList = useMemo(() => voices.data ?? [], [voices.data]);
  const voiceOptions = useMemo<SelectOption[]>(() => voiceList.map((v) => ({ value: v.id, label: voiceLabel(v) })), [voiceList]);
  const chosenVoice = voice || voiceList[0]?.id || '';
  // No voice list (the TTS sidecar is down): Type text is unavailable, Record is the default.
  const ttsUnavailable = voices.isError || (voices.isSuccess && voiceList.length === 0);
  const mode: Mode = ttsUnavailable && pickedMode === 'tts' ? 'record' : pickedMode;
  const effectiveName = nameTouched ? name : defaultName(mode === 'tts' ? text : '');

  const preview = useMutation({
    mutationFn: () => previewTts(text.trim(), chosenVoice, ws.scope.customerId),
    onSuccess: (blob) => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setPreviewUrl(url);
      setPreviewFor(`${chosenVoice}|${text.trim()}`);
    },
  });

  const save = useMutation({
    mutationFn: async (): Promise<Prompt> => {
      const finalName = effectiveName.trim() || 'Message';
      if (mode === 'tts') return createTtsPrompt({ name: finalName, text: text.trim(), voice: chosenVoice }, ws.scope.customerId);
      const ready = capture.ready;
      if (!ready) throw new Error('No audio yet');
      return uploadPrompt(finalName, ready.audio.wav, ws.scope.customerId, mode === 'record' ? 'recording' : 'upload');
    },
    onSuccess: (prompt) => {
      queryClient.setQueryData<Prompt[]>(ivrKeys.prompts(ws.scope), (old) => (old ? [...old, prompt] : [prompt]));
      void invalidateIvr(queryClient, ws.scope);
      toastOk(`Saved “${prompt.name}”.`);
      onCreated?.(prompt);
      onClose();
    },
  });

  // ── Derived (after all hooks) ──
  const busy = save.isPending;
  const trimmed = text.trim();
  const previewIsCurrent = previewUrl !== null && previewFor === `${chosenVoice}|${trimmed}`;
  const canSave =
    !busy &&
    effectiveName.trim().length > 0 &&
    (mode === 'tts' ? trimmed.length > 0 && trimmed.length <= TTS_MAX_CHARS && chosenVoice !== '' : capture.ready !== null);

  const switchMode = (next: Mode) => {
    if (busy || capture.recording || capture.processing) return;
    setMode(next);
    save.reset();
    if (next !== 'tts') capture.switchSource(next);
  };

  const modes: { id: Mode; label: string; icon: ReactNode }[] = [
    { id: 'tts', label: 'Type text', icon: <Type size={14} aria-hidden="true" /> },
    { id: 'record', label: 'Record', icon: <Mic size={14} aria-hidden="true" /> },
    { id: 'upload', label: 'Upload a file', icon: <Upload size={14} aria-hidden="true" /> },
  ];

  const nameField = (
    <div className="vm-field">
      <label className="ivr-label" htmlFor={ids.name}>
        Name
      </label>
      <input
        id={ids.name}
        className="dl-input vm-input-full"
        value={effectiveName}
        maxLength={100}
        onChange={(e) => {
          setNameTouched(true);
          setName(e.target.value);
        }}
      />
      <p className="dl-help">Only you see the name. Pick one you’ll recognise in the builder.</p>
    </div>
  );

  return (
    <VmDialog
      title="New message"
      sub={forWhat ? <>For the <strong>{forWhat}</strong> block. Up to 2 minutes.</> : 'Something callers hear. Up to 2 minutes.'}
      onClose={() => !busy && onClose()}
      busy={busy}
      width={580}
      footer={
        <>
          <button type="button" className="dl-btn dl-btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="dl-btn dl-btn-primary" disabled={!canSave} onClick={() => save.mutate()}>
            {busy && <span className="vm-spin vm-spin-light" aria-hidden="true" />}
            {busy ? 'Saving…' : 'Save message'}
          </button>
        </>
      }
    >
      <div className="vm-seg ivr-seg3" role="tablist" aria-label="How to make the message" id={ids.mode}>
        {modes.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={mode === m.id}
            className={`vm-seg-opt${mode === m.id ? ' vm-seg-on' : ''}`}
            onClick={() => switchMode(m.id)}
            disabled={busy || capture.recording || capture.processing || (m.id === 'tts' && ttsUnavailable)}
          >
            {m.icon} {m.label}
          </button>
        ))}
      </div>

      {mode === 'tts' && (
        <div className="ivr-tts">
          <div className="vm-field">
            <label className="ivr-label" htmlFor={ids.text}>
              What callers hear
            </label>
            <textarea
              id={ids.text}
              className="dl-input vm-input-full ivr-textarea"
              rows={4}
              maxLength={TTS_MAX_CHARS}
              value={text}
              placeholder="Thanks for calling Granite Telephony. For sales, press 1. For service, press 2."
              onChange={(e) => setText(e.target.value)}
              data-autofocus
            />
            <p className="dl-help ivr-counter">
              {trimmed.length.toLocaleString()} / {TTS_MAX_CHARS.toLocaleString()} characters. Read aloud when you save,
              so callers hear exactly what you preview.
            </p>
          </div>
          <div className="ivr-tts-row">
            <div className="vm-field ivr-grow">
              <label className="ivr-label" htmlFor={ids.voice}>
                Voice
              </label>
              {/* `nokey`: opened from the IVR builder, React Flow must not take Delete / Backspace from it. */}
              <Select
                id={ids.voice}
                className="dl-input vm-input-full nokey"
                value={chosenVoice}
                onChange={setVoice}
                options={voiceOptions}
                placeholder={voices.isLoading ? 'Loading voices…' : undefined}
                disabled={voiceList.length === 0}
                searchPlaceholder="Search voices…"
              />
            </div>
            <button
              type="button"
              className="dl-btn dl-btn-ghost ivr-tts-preview"
              disabled={trimmed.length === 0 || chosenVoice === '' || preview.isPending}
              onClick={() => preview.mutate()}
            >
              {preview.isPending ? <span className="vm-spin" aria-hidden="true" /> : <Volume2 size={15} aria-hidden="true" />}
              {preview.isPending ? 'Rendering…' : 'Preview'}
            </button>
          </div>
          {previewUrl && (
            <div className={`ivr-tts-player${previewIsCurrent ? '' : ' ivr-stale'}`}>
              <Player
                key={previewUrl}
                mint={() => Promise.resolve({ url: previewUrl, expires_in: 3600 })}
                durationMs={0}
                label="text-to-speech preview"
                compact
              />
              {!previewIsCurrent && <p className="dl-help">You changed the text or voice — preview again to hear it.</p>}
            </div>
          )}
          {preview.isError && (
            <div className="dl-banner dl-banner-err vm-gap-top" role="alert">
              {ivrErrorText(preview.error, 'The preview couldn’t be rendered. Try again.')}
            </div>
          )}
          {nameField}
        </div>
      )}

      {mode !== 'tts' && (
        <AudioCapturePanel capture={capture} busy={busy} showSourceSwitch={false} previewLabel="message preview">
          {nameField}
        </AudioCapturePanel>
      )}

      {ttsUnavailable && mode !== 'tts' && (
        <p className="dl-help vm-gap-top">Text to speech is unavailable right now; you can still record or upload.</p>
      )}
      {save.isError && (
        <div className="dl-banner dl-banner-err vm-gap-top" role="alert">
          {ivrErrorText(save.error, 'The message couldn’t be saved. Try again.')}
        </div>
      )}
    </VmDialog>
  );
}
