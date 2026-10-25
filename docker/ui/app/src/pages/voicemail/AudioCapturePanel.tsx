/**
 * AudioCapturePanel — the shared UI for useAudioCapture: the Record / Upload
 * switch, the live recorder (timer + level), the drop zone, the converting
 * and error lines, and the preview (Player + redo) with the owner's own
 * fields underneath (`children`, e.g. a name). Used by the voicemail
 * GreetingDialog and the IVR PromptDialog; styled by dl-voicemail.css
 * (`vm-*`, so the owner must sit inside `.vm-scope` — VmDialog does).
 */
import { useRef, useState, type ReactNode } from 'react';
import { FileAudio, Mic, RotateCcw, Square, Upload } from 'lucide-react';
import { Player } from './Player';
import { formatBytes, formatClock } from './format';
import type { AudioCapture, CaptureSource } from './useAudioCapture';

const ACCEPT = 'audio/*,.wav,.mp3,.m4a,.aac,.ogg,.oga,.opus,.flac,.webm';

export interface AudioCapturePanelProps {
  capture: AudioCapture;
  /** A save is in flight (locks redo). */
  busy: boolean;
  /** Render the Record / Upload switch (an owner with its own switch hides it). */
  showSourceSwitch?: boolean;
  /** Called after the switch changed source (e.g. to clear a failed save). */
  onSourceSwitched?: (next: CaptureSource) => void;
  /** Accessible name of the preview player ("greeting preview"). */
  previewLabel: string;
  /** Fields shown under the preview once a clip is ready. */
  children?: ReactNode;
}

export function AudioCapturePanel({
  capture,
  busy,
  showSourceSwitch = true,
  onSourceSwitched,
  previewLabel,
  children,
}: AudioCapturePanelProps) {
  // Hooks first (React #310).
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const { source, stage, ready, recording, processing, unsupported, maxSeconds, noun, sampleRate } = capture;
  const locked = recording || processing || busy;

  const switchTo = (next: CaptureSource) => {
    if (locked) return;
    if (capture.switchSource(next)) onSourceSwitched?.(next);
  };

  const fileInput = (
    <input
      ref={fileInputRef}
      type="file"
      accept={ACCEPT}
      className="vm-sr"
      tabIndex={-1}
      aria-label="Audio file"
      onChange={(e) => {
        capture.takeFile(e.target.files?.[0]);
        e.target.value = '';
      }}
    />
  );

  return (
    <>
      {showSourceSwitch && (
        <div className="vm-seg" role="tablist" aria-label={`How to add the ${noun}`}>
          <button
            type="button"
            role="tab"
            aria-selected={source === 'record'}
            className={`vm-seg-opt${source === 'record' ? ' vm-seg-on' : ''}`}
            onClick={() => switchTo('record')}
            disabled={recording || busy || processing}
          >
            <Mic size={14} aria-hidden="true" /> Record
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={source === 'upload'}
            className={`vm-seg-opt${source === 'upload' ? ' vm-seg-on' : ''}`}
            onClick={() => switchTo('upload')}
            disabled={recording || busy || processing}
          >
            <Upload size={14} aria-hidden="true" /> Upload a file
          </button>
        </div>
      )}

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
                  <span> / {formatClock(maxSeconds)}</span>
                </div>
                <div className="vm-level" aria-hidden="true">
                  <span style={{ width: `${Math.round(Math.min(1, (stage.kind === 'recording' ? stage.level : 0) * 1.6) * 100)}%` }} />
                </div>
                <p className="dl-help">{stage.kind === 'starting' ? 'Waiting for the microphone…' : 'Recording — speak normally.'}</p>
              </div>
              <button
                type="button"
                className="dl-btn vm-btn-danger-solid"
                onClick={() => void capture.stopRecording()}
                disabled={stage.kind === 'starting'}
              >
                <Square size={13} fill="currentColor" aria-hidden="true" /> Stop
              </button>
            </div>
          ) : (
            !ready &&
            stage.kind !== 'processing' && (
              <div className="vm-capture-start">
                <button type="button" className="dl-btn dl-btn-primary" onClick={() => void capture.startRecordingTake()}>
                  <Mic size={15} aria-hidden="true" /> Start recording
                </button>
                <p className="dl-help">
                  Your browser will ask to use the microphone. Recording stops by itself at {formatClock(maxSeconds)}.
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
            capture.takeFile(e.dataTransfer.files[0]);
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
          {fileInput}
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
              {ready.from} · {formatClock(ready.audio.durationSec)} · {formatBytes(ready.audio.bytes)} ·{' '}
              {sampleRate / 1000} kHz mono
            </span>
          </div>
          <Player
            key={ready.url}
            mint={() => Promise.resolve({ url: ready.url, expires_in: 3600 })}
            durationMs={ready.audio.durationSec * 1000}
            label={previewLabel}
          />
          <button
            type="button"
            className="vm-linkbtn vm-redo"
            onClick={() => (source === 'record' ? void capture.startRecordingTake() : fileInputRef.current?.click())}
            disabled={busy}
          >
            <RotateCcw size={13} aria-hidden="true" />
            {source === 'record' ? 'Record again' : 'Choose a different file'}
          </button>
          {source === 'upload' && fileInput}
          {children}
        </div>
      )}
    </>
  );
}
