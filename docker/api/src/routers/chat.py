"""Chat / messaging endpoints for UCaaS.

Provides conversation management, message CRUD, read receipts, typing
indicators, unread counts, and file upload/download. Real-time delivery
happens via Redis pub/sub -> WebSocket fanout (see main.py).
"""
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Optional, List

import orjson
from fastapi import APIRouter, HTTPException, Depends, Query, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel, field_validator

from db import database as db
from db.redis_client import get_client
from auth.dependencies import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter()

CHAT_EVENTS_CHANNEL = "chat:events"
CHAT_TYPING_CHANNEL = "chat:typing"
UPLOAD_ROOT = "/data/chat-uploads"


# ---------------------------------------------------------------------------
# Pydantic request models
# ---------------------------------------------------------------------------

class CreateConversation(BaseModel):
    type: str
    name: Optional[str] = None
    participant_user_ids: List[int]

    @field_validator("type")
    @classmethod
    def validate_type(cls, v: str) -> str:
        if v not in ("direct", "group"):
            raise ValueError("type must be 'direct' or 'group'")
        return v

    @field_validator("participant_user_ids")
    @classmethod
    def validate_participants(cls, v: List[int]) -> List[int]:
        if not v:
            raise ValueError("participant_user_ids must not be empty")
        return v


class SendMessage(BaseModel):
    content: str
    message_type: Optional[str] = "text"
    reply_to_id: Optional[int] = None

    @field_validator("message_type")
    @classmethod
    def validate_message_type(cls, v: Optional[str]) -> str:
        allowed = {"text", "file", "image", "system"}
        if v and v not in allowed:
            raise ValueError(f"message_type must be one of: {', '.join(sorted(allowed))}")
        return v or "text"


class EditMessage(BaseModel):
    content: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _verify_participant(conversation_id: int, user_id: int) -> dict:
    """Verify the user is a participant in the conversation. Returns the
    participant row or raises 403."""
    row = await db.fetch_one(
        "SELECT id, role FROM chat_participants WHERE conversation_id = $1 AND user_id = $2",
        conversation_id, user_id,
    )
    if not row:
        raise HTTPException(status_code=403, detail="Not a participant in this conversation")
    return dict(row)


