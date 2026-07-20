/**
 * NewFolderModal — create a folder (with an optional parent select).
 */

import { useEffect, useRef, useState } from 'react';
import { X, FolderPlus } from 'lucide-react';
import { GLASS } from '../../../components/glass/glass';
import { GlassSheen } from '../../../components/glass/GlassCard';
import type { DocumentFolder } from '../../../types/documents';
import { modalBackdrop, modalPanel, fieldLabel, fieldInput, primaryBtn, ghostBtn } from '../styles';

interface NewFolderModalProps {
  parentId: number | null;
  folders: DocumentFolder[];
  onSave: (name: string, parentId: number | null) => void;
  onClose: () => void;
}

export function NewFolderModal({ parentId, folders, onSave, onClose }: NewFolderModalProps) {
  const [name, setName] = useState('');
  const [chosenParent, setChosenParent] = useState<number | null>(parentId);
  const [nameFocus, setNameFocus] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleSave = () => { if (name.trim()) onSave(name.trim(), chosenParent); };

  return (
    <div className="animate-modal-backdrop" style={modalBackdrop} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="animate-modal-panel" style={modalPanel(400)}>
        <GlassSheen />
        <div style={{ position: 'relative', zIndex: 1, padding: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '1.125rem', fontWeight: 700, color: GLASS.text, letterSpacing: '-0.01em' }}>
              <FolderPlus size={18} color="#60a5fa" strokeWidth={1.8} />
              New Folder
            </div>
            <button
              type="button" onClick={onClose} aria-label="Close"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: GLASS.textMuted, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8 }}
            >
              <X size={18} strokeWidth={2} />
            </button>
          </div>

          <label style={{ display: 'block', marginBottom: 16 }}>
            <div style={fieldLabel}>Folder name</div>
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onFocus={() => setNameFocus(true)}
              onBlur={() => setNameFocus(false)}
              placeholder="e.g. Marketing Assets"
              onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onClose(); }}
              style={fieldInput(nameFocus)}
            />
          </label>

          {folders.length > 0 && (
            <label style={{ display: 'block', marginBottom: 24 }}>
              <div style={fieldLabel}>Parent folder (optional)</div>
              <select
                value={chosenParent ?? ''}
                onChange={(e) => setChosenParent(e.target.value === '' ? null : Number(e.target.value))}
                style={{ ...fieldInput(false), cursor: 'pointer', appearance: 'none' }}
              >
                <option value="">Root (no parent)</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </label>
          )}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose} style={ghostBtn}>Cancel</button>
            <button type="button" onClick={handleSave} disabled={!name.trim()} style={primaryBtn(!!name.trim())}>
              Create folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
