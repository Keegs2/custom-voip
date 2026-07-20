/**
 * FileTypeIcon — renders the lucide glyph + colour for a document's MIME type.
 */

import {
  FileText,
  FileImage,
  FileSpreadsheet,
  FileVideo,
  FileAudio,
  File,
} from 'lucide-react';
import { getMimeCategory, mimeColor } from '../helpers';

interface FileTypeIconProps {
  mime: string;
  size?: number;
  color?: string;
}

export function FileTypeIcon({ mime, size = 20, color }: FileTypeIconProps) {
  const cat = getMimeCategory(mime);
  const props = { size, color: color ?? mimeColor(cat), strokeWidth: 1.6 };

  switch (cat) {
    case 'image':       return <FileImage {...props} />;
    case 'pdf':         return <FileText {...props} />;
    case 'spreadsheet': return <FileSpreadsheet {...props} />;
    case 'video':       return <FileVideo {...props} />;
    case 'audio':       return <FileAudio {...props} />;
    case 'doc':         return <FileText {...props} />;
    default:            return <File {...props} />;
  }
}
