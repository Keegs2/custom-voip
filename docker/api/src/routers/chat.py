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
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, field_validator

from db import database as db
from db.redis_client import get_client
from auth.dependencies import get_current_user
from services import storage
from services import envelope_crypto as ec
from services.upload_security import (
    validate_upload, UploadRejected, CHAT_MAX_FILE_SIZE,
)

logger = logging.getLogger(__name__)

router = APIRouter()

CHAT_EVENTS_CHANNEL = "chat:events"
CHAT_TYPING_CHANNEL = "chat:typing"
ATTACHMENT_URL_TTL = int(os.getenv("CHAT_ATTACHMENT_URL_TTL", "3600"))

# Encryption-at-rest for message bodies: 'on' (default — encrypt when a KEK is
# configured) or 'off' (legacy plaintext). Each conversation has ONE DEK (wrapped
# under the customer chat KEK, stored on chat_conversations); every message body
# is AES-256-GCM encrypted with that DEK (fresh IV per message). Reading a thread
# unwraps the DEK ONCE — never once per message — so a KMS-backed provider is not
# N+1'd. Real-time delivery (WS event payloads) carries the sender's plaintext
# over TLS; only the at-rest copy is ciphertext.
CHAT_ENCRYPTION = os.getenv("CHAT_ENCRYPTION", "on").lower()


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
# Encryption-at-rest helpers (per-conversation DEK)
# ---------------------------------------------------------------------------

def _chat_scope(customer_id: int) -> str:
    """Stable KEK scope for a customer's chat (one KEK per customer)."""
    return f"chat:customer:{int(customer_id)}"


_warned_chat_plaintext = False


def _encryption_enabled() -> bool:
    enabled = CHAT_ENCRYPTION != "off" and ec.encryption_configured()
    # MEDIUM-9: when encryption is EXPECTED (mode != 'off') but no KEK is
    # configured, message bodies are stored plaintext. That must not be SILENT in
    # production — emit one loud warning so the missing-KEK misconfig is visible.
    if not enabled and CHAT_ENCRYPTION != "off":
        global _warned_chat_plaintext
        if not _warned_chat_plaintext:
            from config_guard import is_production
            log = logger.error if is_production() else logger.warning
            log(
                "SECURITY: CHAT_ENCRYPTION=%s but no KEK is configured — chat message "
                "bodies are being stored PLAINTEXT at rest. Configure ENVELOPE_LOCAL_KEK "
                "(or a KMS provider) in production.", CHAT_ENCRYPTION,
            )
            _warned_chat_plaintext = True
    return enabled


async def _conversation_crypto(conversation_id: int) -> Optional[dict]:
    """Load a conversation's envelope columns (SELECT * so it degrades to
    'no encryption columns' on a DB where the migration is not yet applied)."""
    row = await db.fetch_one("SELECT * FROM chat_conversations WHERE id = $1", conversation_id)
    return dict(row) if row else None


async def _conversation_dek(
    conversation_id: int, customer_id: Optional[int], *, create: bool, cache: dict
) -> Optional[bytes]:
    """Return the raw per-conversation DEK bytes (cached per request), or None.

    * If the conversation already has a wrapped DEK, unwrap it (once, cached).
    * Else if ``create`` and encryption is enabled, provision a fresh DEK, wrap it
      under the customer chat KEK, and persist it on the conversation. A
      concurrent creator is handled by an ``UPDATE ... WHERE wrapped_dek IS NULL``
      followed by an authoritative re-read (all messages share ONE DEK).
    * Else None (message stored/kept plaintext).
    """
    if conversation_id in cache:
        return cache[conversation_id]

    dek: Optional[bytes] = None
    crypto = await _conversation_crypto(conversation_id)
    if crypto is not None and crypto.get("wrapped_dek") is not None:
        dek = await ec.unwrap_dek(
            crypto["wrapped_dek"], crypto.get("kek_provider") or "local", crypto["kek_key_ref"],
        )
    elif create and _encryption_enabled() and customer_id is not None:
        kek_provider, kek_key_ref = await ec.resolve_or_create_kek(
            _chat_scope(customer_id), customer_id
        )
        new_dek = ec.generate_dek()
        wrapped = await ec.wrap_dek(new_dek, kek_provider, kek_key_ref)
        await db.execute(
            """
            UPDATE chat_conversations
               SET wrapped_dek = $1::bytea, kek_provider = $2::text,
                   kek_key_ref = $3::text, enc_algo = $4::text,
                   encryption_status = 'encrypted'
             WHERE id = $5 AND wrapped_dek IS NULL
            """,
            wrapped, kek_provider, kek_key_ref, ec.ENC_ALGO, conversation_id,
        )
        # Authoritative re-read handles the race: use whichever DEK persisted.
        crypto2 = await _conversation_crypto(conversation_id)
        if crypto2 is not None and crypto2.get("wrapped_dek") is not None:
            dek = await ec.unwrap_dek(
                crypto2["wrapped_dek"], crypto2.get("kek_provider") or "local",
                crypto2["kek_key_ref"],
            )
        else:
            dek = new_dek

    cache[conversation_id] = dek
    return dek


