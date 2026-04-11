export interface DocumentFolder {
  id: number;
  name: string;
  parent_id: number | null;
  document_count: number;
  created_at: string;
}

export interface SharedDocument {
  id: number;
  filename: string;
  original_filename: string;
  mime_type: string;
  file_size: number;
  description: string | null;
  tags: string[] | null;
  folder_id: number | null;
  uploaded_by: number;
  uploader_name: string;
  created_at: string;
  updated_at: string;
}

export interface DocumentStats {
  total_documents: number;
  total_size: number;
  by_type: Record<string, number>;
}

export interface DocumentListResult {
  items: SharedDocument[];
  total: number;
}

export interface DocumentListParams {
  folder_id?: number | null;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface UploadProgress {
  file: File;
  /** 0–100 */
  progress: number;
  status: 'pending' | 'uploading' | 'done' | 'error';
  error?: string;
  result?: SharedDocument;
}
