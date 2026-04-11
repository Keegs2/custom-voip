"""Shared document library endpoints for UCaaS.

Provides folder management, file upload/download, metadata editing,
search, and usage statistics. Files are stored on disk under
/data/shared-documents/{customer_id}/ with UUID-prefixed filenames
to prevent collisions.
"""
import logging
import os
import re
import uuid
from typing import Optional, List

from fastapi import APIRouter, HTTPException, Depends, Query, UploadFile, File, Form
from fastapi.responses import FileResponse
from pydantic import BaseModel, field_validator

from db import database as db
from auth.dependencies import get_current_user, get_customer_filter

logger = logging.getLogger(__name__)

router = APIRouter()

UPLOAD_ROOT = "/data/shared-documents"
MAX_FILE_SIZE = int(os.environ.get("DOCUMENTS_MAX_FILE_SIZE", 50 * 1024 * 1024))  # 50MB default


# ---------------------------------------------------------------------------
# Pydantic request models
# ---------------------------------------------------------------------------

class CreateFolder(BaseModel):
    name: str
    parent_id: Optional[int] = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        v = v.strip()
        if not v or len(v) > 100:
            raise ValueError("Folder name must be 1-100 characters")
        if re.search(r'[/\\<>:"|?*]', v):
            raise ValueError("Folder name contains invalid characters")
        return v


class RenameFolder(BaseModel):
    name: str

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        v = v.strip()
        if not v or len(v) > 100:
            raise ValueError("Folder name must be 1-100 characters")
        if re.search(r'[/\\<>:"|?*]', v):
            raise ValueError("Folder name contains invalid characters")
        return v


class UpdateDocument(BaseModel):
    description: Optional[str] = None
    tags: Optional[List[str]] = None
    folder_id: Optional[int] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _sanitize_filename(filename: str) -> str:
    """Remove path separators and null bytes from a filename."""
    name = os.path.basename(filename)
    name = name.replace("\x00", "")
    if not name:
        name = "upload"
    return name


async def _resolve_customer_id(user: dict, customer_filter: int | None) -> int:
    """Return the customer_id to scope queries to.

    Regular users use their own customer_id. Admins (customer_filter=None)
    must have a customer_id on their token or we raise 400.
    """
    customer_id = user.get("customer_id")
    if customer_id is not None:
        return customer_id
    raise HTTPException(
        status_code=400,
        detail="Admin users must specify a customer context for document operations",
    )


