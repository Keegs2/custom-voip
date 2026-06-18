-- Shared document library for customer organizations
-- Provides folder hierarchy and file storage metadata

-- Folder structure for organizing documents
CREATE TABLE IF NOT EXISTS document_folders (
    id SERIAL PRIMARY KEY,
    customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    parent_id INT REFERENCES document_folders(id) ON DELETE CASCADE,
    created_by INT REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(customer_id, parent_id, name)  -- no duplicate folder names in same parent
);

-- Shared documents
CREATE TABLE IF NOT EXISTS shared_documents (
    id SERIAL PRIMARY KEY,
    customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    folder_id INT REFERENCES document_folders(id) ON DELETE SET NULL,
    uploaded_by INT NOT NULL REFERENCES users(id),
    filename VARCHAR(255) NOT NULL,
    original_filename VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100),
    file_size BIGINT NOT NULL,
    storage_path VARCHAR(500) NOT NULL,
    description TEXT,
    tags TEXT[],  -- PostgreSQL array for tagging
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes: documents by customer + folder, customer + date, full-text search
CREATE INDEX IF NOT EXISTS idx_shared_documents_customer_folder
    ON shared_documents (customer_id, folder_id);

CREATE INDEX IF NOT EXISTS idx_shared_documents_customer_created
    ON shared_documents (customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shared_documents_fulltext
    ON shared_documents
    USING GIN (to_tsvector('english', COALESCE(original_filename, '') || ' ' || COALESCE(description, '')));

-- Index on folder tree for fast parent lookups
CREATE INDEX IF NOT EXISTS idx_document_folders_customer_parent
    ON document_folders (customer_id, parent_id);

-- Grants
GRANT ALL ON TABLE document_folders TO api;
GRANT ALL ON TABLE shared_documents TO api;
GRANT USAGE, SELECT ON SEQUENCE document_folders_id_seq TO api;
GRANT USAGE, SELECT ON SEQUENCE shared_documents_id_seq TO api;
