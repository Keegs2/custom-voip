/**
 * Loading / empty / error presentational states for the document list area.
 */

import { FolderOpen, Plus } from 'lucide-react';
import { GLASS, hexToRgba } from '../../../components/glass/glass';
import { spinner, primaryBtn } from '../styles';

export function LoadingState() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 60 }}>
      <div style={spinner()} />
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div style={{ padding: 40, textAlign: 'center' }}>
      <div style={{ color: GLASS.danger, fontSize: '0.9rem', marginBottom: 14 }}>{message}</div>
      <button
        type="button"
        onClick={onRetry}
        style={{
          padding: '8px 18px', borderRadius: 9,
          background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)',
          color: GLASS.textMuted, fontSize: '0.82rem', cursor: 'pointer', fontFamily: 'inherit',
        }}
      >
        Try again
      </button>
    </div>
  );
}

export function EmptyDocState({ onUpload }: { onUpload: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 16, padding: 48 }}>
      <div
        style={{
          width: 76, height: 76, borderRadius: 20,
          background: `linear-gradient(135deg, ${hexToRgba(GLASS.accent, 0.16)} 0%, ${hexToRgba(GLASS.accentSecondary, 0.1)} 100%)`,
          border: `1px solid ${hexToRgba(GLASS.accent, 0.24)}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: GLASS.accent,
          boxShadow: `0 0 44px ${hexToRgba(GLASS.accent, 0.14)}`,
        }}
      >
        <FolderOpen size={32} strokeWidth={1.4} />
      </div>
      <div style={{ textAlign: 'center', maxWidth: 320 }}>
        <div style={{ fontSize: '1.05rem', fontWeight: 700, color: GLASS.text, marginBottom: 8, letterSpacing: '-0.02em' }}>
          No documents yet
        </div>
        <div style={{ fontSize: '0.85rem', color: GLASS.textMuted, lineHeight: 1.65 }}>
          Upload files to share with your team. Drag and drop files anywhere on this page.
        </div>
      </div>
      <button type="button" onClick={onUpload} style={{ ...primaryBtn(), display: 'flex', alignItems: 'center', gap: 8 }}>
        <Plus size={15} strokeWidth={2.5} />
        Upload files
      </button>
    </div>
  );
}
