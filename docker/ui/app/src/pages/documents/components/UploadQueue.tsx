/**
 * UploadQueue — the bottom-right stack of frosted upload progress cards
 * (pending / uploading / done / error), each dismissible once settled.
 */

import { X } from 'lucide-react';
import { GLASS } from '../../../components/glass/glass';
import type { UploadProgress } from '../../../types/documents';
import { FileTypeIcon } from './FileTypeIcon';
import { uploadCard } from '../styles';

interface UploadQueueProps {
  queue: UploadProgress[];
  onDismiss: (index: number) => void;
}

export function UploadQueue({ queue, onDismiss }: UploadQueueProps) {
  if (queue.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        zIndex: 400,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxWidth: 360,
      }}
    >
      {queue.map((u, i) => (
        <div key={i} style={uploadCard(u.status)}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: u.status === 'uploading' ? 8 : 0 }}>
            <FileTypeIcon mime={u.file.type || 'application/octet-stream'} size={16} />
            <span style={{ flex: 1, fontSize: '0.8rem', color: GLASS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {u.file.name}
            </span>
            <span style={{
              fontSize: '0.7rem', fontWeight: 700,
              color: u.status === 'error' ? GLASS.danger : u.status === 'done' ? GLASS.success : GLASS.textMuted,
            }}>
              {u.status === 'done' ? 'Done' : u.status === 'error' ? 'Failed' : `${u.progress}%`}
            </span>
            {(u.status === 'done' || u.status === 'error') && (
              <button type="button" onClick={() => onDismiss(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: GLASS.textMuted, display: 'flex', padding: 0 }}>
                <X size={13} strokeWidth={2} />
              </button>
            )}
          </div>
          {u.status === 'uploading' && (
            <div style={{ height: 4, background: 'rgba(255,255,255,0.08)', borderRadius: 99, overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${u.progress}%`,
                  background: `linear-gradient(90deg, ${GLASS.accent}, ${GLASS.accentSecondary})`,
                  borderRadius: 99,
                  transition: 'width 0.2s ease',
                  animation: u.progress < 100 ? 'progressPulse 1.5s ease-in-out infinite' : 'none',
                }}
              />
            </div>
          )}
          {u.status === 'error' && u.error && (
            <div style={{ fontSize: '0.72rem', color: GLASS.danger, marginTop: 4 }}>{u.error}</div>
          )}
        </div>
      ))}
    </div>
  );
}