def _strip_cipher_columns(d: dict) -> dict:
    """Remove the raw ciphertext columns from a message dict before returning it
    (they are BYTEA and not JSON-serialisable; content is exposed decrypted)."""
    d.pop("content_ciphertext", None)
    d.pop("content_iv", None)
    d.pop("enc_algo", None)
    return d


async def _decrypt_message_row(d: dict, conversation_id: int,
                               customer_id: Optional[int], cache: dict) -> dict:
    """Decrypt a message dict's body in place (if encrypted) and strip cipher
    columns. Soft-deleted messages keep content=None. Never raises out."""
    ct = d.get("content_ciphertext")
    iv = d.get("content_iv")
    if d.get("deleted_at"):
        d["content"] = None
    elif ct is not None and iv is not None:
        dek = await _conversation_dek(conversation_id, customer_id, create=False, cache=cache)
        if dek is not None:
            try:
                d["content"] = ec.decrypt_with_dek(dek, ct, iv).decode("utf-8")
            except Exception:
                logger.warning("chat: failed to decrypt message %s", d.get("id"), exc_info=True)
                d["content"] = None
        else:
            d["content"] = None
    return _strip_cipher_columns(d)


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
                    'email', pu.email,
                    'presence_status', COALESCE(
                        CASE WHEN pp_ps.updated_at > NOW() - INTERVAL '60 seconds'
                        THEN pp_ps.status ELSE 'offline' END,
                        'offline'
                    )
                ))
                FROM chat_participants pp
                JOIN users pu ON pu.id = pp.user_id
                LEFT JOIN presence_status pp_ps ON pp_ps.user_id = pu.id
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
    dek_cache: dict = {}
    for r in rows:
        d = dict(r)
        # Parse participants JSON from postgres json_agg
        if d.get("participants") and isinstance(d["participants"], str):
            d["participants"] = orjson.loads(d["participants"])
        # Decrypt the last-message preview if it is stored encrypted (content is
        # NULL on the row for encrypted messages). One DEK unwrap per conversation.
        if d.get("last_message_content") is None and d.get("last_message_id") is not None:
            d["last_message_content"] = await _decrypt_preview(
                d["last_message_id"], d["id"], dek_cache
            )
        results.append(d)
    return results


