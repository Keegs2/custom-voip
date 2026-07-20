/**
 * TranscriptionNote — the frosted info banner explaining that each active media
 * tap is a pluggable hook point for a future speech-to-text consumer.
 */

import { Captions } from 'lucide-react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';

export function TranscriptionNote() {
  return (
    <GlassPanel padding="16px 18px" style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <Captions size={18} color={GLASS.blue} style={{ marginTop: 2, flexShrink: 0 }} />
        <div style={{ fontSize: '0.85rem', color: GLASS.textMuted, lineHeight: 1.6 }}>
          <span style={{ color: GLASS.text, fontWeight: 700 }}>Transcription-ready.</span>{' '}
          Each active stream is a pluggable hook point — a speech-to-text (STT) consumer can subscribe to the
          same media tap for live transcription. No STT engine is wired in yet; this monitor surfaces the raw
          stream stats the hook would consume.
        </div>
      </div>
    </GlassPanel>
  );
}
