/**
 * DropZone — the always-visible drag-and-drop / click-to-browse upload target
 * pinned at the bottom of the document list.
 */

import { useRef, useState, type DragEvent, type ChangeEvent } from 'react';
import { Upload } from 'lucide-react';
import { GLASS } from '../../../components/glass/glass';
import { MAX_DOCUMENT_SIZE_BYTES } from '../../../lib/uploadValidation';
import { dropZone, dropIcon } from '../styles';

interface DropZoneProps {
  onFiles: (files: File[]) => void;
}

export function DropZone({ onFiles }: DropZoneProps) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) onFiles(files);
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) onFiles(files);
    e.target.value = '';
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      style={dropZone(dragOver)}
    >
      <div style={dropIcon(dragOver)}>
        <Upload size={22} strokeWidth={1.6} />
      </div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '0.875rem', fontWeight: 600, color: GLASS.text, marginBottom: 4 }}>
          Drop files here or <span style={{ color: GLASS.accent }}>browse</span>
        </div>
        <div style={{ fontSize: '0.78rem', color: GLASS.textFaint }}>
          Up to {Math.round(MAX_DOCUMENT_SIZE_BYTES / (1024 * 1024))} MB per file · Multiple files supported
        </div>
      </div>
      <input ref={inputRef} type="file" multiple style={{ display: 'none' }} onChange={handleChange} />
    </div>
  );
}