async def _decrypt_preview(message_id: int, conversation_id: int, cache: dict):
    """Decrypt a conversation's last-message preview (for the conversation list).
    Returns the plaintext, the legacy plaintext content, or None. Never raises."""
    row = await db.fetch_one("SELECT * FROM chat_messages WHERE id = $1", message_id)
    if not row:
        return None
    d = dict(row)
    if d.get("deleted_at"):
        return None
    ct, iv = d.get("content_ciphertext"), d.get("content_iv")
    if ct is None or iv is None:
        return d.get("content")
    dek = await _conversation_dek(conversation_id, None, create=False, cache=cache)
    if dek is None:
        return None
    try:
        return ec.decrypt_with_dek(dek, ct, iv).decode("utf-8")
    except Exception:
        return None


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
               u.name, u.email,
               COALESCE(
                   CASE WHEN p.updated_at > NOW() - INTERVAL '60 seconds'
                   THEN p.status ELSE 'offline' END,
                   'offline'
               ) AS presence_status
        FROM chat_participants cp
        JOIN users u ON u.id = cp.user_id
        LEFT JOIN presence_status p ON p.user_id = cp.user_id
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

    conv = await _verify_conversation_customer(conversation_id, customer_id, user_id)
    if customer_id is not None:
        await _verify_participant(conversation_id, user_id)

    # SELECT m.* so the (possibly-present) content_ciphertext/content_iv columns
    # come back for decryption; they are stripped from the response by
    # _decrypt_message_row. On an un-migrated DB they simply are not present.
    query = """
        SELECT m.*,
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

    # Decrypt bodies transparently: the per-conversation DEK is unwrapped at most
    # ONCE (cached) for the whole page, not per message. The response shape is
    # identical to before (plaintext `content`, cipher columns stripped).
    dek_cache: dict = {}
    conv_customer_id = conv.get("customer_id")
    results = []
    for r in rows:
        d = await _decrypt_message_row(dict(r), conversation_id, conv_customer_id, dek_cache)
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

    conv = await _verify_conversation_customer(conversation_id, customer_id, user_id)
    if customer_id is not None:
        await _verify_participant(conversation_id, user_id)

    now = datetime.now(timezone.utc)

    # Encrypt the body at rest with the per-conversation DEK when enabled +
    # configured (lazily provisioning the DEK on first encrypted message).
    enc = None
    if _encryption_enabled():
        dek = await _conversation_dek(conversation_id, conv.get("customer_id"), create=True, cache={})
        if dek is not None:
            enc = ec.encrypt_with_dek(dek, body.content.encode("utf-8"))

    if enc is not None:
        ct, iv = enc
        msg = await db.fetch_one(
            """INSERT INTO chat_messages
                   (conversation_id, sender_id, content, content_ciphertext, content_iv,
                    enc_algo, message_type, reply_to_id, created_at)
               VALUES ($1, $2, NULL, $3::bytea, $4::bytea, $5::text, $6, $7, $8)
               RETURNING id, conversation_id, sender_id, message_type,
                         reply_to_id, edited_at, deleted_at, created_at""",
            conversation_id, user_id, ct, iv, ec.ENC_ALGO, body.message_type,
            body.reply_to_id, now,
        )
    else:
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
    # Response + WS event carry the sender's plaintext (the at-rest copy is
    # ciphertext); delivery is over TLS. Keeps the API/event shape unchanged.
    result["content"] = body.content
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

    conv = await _verify_conversation_customer(conversation_id, customer_id, user_id)
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

    # Re-encrypt the edited body at rest with the per-conversation DEK when enabled.
    enc = None
    if _encryption_enabled():
        dek = await _conversation_dek(conversation_id, conv.get("customer_id"), create=True, cache={})
        if dek is not None:
            enc = ec.encrypt_with_dek(dek, body.content.encode("utf-8"))

    if enc is not None:
        ct, iv = enc
        updated = await db.fetch_one(
            """UPDATE chat_messages
                  SET content = NULL, content_ciphertext = $1::bytea, content_iv = $2::bytea,
                      enc_algo = $3::text, edited_at = $4
                WHERE id = $5
                RETURNING id, conversation_id, sender_id, message_type,
                          reply_to_id, edited_at, deleted_at, created_at""",
            ct, iv, ec.ENC_ALGO, now, message_id,
        )
    else:
        updated = await db.fetch_one(
            """UPDATE chat_messages SET content = $1, edited_at = $2
               WHERE id = $3
               RETURNING id, conversation_id, sender_id, content, message_type,
                         reply_to_id, edited_at, deleted_at, created_at""",
            body.content, now, message_id,
        )

    result = dict(updated)
    result["content"] = body.content

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

    # Read + run the upload-security gate: size limit, content-type allowlist,
    # filename sanitisation (no path traversal), and the pluggable AV scan.
    contents = await file.read()
    file_size = len(contents)
    try:
        safe_filename = validate_upload(
            content_type=file.content_type,
            size=file_size,
            max_size=CHAT_MAX_FILE_SIZE,
            data=contents,
            filename=file.filename,
        )
    except UploadRejected as e:
        raise HTTPException(status_code=e.status_code, detail=e.detail)

    # Tenant-scoped object key in the voip-uploads bucket.
    file_uuid = uuid.uuid4().hex
    object_key = storage.tenant_key(
        int(storage_customer_id), "chat", str(conversation_id),
        f"{file_uuid}_{safe_filename}",
    )
    try:
        storage.put_file(
            storage.BUCKET_UPLOADS, object_key, contents,
            file.content_type or "application/octet-stream",
        )
    except storage.StorageError:
        logger.exception("Chat upload storage failure for conv %s", conversation_id)
        raise HTTPException(status_code=503, detail="Storage temporarily unavailable")
    storage_path = object_key

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

    path = row["storage_path"]

    # Legacy rows stored an on-disk path; serve directly if present.
    if path and path.startswith("/"):
        if not os.path.isfile(path):
            raise HTTPException(status_code=404, detail="File not found on disk")
        return FileResponse(
            path=path,
            filename=row["filename"],
            media_type=row["mime_type"] or "application/octet-stream",
        )

    # Object-storage key: redirect to a short-lived presigned URL.
    try:
        url = storage.presigned_get_url(
            storage.BUCKET_UPLOADS, path, ttl=ATTACHMENT_URL_TTL
        )
    except storage.StorageError:
        logger.exception("Failed to presign chat attachment %s", attachment_id)
        raise HTTPException(status_code=503, detail="Storage temporarily unavailable")
    return RedirectResponse(url=url, status_code=307)