async def _verify_conversation_customer(conversation_id: int, customer_id: int, user_id: int) -> dict:
    """Verify the conversation belongs to the user's customer. Returns row.

    For admin users (customer_id is None), customer_id check is skipped and
    access is granted based on participant membership instead.
    """
    row = await db.fetch_one(
        "SELECT id, customer_id, type, name, created_by, created_at, updated_at "
        "FROM chat_conversations WHERE id = $1",
        conversation_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Conversation not found")
    if customer_id is None:
        # Admin: verify via participant membership instead of customer_id
        await _verify_participant(conversation_id, user_id)
    elif row["customer_id"] != customer_id:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return dict(row)


async def _publish_event(event_type: str, data: dict):
    """Best-effort publish to Redis chat events channel."""
    try:
        rc = await get_client()
        payload = orjson.dumps({"type": event_type, **data}).decode()
        await rc.publish(CHAT_EVENTS_CHANNEL, payload)
    except Exception:
        logger.warning("Failed to publish chat event to Redis", exc_info=True)


# ---------------------------------------------------------------------------
# Conversations
# ---------------------------------------------------------------------------

@router.get("/conversations")
async def list_conversations(user: dict = Depends(get_current_user)):
    """List conversations the caller participates in, with last message
    preview and unread count, sorted by most recent activity."""
    user_id = int(user["sub"])
    customer_id = user.get("customer_id")

    # Build query: admins see all conversations they participate in (no
    # customer_id filter); regular users are additionally scoped to their tenant.
    customer_filter = "AND c.customer_id = $2" if customer_id is not None else ""
    query_params = [user_id, customer_id] if customer_id is not None else [user_id]

    rows = await db.fetch_all(
        f"""
        SELECT
            c.id,
            c.type,
            c.name,
            c.created_by,
            c.created_at,
            c.updated_at,
            -- last message preview
            lm.id          AS last_message_id,
            lm.content     AS last_message_content,
            lm.sender_id   AS last_message_sender_id,
            lm.created_at  AS last_message_at,
            lm_u.name      AS last_message_sender_name,
            -- unread count
            COALESCE(unread.cnt, 0)::int AS unread_count,
            -- participant names (aggregated)
            (
                SELECT json_agg(json_build_object(
                    'user_id', pu.id,
                    'name', pu.name,
                    'email', pu.email
                ))
                FROM chat_participants pp
                JOIN users pu ON pu.id = pp.user_id
                WHERE pp.conversation_id = c.id
            ) AS participants
        FROM chat_participants cp
        JOIN chat_conversations c ON c.id = cp.conversation_id
        -- latest message via lateral join
        LEFT JOIN LATERAL (
            SELECT m.id, m.content, m.sender_id, m.created_at
            FROM chat_messages m
            WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
            ORDER BY m.id DESC
            LIMIT 1
        ) lm ON true
        LEFT JOIN users lm_u ON lm_u.id = lm.sender_id
        -- unread count subquery
        LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS cnt
            FROM chat_messages m
            WHERE m.conversation_id = c.id
              AND m.deleted_at IS NULL
              AND m.sender_id != $1
              AND m.id > COALESCE(cp.last_read_message_id, 0)
        ) unread ON true
        WHERE cp.user_id = $1
          {customer_filter}
        ORDER BY c.updated_at DESC
        """,
        *query_params,
    )
    results = []
    for r in rows:
        d = dict(r)
        # Parse participants JSON from postgres json_agg
        if d.get("participants") and isinstance(d["participants"], str):
            d["participants"] = orjson.loads(d["participants"])
        results.append(d)
    return results


@router.post("/conversations", status_code=201)
async def create_conversation(body: CreateConversation, user: dict = Depends(get_current_user)):
    """Create a new conversation.

    For direct type: if a 1:1 conversation already exists between the
    two users within the same customer, return the existing one instead.
    """
    user_id = int(user["sub"])
    customer_id = user.get("customer_id")

    participant_ids = list(set(body.participant_user_ids))

    # Validate all participants exist and belong to the same customer.
    # This prevents cross-tenant conversation creation.
    participant_rows = await db.fetch_all(
        "SELECT id, customer_id FROM users WHERE id = ANY($1)",
        participant_ids,
    )
    participant_customers = {r["id"]: r["customer_id"] for r in participant_rows}

    for pid in participant_ids:
        if pid not in participant_customers:
            raise HTTPException(status_code=400, detail=f"User {pid} not found")

    if customer_id is not None:
        # Non-admin: all participants must belong to the caller's customer
        for pid in participant_ids:
            if participant_customers[pid] != customer_id:
                raise HTTPException(
                    status_code=403,
                    detail="Cannot create conversation with users from other organizations",
                )
    else:
        # Admin: derive customer_id from first participant, verify all share it
        first_cust = participant_customers.get(participant_ids[0])
        if not first_cust:
            raise HTTPException(
                status_code=400,
                detail="Cannot derive customer_id: first participant has no customer",
            )
        for pid in participant_ids:
            if participant_customers[pid] != first_cust:
                raise HTTPException(
                    status_code=400,
                    detail="All participants must belong to the same organization",
                )
        customer_id = first_cust

    # For direct conversations, enforce exactly one other participant
    if body.type == "direct":
        # Remove self if accidentally included
        other_ids = [pid for pid in participant_ids if pid != user_id]
        if len(other_ids) != 1:
            raise HTTPException(
                status_code=400,
                detail="Direct conversations require exactly one other participant",
            )
        other_id = other_ids[0]

        # Check if a direct conversation already exists between the two users
        existing = await db.fetch_one(
            """
            SELECT c.id
            FROM chat_conversations c
            WHERE c.customer_id = $1
              AND c.type = 'direct'
              AND EXISTS (
                  SELECT 1 FROM chat_participants p1
                  WHERE p1.conversation_id = c.id AND p1.user_id = $2
              )
              AND EXISTS (
                  SELECT 1 FROM chat_participants p2
                  WHERE p2.conversation_id = c.id AND p2.user_id = $3
              )
            LIMIT 1
            """,
            customer_id, user_id, other_id,
        )
        if existing:
            # Return the existing conversation
            conv = await db.fetch_one(
                "SELECT id, customer_id, type, name, created_by, created_at, updated_at "
                "FROM chat_conversations WHERE id = $1",
                existing["id"],
            )
            return dict(conv)

        participant_ids = [user_id, other_id]
    else:
        # Group: ensure creator is in participant list
        if user_id not in participant_ids:
            participant_ids.insert(0, user_id)

    now = datetime.now(timezone.utc)

    # Create conversation
    conv = await db.fetch_one(
        """INSERT INTO chat_conversations (customer_id, type, name, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $5)
           RETURNING id, customer_id, type, name, created_by, created_at, updated_at""",
        customer_id, body.type, body.name, user_id, now,
    )

    # Add participants
    for pid in participant_ids:
        role = "owner" if pid == user_id else "member"
        await db.execute(
            """INSERT INTO chat_participants (conversation_id, user_id, role, joined_at)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (conversation_id, user_id) DO NOTHING""",
            conv["id"], pid, role, now,
        )

    result = dict(conv)
    result["participant_user_ids"] = participant_ids

    await _publish_event("conversation_created", {
        "conversation_id": conv["id"],
        "customer_id": customer_id,
        "participant_user_ids": participant_ids,
    })

    return result


@router.get("/conversations/{conversation_id}")
async def get_conversation(conversation_id: int, user: dict = Depends(get_current_user)):
    """Get conversation details including participant list."""
    user_id = int(user["sub"])
    customer_id = user.get("customer_id")

    conv = await _verify_conversation_customer(conversation_id, customer_id, user_id)
    # For non-admin users, still verify participant membership explicitly
    if customer_id is not None:
        await _verify_participant(conversation_id, user_id)

    # Fetch participants with user info
    participants = await db.fetch_all(
        """
        SELECT cp.user_id, cp.role, cp.joined_at,
               cp.last_read_message_id, cp.last_read_at,
               u.name, u.email
        FROM chat_participants cp
        JOIN users u ON u.id = cp.user_id
        WHERE cp.conversation_id = $1
        ORDER BY cp.joined_at ASC
        """,
        conversation_id,
    )
    conv["participants"] = [dict(p) for p in participants]
    return conv


@router.delete("/conversations/{conversation_id}", status_code=204)
async def delete_conversation(conversation_id: int, user: dict = Depends(get_current_user)):
    """Delete a conversation. Owner only."""
    user_id = int(user["sub"])
    customer_id = user.get("customer_id")

    await _verify_conversation_customer(conversation_id, customer_id, user_id)
    part = await _verify_participant(conversation_id, user_id)

    if part["role"] != "owner":
        raise HTTPException(status_code=403, detail="Only the conversation owner can delete it")

    await db.execute("DELETE FROM chat_conversations WHERE id = $1", conversation_id)

    await _publish_event("conversation_deleted", {
        "conversation_id": conversation_id,
        "customer_id": customer_id,
    })


# ---------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------

@router.get("/conversations/{conversation_id}/messages")
async def list_messages(
    conversation_id: int,
    before_id: Optional[int] = Query(None, description="Cursor: return messages with id < this value"),
    limit: int = Query(50, ge=1, le=100),
    user: dict = Depends(get_current_user),
):
    """Paginated message listing, newest first. Uses cursor-based pagination."""
    user_id = int(user["sub"])
    customer_id = user.get("customer_id")

    await _verify_conversation_customer(conversation_id, customer_id, user_id)
    if customer_id is not None:
        await _verify_participant(conversation_id, user_id)

    query = """
        SELECT m.id, m.conversation_id, m.sender_id, m.content,
               m.message_type, m.reply_to_id, m.edited_at, m.deleted_at,
               m.created_at,
               u.name AS sender_name, u.email AS sender_email
        FROM chat_messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = $1
    """
    values: list = [conversation_id]
    idx = 2

    if before_id is not None:
        query += f" AND m.id < ${idx}"
        values.append(before_id)
        idx += 1

    query += f" ORDER BY m.id DESC LIMIT ${idx}"
    values.append(limit)

    rows = await db.fetch_all(query, *values)

    results = []
    for r in rows:
        d = dict(r)
        # Redact content of soft-deleted messages
        if d.get("deleted_at"):
            d["content"] = None
        results.append(d)
    return results


@router.post("/conversations/{conversation_id}/messages", status_code=201)
async def send_message(
    conversation_id: int,
    body: SendMessage,
    user: dict = Depends(get_current_user),
):
    """Send a message to a conversation."""
    user_id = int(user["sub"])
    customer_id = user.get("customer_id")

    await _verify_conversation_customer(conversation_id, customer_id, user_id)
    if customer_id is not None:
        await _verify_participant(conversation_id, user_id)

    now = datetime.now(timezone.utc)

    # Insert message
    msg = await db.fetch_one(
        """INSERT INTO chat_messages
               (conversation_id, sender_id, content, message_type, reply_to_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, conversation_id, sender_id, content, message_type,
                     reply_to_id, edited_at, deleted_at, created_at""",
        conversation_id, user_id, body.content, body.message_type,
        body.reply_to_id, now,
    )

    # Bump conversation updated_at
    await db.execute(
        "UPDATE chat_conversations SET updated_at = $1 WHERE id = $2",
        now, conversation_id,
    )

    # Fetch sender info for the event payload
    sender = await db.fetch_one(
        "SELECT name, email FROM users WHERE id = $1", user_id,
    )

    result = dict(msg)
    result["sender_name"] = sender["name"] if sender else None
    result["sender_email"] = sender["email"] if sender else None

    # Fetch participant user_ids for WebSocket targeting
    parts = await db.fetch_all(
        "SELECT user_id FROM chat_participants WHERE conversation_id = $1",
        conversation_id,
    )
    participant_ids = [p["user_id"] for p in parts]

    await _publish_event("new_message", {
        "conversation_id": conversation_id,
        "customer_id": customer_id,
        "participant_user_ids": participant_ids,
        "message": result,
    })

    return result


@router.put("/conversations/{conversation_id}/messages/{message_id}")
async def edit_message(
    conversation_id: int,
    message_id: int,
    body: EditMessage,
    user: dict = Depends(get_current_user),
):
    """Edit a message. Only the original sender can edit."""
    user_id = int(user["sub"])
    customer_id = user.get("customer_id")

    await _verify_conversation_customer(conversation_id, customer_id, user_id)
    if customer_id is not None:
        await _verify_participant(conversation_id, user_id)

    msg = await db.fetch_one(
        "SELECT id, sender_id, deleted_at FROM chat_messages WHERE id = $1 AND conversation_id = $2",
        message_id, conversation_id,
    )
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    if msg["deleted_at"]:
        raise HTTPException(status_code=400, detail="Cannot edit a deleted message")
    if msg["sender_id"] != user_id:
        raise HTTPException(status_code=403, detail="Only the sender can edit this message")

    now = datetime.now(timezone.utc)
    updated = await db.fetch_one(
        """UPDATE chat_messages SET content = $1, edited_at = $2
           WHERE id = $3
           RETURNING id, conversation_id, sender_id, content, message_type,
                     reply_to_id, edited_at, deleted_at, created_at""",
        body.content, now, message_id,
    )

    result = dict(updated)

    parts = await db.fetch_all(
        "SELECT user_id FROM chat_participants WHERE conversation_id = $1",
        conversation_id,
    )
    participant_ids = [p["user_id"] for p in parts]

    await _publish_event("message_edited", {
        "conversation_id": conversation_id,
        "customer_id": customer_id,
        "participant_user_ids": participant_ids,
        "message": result,
    })

    return result


@router.delete("/conversations/{conversation_id}/messages/{message_id}", status_code=204)
async def delete_message(
    conversation_id: int,
    message_id: int,
    user: dict = Depends(get_current_user),
):
    """Soft-delete a message. Sender, conversation owner, or admin can delete."""
    user_id = int(user["sub"])
    customer_id = user.get("customer_id")

    await _verify_conversation_customer(conversation_id, customer_id, user_id)
    part = await _verify_participant(conversation_id, user_id)

    msg = await db.fetch_one(
        "SELECT id, sender_id, deleted_at FROM chat_messages WHERE id = $1 AND conversation_id = $2",
        message_id, conversation_id,
    )
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    if msg["deleted_at"]:
        return  # Already deleted, idempotent

    # Authorization: sender, owner, or admin of conversation
    if msg["sender_id"] != user_id and part["role"] not in ("owner", "admin"):
        raise HTTPException(status_code=403, detail="Not authorized to delete this message")

    now = datetime.now(timezone.utc)
    await db.execute(
        "UPDATE chat_messages SET deleted_at = $1 WHERE id = $2",
        now, message_id,
    )

    parts = await db.fetch_all(
        "SELECT user_id FROM chat_participants WHERE conversation_id = $1",
        conversation_id,
    )
    participant_ids = [p["user_id"] for p in parts]

    await _publish_event("message_deleted", {
        "conversation_id": conversation_id,
        "customer_id": customer_id,
        "participant_user_ids": participant_ids,
        "message_id": message_id,
    })


# ---------------------------------------------------------------------------
# Read receipts
# ---------------------------------------------------------------------------

@router.put("/conversations/{conversation_id}/read")
async def mark_read(conversation_id: int, user: dict = Depends(get_current_user)):
    """Mark conversation as read up to the latest message."""
    user_id = int(user["sub"])
    customer_id = user.get("customer_id")

    await _verify_conversation_customer(conversation_id, customer_id, user_id)
    if customer_id is not None:
        await _verify_participant(conversation_id, user_id)

    now = datetime.now(timezone.utc)

    # Find the latest message id in the conversation
    latest = await db.fetch_one(
        "SELECT id FROM chat_messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1",
        conversation_id,
    )
    if not latest:
        return {"last_read_message_id": None}

    await db.execute(
        """UPDATE chat_participants
           SET last_read_message_id = $1, last_read_at = $2
           WHERE conversation_id = $3 AND user_id = $4""",
        latest["id"], now, conversation_id, user_id,
    )

    # Publish read receipt for WebSocket fanout
    parts = await db.fetch_all(
        "SELECT user_id FROM chat_participants WHERE conversation_id = $1",
        conversation_id,
    )
    participant_ids = [p["user_id"] for p in parts]

    await _publish_event("read_receipt", {
        "conversation_id": conversation_id,
        "customer_id": customer_id,
        "participant_user_ids": participant_ids,
        "user_id": user_id,
        "last_read_message_id": latest["id"],
    })

    return {"last_read_message_id": latest["id"]}


# ---------------------------------------------------------------------------
# Typing indicators
# ---------------------------------------------------------------------------

@router.post("/conversations/{conversation_id}/typing", status_code=204)
async def typing_indicator(conversation_id: int, user: dict = Depends(get_current_user)):
    """Signal that the caller is typing in a conversation.

    Sets a Redis key with 5-second TTL and publishes a typing event.
    """
    user_id = int(user["sub"])
    customer_id = user.get("customer_id")

    await _verify_conversation_customer(conversation_id, customer_id, user_id)
    if customer_id is not None:
        await _verify_participant(conversation_id, user_id)

    try:
        rc = await get_client()
        # Set ephemeral typing key
        typing_key = f"chat:typing:{conversation_id}:{user_id}"
        await rc.set(typing_key, "1", ex=5)

        # Fetch participant list for targeted delivery
        parts = await db.fetch_all(
            "SELECT user_id FROM chat_participants WHERE conversation_id = $1",
            conversation_id,
        )
        participant_ids = [p["user_id"] for p in parts]

        # Fetch sender name for display
        sender = await db.fetch_one("SELECT name FROM users WHERE id = $1", user_id)

        payload = orjson.dumps({
            "type": "typing",
            "conversation_id": conversation_id,
            "customer_id": customer_id,
            "participant_user_ids": participant_ids,
            "user_id": user_id,
            "user_name": sender["name"] if sender else None,
        }).decode()
        await rc.publish(CHAT_TYPING_CHANNEL, payload)
    except Exception:
        logger.warning("Failed to publish typing indicator", exc_info=True)


# ---------------------------------------------------------------------------
# Unread count
# ---------------------------------------------------------------------------

@router.get("/unread")
async def total_unread(user: dict = Depends(get_current_user)):
    """Total unread message count across all of the caller's conversations."""
    user_id = int(user["sub"])

    row = await db.fetch_one(
        """
        SELECT COALESCE(SUM(cnt), 0)::int AS total_unread
        FROM (
            SELECT COUNT(*) AS cnt
            FROM chat_participants cp
            JOIN chat_messages m
              ON m.conversation_id = cp.conversation_id
             AND m.id > COALESCE(cp.last_read_message_id, 0)
             AND m.deleted_at IS NULL
             AND m.sender_id != cp.user_id
            WHERE cp.user_id = $1
            GROUP BY cp.conversation_id
        ) sub
        """,
        user_id,
    )
    return {"total_unread": row["total_unread"] if row else 0}


# ---------------------------------------------------------------------------
# File upload / download
# ---------------------------------------------------------------------------

@router.post("/upload", status_code=201)
async def upload_file(
    file: UploadFile = File(...),
    conversation_id: int = Query(..., description="Conversation to attach the file to"),
    message_id: Optional[int] = Query(None, description="Message to attach the file to"),
    user: dict = Depends(get_current_user),
):
    """Upload a file for a chat conversation.

    Stores the file on disk and creates a chat_attachments record.
    If message_id is provided, links the attachment to that message.
    """
    user_id = int(user["sub"])
    customer_id = user.get("customer_id")

    conv = await _verify_conversation_customer(conversation_id, customer_id, user_id)
    if customer_id is not None:
        await _verify_participant(conversation_id, user_id)

    # For storage path, use the conversation's customer_id (always non-null)
    storage_customer_id = conv["customer_id"]

    # Build storage path
    file_uuid = uuid.uuid4().hex
    safe_filename = file.filename or "upload"
    storage_dir = os.path.join(UPLOAD_ROOT, str(storage_customer_id))
    os.makedirs(storage_dir, exist_ok=True)
    stored_name = f"{file_uuid}_{safe_filename}"
    storage_path = os.path.join(storage_dir, stored_name)

    # Write file to disk
    contents = await file.read()
    file_size = len(contents)
    with open(storage_path, "wb") as f:
        f.write(contents)

    # If no message_id provided, create a file/image message automatically
    if message_id is None:
        msg_type = "image" if (file.content_type or "").startswith("image/") else "file"
        now = datetime.now(timezone.utc)
        msg = await db.fetch_one(
            """INSERT INTO chat_messages
                   (conversation_id, sender_id, content, message_type, created_at)
               VALUES ($1, $2, $3, $4, $5)
               RETURNING id""",
            conversation_id, user_id, safe_filename, msg_type, now,
        )
        message_id = msg["id"]
        await db.execute(
            "UPDATE chat_conversations SET updated_at = $1 WHERE id = $2",
            now, conversation_id,
        )

    # Insert attachment record
    attachment = await db.fetch_one(
        """INSERT INTO chat_attachments (message_id, filename, mime_type, file_size, storage_path, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           RETURNING id, message_id, filename, mime_type, file_size, created_at""",
        message_id, safe_filename, file.content_type, file_size, storage_path,
    )

    result = dict(attachment)
    result["url"] = f"/chat/files/{attachment['id']}"
    return result


@router.get("/files/{attachment_id}")
async def serve_file(attachment_id: int, user: dict = Depends(get_current_user)):
    """Serve an uploaded file. Verifies the caller is a participant in the
    attachment's conversation."""
    user_id = int(user["sub"])

    row = await db.fetch_one(
        """
        SELECT a.id, a.filename, a.mime_type, a.storage_path,
               m.conversation_id
        FROM chat_attachments a
        JOIN chat_messages m ON m.id = a.message_id
        WHERE a.id = $1
        """,
        attachment_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Attachment not found")

    await _verify_participant(row["conversation_id"], user_id)

    if not os.path.isfile(row["storage_path"]):
        raise HTTPException(status_code=404, detail="File not found on disk")

    return FileResponse(
        path=row["storage_path"],
        filename=row["filename"],
        media_type=row["mime_type"] or "application/octet-stream",
    )
