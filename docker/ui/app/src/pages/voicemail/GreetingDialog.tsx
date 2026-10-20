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
 * Nothing is uploaded until Save. The preview plays from an object URL that
 * is revoked when it is replaced or the dialog closes; recording is
 * cancelled (mic released) if the dialog closes mid-take.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileAudio, Mic, RotateCcw, Square, Upload } from 'lucide-react';
import type { Greeting, Mailbox } from '../../types/voicemail';
import { uploadGreeting } from '../../api/voicemail';
import { useToast } from '../../components/ui/ToastContext';
import { VmDialog } from './VmDialog';
import { Player } from './Player';
import { invalidateVoicemail, vmErrorText } from './voicemailData';
import { buildGreetingWav, decodeAudioFile, GreetingAudioError, type GreetingAudio } from './audio/transcode';
import { recordingUnsupportedReason, RecorderError, startRecording, type RecorderHandle } from './audio/recorder';
import { GREETING_MAX_SECONDS } from './audio/wav';
import { formatBytes, formatClock } from './format';

type Source = 'record' | 'upload';

type Stage =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'recording'; elapsed: number; level: number }
  | { kind: 'processing' }
  | { kind: 'ready'; audio: GreetingAudio; url: string; from: string }
  | { kind: 'error'; message: string };

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
  const [source, setSource] = useState<Source>(() => (recordingUnsupportedReason() ? 'upload' : 'record'));
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [label, setLabel] = useState(defaultLabel);
  const [activate, setActivate] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const recorderRef = useRef<RecorderHandle | null>(null);
  const urlRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const labelId = useId();
  const activateId = useId();
  const [unsupported] = useState(recordingUnsupportedReason);

  /** Swaps the preview object URL, revoking the old one. */
  const setPreviewUrl = useCallback((url: string | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = url;
  }, []);

  // Release the mic and the preview URL when the dialog goes away.
  useEffect(
    () => () => {
      recorderRef.current?.cancel();
      recorderRef.current = null;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    },
    [],
  );

  const finishClip = useCallback(
    async (make: () => Promise<GreetingAudio>, from: string) => {
      setStage({ kind: 'processing' });
      try {
        const audio = await make();
        const url = URL.createObjectURL(audio.wav);
        setPreviewUrl(url);
        setStage({ kind: 'ready', audio, url, from });
      } catch (err) {
        setPreviewUrl(null);
        setStage({
          kind: 'error',
          message: err instanceof GreetingAudioError ? err.message : 'That audio couldn’t be converted. Try another file or recording.',
        });
      }
    },
    [setPreviewUrl],
  );

  const stopRecording = useCallback(async () => {
    const handle = recorderRef.current;
    if (!handle) return;
    recorderRef.current = null;
    const clip = await handle.stop();
    await finishClip(() => buildGreetingWav(clip), 'Recording');
  }, [finishClip]);

  const startRecordingTake = useCallback(async () => {
    setPreviewUrl(null);
    setStage({ kind: 'starting' });
    try {
      recorderRef.current = await startRecording({
        maxSeconds: GREETING_MAX_SECONDS,
        onProgress: ({ elapsed, level }) => setStage({ kind: 'recording', elapsed, level }),
        onLimit: () => void stopRecording(),
      });
      setStage({ kind: 'recording', elapsed: 0, level: 0 });
    } catch (err) {
      recorderRef.current = null;
      setStage({ kind: 'error', message: err instanceof RecorderError ? err.message : 'Recording couldn’t start.' });
    }
  }, [setPreviewUrl, stopRecording]);

  const takeFile = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      void finishClip(async () => buildGreetingWav(await decodeAudioFile(file)), file.name);
    },
    [finishClip],
  );

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
  const recording = stage.kind === 'recording' || stage.kind === 'starting';
  const busy = save.isPending || stage.kind === 'processing';
  const ready = stage.kind === 'ready' ? stage : null;

  const switchSource = (next: Source) => {
    if (recording || busy) return;
    setSource(next);
    setPreviewUrl(null);
    setStage({ kind: 'idle' });
    save.reset();
  };

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
      <div className="vm-seg" role="tablist" aria-label="How to add the greeting">
        <button
          type="button"
          role="tab"
          aria-selected={source === 'record'}
          className={`vm-seg-opt${source === 'record' ? ' vm-seg-on' : ''}`}
          onClick={() => switchSource('record')}
          disabled={recording || busy}
        >
          <Mic size={14} aria-hidden="true" /> Record
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={source === 'upload'}
          className={`vm-seg-opt${source === 'upload' ? ' vm-seg-on' : ''}`}
          onClick={() => switchSource('upload')}
          disabled={recording || busy}
        >
          <Upload size={14} aria-hidden="true" /> Upload a file
        </button>
      </div>

      {source === 'record' && (
        <div className="vm-capture">
          {unsupported ? (
            <div className="dl-banner dl-banner-warn">{unsupported}</div>
          ) : stage.kind === 'recording' || stage.kind === 'starting' ? (
            <div className="vm-rec">
              <span className="vm-rec-dot" aria-hidden="true" />
              <div className="vm-rec-main">
                <div className="vm-rec-time" aria-live="off">
                  {formatClock(stage.kind === 'recording' ? stage.elapsed : 0)}
                  <span> / {formatClock(GREETING_MAX_SECONDS)}</span>
                </div>
                <div className="vm-level" aria-hidden="true">
                  <span style={{ width: `${Math.round(Math.min(1, (stage.kind === 'recording' ? stage.level : 0) * 1.6) * 100)}%` }} />
                </div>
                <p className="dl-help">{stage.kind === 'starting' ? 'Waiting for the microphone…' : 'Recording — speak normally.'}</p>
              </div>
              <button
                type="button"
                className="dl-btn vm-btn-danger-solid"
                onClick={() => void stopRecording()}
                disabled={stage.kind === 'starting'}
              >
                <Square size={13} fill="currentColor" aria-hidden="true" /> Stop
              </button>
            </div>
          ) : (
            !ready &&
            stage.kind !== 'processing' && (
              <div className="vm-capture-start">
                <button type="button" className="dl-btn dl-btn-primary" onClick={() => void startRecordingTake()}>
                  <Mic size={15} aria-hidden="true" /> Start recording
                </button>
                <p className="dl-help">
                  Your browser will ask to use the microphone. Recording stops by itself at 2:00.
                </p>
              </div>
            )
          )}
        </div>
      )}

      {source === 'upload' && !ready && stage.kind !== 'processing' && (
        <div
          className={`vm-drop${dragOver ? ' vm-drop-on' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            takeFile(e.dataTransfer.files[0]);
          }}
        >
          <FileAudio size={22} strokeWidth={1.7} aria-hidden="true" />
          <p>
            Drop an audio file here, or{' '}
            <button type="button" className="vm-linkbtn" onClick={() => fileInputRef.current?.click()}>
              choose one
            </button>
            .
          </p>
          <p className="dl-help">WAV, MP3, M4A and most other formats. It’s converted in your browser before upload.</p>
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.oga,.opus,.flac,.webm"
            className="vm-sr"
            tabIndex={-1}
            onChange={(e) => {
              takeFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
      )}

      {stage.kind === 'processing' && (
        <div className="vm-state-line" role="status">
          <span className="vm-spin" aria-hidden="true" /> Converting…
        </div>
      )}

      {stage.kind === 'error' && (
        <div className="dl-banner dl-banner-err vm-gap-top" role="alert">
          {stage.message}
        </div>
      )}

      {ready && (
        <div className="vm-preview">
          <div className="vm-preview-head">
            <span className="dl-section-title vm-section-tight">Preview</span>
            <span className="vm-preview-meta">
              {ready.from} · {formatClock(ready.audio.durationSec)} · {formatBytes(ready.audio.bytes)} · 16 kHz mono
            </span>
          </div>
          <Player
            key={ready.url}
            mint={() => Promise.resolve({ url: ready.url, expires_in: 3600 })}
            durationMs={ready.audio.durationSec * 1000}
            label="greeting preview"
          />
          <button
            type="button"
            className="vm-linkbtn vm-redo"
            onClick={() => (source === 'record' ? void startRecordingTake() : fileInputRef.current?.click())}
            disabled={save.isPending}
          >
            <RotateCcw size={13} aria-hidden="true" />
            {source === 'record' ? 'Record again' : 'Choose a different file'}
          </button>
          {source === 'upload' && (
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.oga,.opus,.flac,.webm"
              className="vm-sr"
              tabIndex={-1}
              onChange={(e) => {
                takeFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          )}

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
        </div>
      )}

      {save.isError && (
        <div className="dl-banner dl-banner-err vm-gap-top" role="alert">
          {vmErrorText(save.error, 'The greeting couldn’t be saved. Try again.')}
        </div>
      )}
    </VmDialog>
  );
}
