/**
 * TranscriptPanel — renders the message transcript inside a glass panel, with
 * graceful copy for the non-`done` states (pending / processing / failed /
 * skipped). The decrypted text never includes an audio URL.
 */

import type { ReactNode } from 'react';
import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import type { Transcript } from '../../../types/voicemail';
import { transcriptLabel, transcriptText, transcriptMuted } from '../styles';

export function TranscriptPanel({ transcript, loading }: { transcript: Transcript | undefined; loading: boolean }) {
  let body: ReactNode;
  if (loading) {
    body = <span style={transcriptMuted}>Loading…</span>;
  } else if (transcript?.status === 'done' && transcript.text) {
    body = <p style={transcriptText}>{transcript.text}</p>;
  } else {
    const msg =
      transcript?.status === 'processing' || transcript?.status === 'pending'
        ? 'Transcription is in progress — check back shortly.'
        : transcript?.status === 'failed'
          ? 'A transcript couldn’t be generated for this message.'
          : 'Transcription isn’t enabled for this message.';
    body = <span style={transcriptMuted}>{msg}</span>;
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={transcriptLabel}>Transcript</span>
        {transcript?.language && (
          <span style={{ fontSize: '0.64rem', color: GLASS.textFaint, textTransform: 'uppercase' }}>
            {transcript.language}
          </span>
        )}
      </div>
      <GlassPanel padding="14px 16px">{body}</GlassPanel>
    </div>
  );
}
