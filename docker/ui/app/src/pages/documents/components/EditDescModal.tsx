/**
 * EditDescModal — edit a document's description + comma-separated tags.
 */

import { useState } from 'react';
import { X } from 'lucide-react';
import { GLASS } from '../../../components/glass/glass';
import { GlassSheen } from '../../../components/glass/GlassCard';
import type { SharedDocument } from '../../../types/documents';
import { modalBackdrop, modalPanel, fieldLabel, fieldInput, primaryBtn, ghostBtn } from '../styles';

interface EditDescModalProps {
  doc: SharedDocument;
  onSave: (description: string, tags: string[]) => void;
  onClose: () => void;
}

export function EditDescModal({ doc, onSave, onClose }: EditDescModalProps) {
  const [desc, setDesc] = useState(doc.description ?? '');
  const [tagsInput, setTagsInput] = useState((doc.tags ?? []).join(', '));
  const [descFocus, setDescFocus] = useState(false);
  const [tagsFocus, setTagsFocus] = useState(false);

  const handleSave = () => {
    const tags = tagsInput.split(',').map((t) => t.trim()).filter(Boolean);
    onSave(desc, tags);
  };

  return (
    <div className="animate-modal-backdrop" style={modalBackdrop} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="animate-modal-panel" style={modalPanel(460)}>
        <GlassSheen />
        <div style={{ position: 'relative', zIndex: 1, padding: 28 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22 }}>
            <div style={{ fontSize: '1.125rem', fontWeight: 700, color: GLASS.text, letterSpacing: '-0.01em' }}>
              Edit document
            </div>
            <button
              type="button" onClick={onClose} aria-label="Close"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: GLASS.textMuted, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8 }}
            >
              <X size={18} strokeWidth={2} />
            </button>
          </div>

          <div style={fieldLabel}>Filename</div>
          <div style={{ fontSize: '0.875rem', color: GLASS.textMuted, marginBottom: 18, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
            {doc.original_filename}
          </div>

          <label style={{ display: 'block', marginBottom: 16 }}>
            <div style={fieldLabel}>Description</div>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              onFocus={() => setDescFocus(true)}
              onBlur={() => setDescFocus(false)}
              placeholder="Add a description…"
              rows={3}
              style={{ ...fieldInput(descFocus), resize: 'vertical' }}
            />
          </label>

          <label style={{ display: 'block', marginBottom: 24 }}>
            <div style={fieldLabel}>Tags (comma-separated)</div>
            <input
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              onFocus={() => setTagsFocus(true)}
              onBlur={() => setTagsFocus(false)}
              placeholder="report, q4, finance"
              style={fieldInput(tagsFocus)}
            />
          </label>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose} style={ghostBtn}>Cancel</button>
            <button type="button" onClick={handleSave} style={primaryBtn()}>Save changes</button>
          </div>
        </div>
      </div>
    </div>
  );
}