async def _verify_document_ownership(doc_id: int, customer_id: int) -> dict:
    """Fetch a document and verify it belongs to the given customer."""
    row = await db.fetch_one(
        """SELECT id, customer_id, folder_id, uploaded_by, filename,
                  original_filename, mime_type, file_size, storage_path,
                  description, tags, created_at, updated_at
           FROM shared_documents WHERE id = $1""",
        doc_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Document not found")
    if row["customer_id"] != customer_id:
        raise HTTPException(status_code=404, detail="Document not found")
    return dict(row)


async def _verify_folder_ownership(folder_id: int, customer_id: int) -> dict:
    """Fetch a folder and verify it belongs to the given customer."""
    row = await db.fetch_one(
        "SELECT id, customer_id, name, parent_id, created_by, created_at "
        "FROM document_folders WHERE id = $1",
        folder_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Folder not found")
    if row["customer_id"] != customer_id:
        raise HTTPException(status_code=404, detail="Folder not found")
    return dict(row)


# ---------------------------------------------------------------------------
# Folders
# ---------------------------------------------------------------------------

@router.get("/folders")
async def list_folders(
    user: dict = Depends(get_current_user),
    customer_filter: int | None = Depends(get_customer_filter),
):
    """List all folders for the customer as a flat list with document counts.

    Each folder includes a doc_count field. The client can reconstruct the
    tree using parent_id references.
    """
    customer_id = await _resolve_customer_id(user, customer_filter)

    rows = await db.fetch_all(
        """
        SELECT f.id, f.name, f.parent_id, f.created_by, f.created_at,
               u.name AS created_by_name,
               COALESCE(dc.cnt, 0)::int AS doc_count
        FROM document_folders f
        LEFT JOIN users u ON u.id = f.created_by
        LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS cnt
            FROM shared_documents d
            WHERE d.folder_id = f.id AND d.customer_id = $1
        ) dc ON true
        WHERE f.customer_id = $1
        ORDER BY f.name ASC
        """,
        customer_id,
    )
    return [dict(r) for r in rows]


@router.post("/folders", status_code=201)
async def create_folder(
    body: CreateFolder,
    user: dict = Depends(get_current_user),
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Create a new folder. Optionally nested under parent_id."""
    customer_id = await _resolve_customer_id(user, customer_filter)
    user_id = int(user["sub"])

    # If parent_id is provided, verify it belongs to the same customer
    if body.parent_id is not None:
        await _verify_folder_ownership(body.parent_id, customer_id)

    try:
        row = await db.fetch_one(
            """INSERT INTO document_folders (customer_id, name, parent_id, created_by)
               VALUES ($1, $2, $3, $4)
               RETURNING id, customer_id, name, parent_id, created_by, created_at""",
            customer_id, body.name, body.parent_id, user_id,
        )
    except Exception as e:
        if "unique" in str(e).lower() or "duplicate" in str(e).lower():
            raise HTTPException(
                status_code=409,
                detail="A folder with that name already exists in this location",
            )
        raise

    return dict(row)


@router.put("/folders/{folder_id}")
async def rename_folder(
    folder_id: int,
    body: RenameFolder,
    user: dict = Depends(get_current_user),
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Rename a folder."""
    customer_id = await _resolve_customer_id(user, customer_filter)
    folder = await _verify_folder_ownership(folder_id, customer_id)

    try:
        row = await db.fetch_one(
            """UPDATE document_folders SET name = $1
               WHERE id = $2
               RETURNING id, customer_id, name, parent_id, created_by, created_at""",
            body.name, folder_id,
        )
    except Exception as e:
        if "unique" in str(e).lower() or "duplicate" in str(e).lower():
            raise HTTPException(
                status_code=409,
                detail="A folder with that name already exists in this location",
            )
        raise

    return dict(row)


@router.delete("/folders/{folder_id}", status_code=204)
async def delete_folder(
    folder_id: int,
    user: dict = Depends(get_current_user),
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Delete a folder. Documents inside are moved to root (folder_id=NULL).

    Child folders are cascade-deleted by the database FK constraint.
    """
    customer_id = await _resolve_customer_id(user, customer_filter)
    await _verify_folder_ownership(folder_id, customer_id)

    # Move documents in this folder (and any child folders being cascade-deleted)
    # to root so they are not orphaned.
    # First, collect all descendant folder ids (recursive CTE)
    descendant_rows = await db.fetch_all(
        """
        WITH RECURSIVE tree AS (
            SELECT id FROM document_folders WHERE id = $1
            UNION ALL
            SELECT f.id FROM document_folders f JOIN tree t ON f.parent_id = t.id
        )
        SELECT id FROM tree
        """,
        folder_id,
    )
    descendant_ids = [r["id"] for r in descendant_rows]

    if descendant_ids:
        await db.execute(
            "UPDATE shared_documents SET folder_id = NULL WHERE folder_id = ANY($1)",
            descendant_ids,
        )

    await db.execute("DELETE FROM document_folders WHERE id = $1", folder_id)


# ---------------------------------------------------------------------------
# Documents
# ---------------------------------------------------------------------------

@router.get("")
async def list_documents(
    folder_id: Optional[int] = Query(None, description="Filter by folder (use 0 for root/unfiled)"),
    search: Optional[str] = Query(None, description="Full-text search on filename and description"),
    tags: Optional[str] = Query(None, description="Comma-separated tag filter"),
    mime_type: Optional[str] = Query(None, description="Filter by MIME type prefix (e.g. 'image/', 'application/pdf')"),
    sort: str = Query("created_at", description="Sort field: created_at, filename, file_size"),
    order: str = Query("desc", description="Sort order: asc or desc"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: dict = Depends(get_current_user),
    customer_filter: int | None = Depends(get_customer_filter),
):
    """List documents with filtering, search, and pagination."""
    customer_id = await _resolve_customer_id(user, customer_filter)

    # Validate sort/order
    allowed_sorts = {"created_at", "filename", "file_size"}
    if sort not in allowed_sorts:
        sort = "created_at"
    # Map filename sort to original_filename column
    sort_col = "d.original_filename" if sort == "filename" else f"d.{sort}"
    if order.lower() not in ("asc", "desc"):
        order = "desc"

    query = """
        SELECT d.id, d.folder_id, d.uploaded_by, d.filename,
               d.original_filename, d.mime_type, d.file_size,
               d.description, d.tags, d.created_at, d.updated_at,
               u.name AS uploaded_by_name
        FROM shared_documents d
        LEFT JOIN users u ON u.id = d.uploaded_by
        WHERE d.customer_id = $1
    """
    values: list = [customer_id]
    idx = 2

    # Folder filter: 0 means root (NULL folder_id)
    if folder_id is not None:
        if folder_id == 0:
            query += " AND d.folder_id IS NULL"
        else:
            query += f" AND d.folder_id = ${idx}"
            values.append(folder_id)
            idx += 1

    # Full-text search
    if search:
        query += f" AND to_tsvector('english', COALESCE(d.original_filename, '') || ' ' || COALESCE(d.description, '')) @@ plainto_tsquery('english', ${idx})"
        values.append(search)
        idx += 1

    # Tag filter
    if tags:
        tag_list = [t.strip() for t in tags.split(",") if t.strip()]
        if tag_list:
            query += f" AND d.tags && ${idx}::text[]"
            values.append(tag_list)
            idx += 1

    # MIME type filter (prefix match, e.g. "image/" matches image/png, image/jpeg)
    if mime_type:
        query += f" AND d.mime_type LIKE ${idx}"
        values.append(f"{mime_type}%")
        idx += 1

    query += f" ORDER BY {sort_col} {order.upper()}"
    query += f" LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([limit, offset])

    rows = await db.fetch_all(query, *values)

    # Also return total count for pagination
    count_query = "SELECT COUNT(*)::int AS total FROM shared_documents d WHERE d.customer_id = $1"
    count_values: list = [customer_id]
    cidx = 2

    if folder_id is not None:
        if folder_id == 0:
            count_query += " AND d.folder_id IS NULL"
        else:
            count_query += f" AND d.folder_id = ${cidx}"
            count_values.append(folder_id)
            cidx += 1

    if search:
        count_query += f" AND to_tsvector('english', COALESCE(d.original_filename, '') || ' ' || COALESCE(d.description, '')) @@ plainto_tsquery('english', ${cidx})"
        count_values.append(search)
        cidx += 1

    if tags:
        tag_list = [t.strip() for t in tags.split(",") if t.strip()]
        if tag_list:
            count_query += f" AND d.tags && ${cidx}::text[]"
            count_values.append(tag_list)
            cidx += 1

    if mime_type:
        count_query += f" AND d.mime_type LIKE ${cidx}"
        count_values.append(f"{mime_type}%")
        cidx += 1

    total_row = await db.fetch_one(count_query, *count_values)
    total = total_row["total"] if total_row else 0

    return {
        "items": [dict(r) for r in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.post("/upload", status_code=201)
async def upload_document(
    file: UploadFile = File(...),
    folder_id: Optional[int] = Form(None),
    description: Optional[str] = Form(None),
    tags: Optional[str] = Form(None, description="Comma-separated tags"),
    user: dict = Depends(get_current_user),
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Upload a file to the shared document library.

    Stores the file on disk under /data/shared-documents/{customer_id}/
    with a UUID prefix to prevent collisions.
    """
    customer_id = await _resolve_customer_id(user, customer_filter)
    user_id = int(user["sub"])

    # Validate folder belongs to customer if specified
    if folder_id is not None:
        await _verify_folder_ownership(folder_id, customer_id)

    # Read file contents and enforce size limit
    contents = await file.read()
    file_size = len(contents)
    if file_size > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Maximum size is {MAX_FILE_SIZE // (1024 * 1024)}MB",
        )
    if file_size == 0:
        raise HTTPException(status_code=400, detail="Empty file")

    # Build storage path
    safe_filename = _sanitize_filename(file.filename or "upload")
    file_uuid = uuid.uuid4().hex
    stored_name = f"{file_uuid}_{safe_filename}"
    storage_dir = os.path.join(UPLOAD_ROOT, str(customer_id))
    os.makedirs(storage_dir, exist_ok=True)
    storage_path = os.path.join(storage_dir, stored_name)

    # Write file to disk
    with open(storage_path, "wb") as f:
        f.write(contents)

    # Parse tags
    tag_list = None
    if tags:
        tag_list = [t.strip() for t in tags.split(",") if t.strip()]

    # Insert database record
    row = await db.fetch_one(
        """INSERT INTO shared_documents
               (customer_id, folder_id, uploaded_by, filename, original_filename,
                mime_type, file_size, storage_path, description, tags)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id, customer_id, folder_id, uploaded_by, filename,
                     original_filename, mime_type, file_size, description,
                     tags, created_at, updated_at""",
        customer_id, folder_id, user_id, stored_name, safe_filename,
        file.content_type, file_size, storage_path, description, tag_list,
    )

    result = dict(row)
    result["download_url"] = f"/documents/{row['id']}/download"
    return result


@router.get("/stats")
async def document_stats(
    user: dict = Depends(get_current_user),
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Dashboard statistics: total documents, total size, breakdown by type."""
    customer_id = await _resolve_customer_id(user, customer_filter)

    summary = await db.fetch_one(
        """SELECT COUNT(*)::int AS total_documents,
                  COALESCE(SUM(file_size), 0)::bigint AS total_size
           FROM shared_documents WHERE customer_id = $1""",
        customer_id,
    )

    by_type = await db.fetch_all(
        """SELECT
               CASE
                   WHEN mime_type LIKE 'image/%%' THEN 'image'
                   WHEN mime_type LIKE 'video/%%' THEN 'video'
                   WHEN mime_type LIKE 'audio/%%' THEN 'audio'
                   WHEN mime_type = 'application/pdf' THEN 'pdf'
                   WHEN mime_type LIKE 'text/%%' THEN 'text'
                   WHEN mime_type LIKE 'application/vnd.openxmlformats%%'
                        OR mime_type LIKE 'application/vnd.ms-%%'
                        OR mime_type LIKE 'application/msword%%' THEN 'office'
                   ELSE 'other'
               END AS type_group,
               COUNT(*)::int AS count,
               COALESCE(SUM(file_size), 0)::bigint AS size
           FROM shared_documents
           WHERE customer_id = $1
           GROUP BY type_group
           ORDER BY count DESC""",
        customer_id,
    )

    return {
        "total_documents": summary["total_documents"] if summary else 0,
        "total_size": summary["total_size"] if summary else 0,
        "by_type": [dict(r) for r in by_type],
    }


@router.get("/{doc_id}")
async def get_document(
    doc_id: int,
    user: dict = Depends(get_current_user),
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Get document metadata."""
    customer_id = await _resolve_customer_id(user, customer_filter)
    doc = await _verify_document_ownership(doc_id, customer_id)

    # Enrich with uploader name
    uploader = await db.fetch_one(
        "SELECT name, email FROM users WHERE id = $1", doc["uploaded_by"],
    )
    doc["uploaded_by_name"] = uploader["name"] if uploader else None
    doc["uploaded_by_email"] = uploader["email"] if uploader else None
    doc["download_url"] = f"/documents/{doc_id}/download"

    # Remove internal storage path from response
    doc.pop("storage_path", None)
    return doc


@router.get("/{doc_id}/download")
async def download_document(
    doc_id: int,
    user: dict = Depends(get_current_user),
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Serve the document file with correct Content-Type."""
    customer_id = await _resolve_customer_id(user, customer_filter)
    doc = await _verify_document_ownership(doc_id, customer_id)

    if not os.path.isfile(doc["storage_path"]):
        raise HTTPException(status_code=404, detail="File not found on disk")

    return FileResponse(
        path=doc["storage_path"],
        filename=doc["original_filename"],
        media_type=doc["mime_type"] or "application/octet-stream",
    )


@router.put("/{doc_id}")
async def update_document(
    doc_id: int,
    body: UpdateDocument,
    user: dict = Depends(get_current_user),
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Update document metadata (description, tags, folder)."""
    customer_id = await _resolve_customer_id(user, customer_filter)
    doc = await _verify_document_ownership(doc_id, customer_id)

    # If moving to a new folder, verify it belongs to the same customer
    if body.folder_id is not None and body.folder_id != 0:
        await _verify_folder_ownership(body.folder_id, customer_id)

    # Build dynamic SET clause
    updates = []
    values: list = []
    idx = 1

    if body.description is not None:
        updates.append(f"description = ${idx}")
        values.append(body.description)
        idx += 1

    if body.tags is not None:
        updates.append(f"tags = ${idx}::text[]")
        values.append(body.tags)
        idx += 1

    if body.folder_id is not None:
        # folder_id=0 means move to root (NULL)
        real_folder_id = None if body.folder_id == 0 else body.folder_id
        updates.append(f"folder_id = ${idx}")
        values.append(real_folder_id)
        idx += 1

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    updates.append(f"updated_at = NOW()")
    set_clause = ", ".join(updates)

    values.append(doc_id)
    row = await db.fetch_one(
        f"""UPDATE shared_documents SET {set_clause}
            WHERE id = ${idx}
            RETURNING id, customer_id, folder_id, uploaded_by, filename,
                      original_filename, mime_type, file_size, description,
                      tags, created_at, updated_at""",
        *values,
    )

    result = dict(row)
    result["download_url"] = f"/documents/{doc_id}/download"
    return result


@router.delete("/{doc_id}", status_code=204)
async def delete_document(
    doc_id: int,
    user: dict = Depends(get_current_user),
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Delete a document and remove the file from disk."""
    customer_id = await _resolve_customer_id(user, customer_filter)
    doc = await _verify_document_ownership(doc_id, customer_id)

    # Remove file from disk (best-effort)
    try:
        if os.path.isfile(doc["storage_path"]):
            os.remove(doc["storage_path"])
    except OSError:
        logger.warning("Failed to remove file from disk: %s", doc["storage_path"], exc_info=True)

    await db.execute("DELETE FROM shared_documents WHERE id = $1", doc_id)
