"""Conference management endpoints for UCaaS.

Provides conference room CRUD, scheduling, participant management, join info,
and live conference controls via FreeSWITCH ESL.  All resources are scoped
per-customer (multi-tenant).

FreeSWITCH conference naming: room_{customer_id}_{room_number}
"""
import logging
from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel, field_validator

from db import database as db
from auth.dependencies import get_current_user, get_customer_filter
from services.esl_client import _send_esl_command

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Pydantic request / response models
# ---------------------------------------------------------------------------

class ConferenceCreate(BaseModel):
    name: str
    customer_id: Optional[int] = None  # Required for admin users (no implicit customer)
    pin: Optional[str] = None
    moderator_pin: Optional[str] = None
    max_members: int = 50
    recording_enabled: bool = False
    video_enabled: bool = True

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        if not v or len(v.strip()) < 1 or len(v) > 100:
            raise ValueError("Name must be 1-100 characters")
        return v.strip()

    @field_validator("pin", "moderator_pin")
    @classmethod
    def validate_pin(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and (not v.isdigit() or len(v) < 4 or len(v) > 10):
            raise ValueError("PIN must be 4-10 digits")
        return v

    @field_validator("max_members")
    @classmethod
    def validate_max_members(cls, v: int) -> int:
        if v < 2 or v > 500:
            raise ValueError("max_members must be between 2 and 500")
        return v


class ConferenceUpdate(BaseModel):
    name: Optional[str] = None
    pin: Optional[str] = None
    moderator_pin: Optional[str] = None
    max_members: Optional[int] = None
    recording_enabled: Optional[bool] = None
    video_enabled: Optional[bool] = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and (len(v.strip()) < 1 or len(v) > 100):
            raise ValueError("Name must be 1-100 characters")
        return v.strip() if v else v

    @field_validator("pin", "moderator_pin")
    @classmethod
    def validate_pin(cls, v: Optional[str]) -> Optional[str]:
        # Allow empty string to clear the PIN
        if v is not None and v != "" and (not v.isdigit() or len(v) < 4 or len(v) > 10):
            raise ValueError("PIN must be 4-10 digits")
        if v == "":
            return None
        return v

    @field_validator("max_members")
    @classmethod
    def validate_max_members(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and (v < 2 or v > 500):
            raise ValueError("max_members must be between 2 and 500")
        return v


class ScheduleCreate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    start_time: datetime
    end_time: datetime
    recurrence_rule: Optional[str] = None

    @field_validator("end_time")
    @classmethod
    def validate_end_after_start(cls, v: datetime, info) -> datetime:
        start = info.data.get("start_time")
        if start and v <= start:
            raise ValueError("end_time must be after start_time")
        return v


class ParticipantInvite(BaseModel):
    user_ids: List[int]
    role: str = "participant"

    @field_validator("role")
    @classmethod
    def validate_role(cls, v: str) -> str:
        if v not in ("moderator", "participant"):
            raise ValueError("role must be 'moderator' or 'participant'")
        return v

    @field_validator("user_ids")
    @classmethod
    def validate_user_ids(cls, v: List[int]) -> List[int]:
        if not v:
            raise ValueError("user_ids must not be empty")
        return v


class MuteAction(BaseModel):
    mute: bool = True


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _fs_room_name(customer_id: int, room_number: str) -> str:
    """Build the FreeSWITCH conference room name (multi-tenant namespaced)."""
    return f"room_{customer_id}_{room_number}"


async def _get_conference(conference_id: int, customer_id: int | None) -> dict:
    """Fetch a conference ensuring tenant isolation. Returns the row dict or
    raises 404."""
    query = "SELECT * FROM conferences WHERE id = $1"
    values: list = [conference_id]
    if customer_id is not None:
        query += " AND customer_id = $2"
        values.append(customer_id)

    row = await db.fetch_one(query, *values)
    if not row:
        raise HTTPException(status_code=404, detail="Conference not found")
    return dict(row)


async def _get_conference_active(conference_id: int, customer_id: int | None) -> dict:
    """Fetch an active conference or raise 404."""
    conf = await _get_conference(conference_id, customer_id)
    if conf["status"] != "active":
        raise HTTPException(status_code=404, detail="Conference not found")
    return conf


# ---------------------------------------------------------------------------
# Conference CRUD
# ---------------------------------------------------------------------------

@router.get("")
async def list_conferences(
    status: Optional[str] = Query(None, description="Filter by status"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    customer_filter: int | None = Depends(get_customer_filter),
):
    """List conferences for the current user's customer.

    Admins (customer_filter=None) see all conferences.  Regular users are
    scoped to their own customer_id automatically.
    """
    query = """
        SELECT c.id, c.customer_id, c.name, c.room_number, c.pin IS NOT NULL AS has_pin,
               c.moderator_pin IS NOT NULL AS has_moderator_pin,
               c.max_members, c.recording_enabled, c.video_enabled,
               c.created_by, c.status, c.created_at,
               u.name AS creator_name
        FROM conferences c
        LEFT JOIN users u ON c.created_by = u.id
        WHERE 1=1
    """
    values: list = []
    idx = 1

    if customer_filter is not None:
        query += f" AND c.customer_id = ${idx}"
        values.append(customer_filter)
        idx += 1

    if status is not None:
        query += f" AND c.status = ${idx}"
        values.append(status)
        idx += 1

    query += f" ORDER BY c.created_at DESC LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([limit, offset])

    rows = await db.fetch_all(query, *values)
    return [dict(r) for r in rows]


@router.post("", status_code=201)
async def create_conference(
    body: ConferenceCreate,
    user: dict = Depends(get_current_user),
):
    """Create a new conference room.

    Room numbers are auto-assigned per-customer starting from 100, similar to
    extension auto-provisioning.
    """
    user_id = int(user["sub"])
    customer_id = user.get("customer_id")

    # Admin users must specify customer_id explicitly
    if customer_id is None:
        if body.customer_id is None:
            raise HTTPException(
                status_code=400,
                detail="Admin users must specify customer_id when creating conferences",
            )
        customer_id = body.customer_id

    # Auto-assign room_number: max existing + 1, base 100
    max_row = await db.fetch_one(
        "SELECT COALESCE(MAX(CAST(room_number AS INTEGER)), 99) AS max_room "
        "FROM conferences WHERE customer_id = $1",
        customer_id,
    )
    next_room = str(max_row["max_room"] + 1)

    row = await db.fetch_one(
        """INSERT INTO conferences
               (customer_id, name, room_number, pin, moderator_pin,
                max_members, recording_enabled, video_enabled, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, customer_id, name, room_number, pin IS NOT NULL AS has_pin,
                     moderator_pin IS NOT NULL AS has_moderator_pin,
                     max_members, recording_enabled, video_enabled,
                     created_by, status, created_at""",
        customer_id,
        body.name,
        next_room,
        body.pin,
        body.moderator_pin,
        body.max_members,
        body.recording_enabled,
        body.video_enabled,
        user_id,
    )

    result = dict(row)
    result["fs_room_name"] = _fs_room_name(customer_id, next_room)
    return result


@router.get("/{conference_id}")
async def get_conference(
    conference_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Get conference details including participants and upcoming schedules."""
    conf = await _get_conference(conference_id, customer_filter)

    # Fetch participants with user info
    participants = await db.fetch_all(
        """
        SELECT cp.id, cp.user_id, cp.extension, cp.role, cp.invited_at,
               u.name AS user_name, u.email AS user_email
        FROM conference_participants cp
        LEFT JOIN users u ON cp.user_id = u.id
        WHERE cp.conference_id = $1
        ORDER BY cp.invited_at ASC
        """,
        conference_id,
    )
    conf["participants"] = [dict(p) for p in participants]

    # Fetch upcoming schedules
    now = datetime.now(timezone.utc)
    schedules = await db.fetch_all(
        """
        SELECT id, title, description, start_time, end_time,
               recurrence_rule, created_by, created_at
        FROM conference_schedules
        WHERE conference_id = $1 AND end_time > $2
        ORDER BY start_time ASC
        LIMIT 20
        """,
        conference_id, now,
    )
    conf["upcoming_schedules"] = [dict(s) for s in schedules]

    return conf


@router.put("/{conference_id}")
async def update_conference(
    conference_id: int,
    body: ConferenceUpdate,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Update conference settings (name, pin, max_members, video_enabled, etc.)."""
    await _get_conference_active(conference_id, customer_filter)

    update_data = body.model_dump(exclude_unset=True)
    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update")

    updates: list[str] = []
    values: list = []
    idx = 1

    for field, value in update_data.items():
        updates.append(f"{field} = ${idx}")
        values.append(value)
        idx += 1

    values.append(conference_id)
    query = f"""
        UPDATE conferences SET {', '.join(updates)}
        WHERE id = ${idx}
        RETURNING id, customer_id, name, room_number,
                  pin IS NOT NULL AS has_pin,
                  moderator_pin IS NOT NULL AS has_moderator_pin,
                  max_members, recording_enabled, video_enabled,
                  created_by, status, created_at
    """
    row = await db.fetch_one(query, *values)
    if not row:
        raise HTTPException(status_code=404, detail="Conference not found")
    return dict(row)


@router.delete("/{conference_id}", status_code=200)
async def delete_conference(
    conference_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Soft-delete a conference by setting status to 'disabled'."""
    conf = await _get_conference(conference_id, customer_filter)
    if conf["status"] == "disabled":
        return {"status": "already_disabled", "conference_id": conference_id}

    await db.execute(
        "UPDATE conferences SET status = 'disabled' WHERE id = $1",
        conference_id,
    )
    return {"status": "disabled", "conference_id": conference_id}


# ---------------------------------------------------------------------------
# Scheduling
# ---------------------------------------------------------------------------

@router.post("/{conference_id}/schedule", status_code=201)
async def create_schedule(
    conference_id: int,
    body: ScheduleCreate,
    user: dict = Depends(get_current_user),
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Create a scheduled session for a conference."""
    await _get_conference_active(conference_id, customer_filter)
    user_id = int(user["sub"])

    row = await db.fetch_one(
        """INSERT INTO conference_schedules
               (conference_id, title, description, start_time, end_time,
                recurrence_rule, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, conference_id, title, description, start_time,
                     end_time, recurrence_rule, created_by, created_at""",
        conference_id,
        body.title,
        body.description,
        body.start_time,
        body.end_time,
        body.recurrence_rule,
        user_id,
    )
    return dict(row)


@router.get("/{conference_id}/schedule")
async def list_schedules(
    conference_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """List upcoming scheduled sessions for a conference."""
    await _get_conference(conference_id, customer_filter)
    now = datetime.now(timezone.utc)

    rows = await db.fetch_all(
        """
        SELECT cs.id, cs.conference_id, cs.title, cs.description,
               cs.start_time, cs.end_time, cs.recurrence_rule,
               cs.created_by, cs.created_at,
               u.name AS creator_name
        FROM conference_schedules cs
        LEFT JOIN users u ON cs.created_by = u.id
        WHERE cs.conference_id = $1 AND cs.end_time > $2
        ORDER BY cs.start_time ASC
        """,
        conference_id, now,
    )
    return [dict(r) for r in rows]


@router.delete("/{conference_id}/schedule/{schedule_id}", status_code=200)
async def delete_schedule(
    conference_id: int,
    schedule_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Cancel a scheduled session."""
    await _get_conference(conference_id, customer_filter)

    result = await db.execute(
        "DELETE FROM conference_schedules WHERE id = $1 AND conference_id = $2",
        schedule_id, conference_id,
    )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Schedule not found")
    return {"status": "deleted", "schedule_id": schedule_id}


# ---------------------------------------------------------------------------
# Participants
# ---------------------------------------------------------------------------

@router.post("/{conference_id}/participants", status_code=201)
async def invite_participants(
    conference_id: int,
    body: ParticipantInvite,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Invite users to a conference."""
    conf = await _get_conference_active(conference_id, customer_filter)
    customer_id = conf["customer_id"]

    # Validate all users exist and belong to the same customer
    user_rows = await db.fetch_all(
        "SELECT id, customer_id FROM users WHERE id = ANY($1)",
        body.user_ids,
    )
    found_ids = {r["id"] for r in user_rows}
    for uid in body.user_ids:
        if uid not in found_ids:
            raise HTTPException(status_code=400, detail=f"User {uid} not found")

    for r in user_rows:
        if r["customer_id"] != customer_id:
            raise HTTPException(
                status_code=403,
                detail=f"User {r['id']} does not belong to this customer",
            )

    # Also look up each user's extension for convenience
    ext_rows = await db.fetch_all(
        "SELECT user_id, extension FROM extensions "
        "WHERE customer_id = $1 AND user_id = ANY($2) AND status = 'active'",
        customer_id, body.user_ids,
    )
    ext_by_user = {r["user_id"]: r["extension"] for r in ext_rows}

    invited = []
    for uid in body.user_ids:
        ext = ext_by_user.get(uid)
        row = await db.fetch_one(
            """INSERT INTO conference_participants
                   (conference_id, user_id, extension, role)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (conference_id, user_id)
               DO UPDATE SET role = $4
               RETURNING id, conference_id, user_id, extension, role, invited_at""",
            conference_id, uid, ext, body.role,
        )
        invited.append(dict(row))

    return {"invited": invited, "count": len(invited)}


@router.get("/{conference_id}/participants")
async def list_participants(
    conference_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """List invited participants with presence status."""
    await _get_conference(conference_id, customer_filter)

    rows = await db.fetch_all(
        """
        SELECT cp.id, cp.user_id, cp.extension, cp.role, cp.invited_at,
               u.name AS user_name, u.email AS user_email,
               COALESCE(ps.status, 'offline') AS presence_status,
               ps.status_message AS presence_message
        FROM conference_participants cp
        LEFT JOIN users u ON cp.user_id = u.id
        LEFT JOIN presence_status ps ON cp.user_id = ps.user_id
        WHERE cp.conference_id = $1
        ORDER BY cp.role ASC, cp.invited_at ASC
        """,
        conference_id,
    )
    return [dict(r) for r in rows]


@router.delete("/{conference_id}/participants/{user_id}", status_code=200)
async def remove_participant(
    conference_id: int,
    user_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Remove a user from a conference's invite list."""
    await _get_conference(conference_id, customer_filter)

    result = await db.execute(
        "DELETE FROM conference_participants WHERE conference_id = $1 AND user_id = $2",
        conference_id, user_id,
    )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Participant not found")
    return {"status": "removed", "user_id": user_id}


# ---------------------------------------------------------------------------
# Conference join info
# ---------------------------------------------------------------------------

@router.get("/{conference_id}/join")
async def get_join_info(
    conference_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Return the information needed to join a conference: dial code, PIN,
    and WebRTC join URL."""
    conf = await _get_conference_active(conference_id, customer_filter)
    customer_id = conf["customer_id"]
    room_number = conf["room_number"]

    return {
        "conference_id": conf["id"],
        "name": conf["name"],
        "room_number": room_number,
        "dial_code": f"*88{room_number}",
        "has_pin": conf["pin"] is not None,
        "has_moderator_pin": conf["moderator_pin"] is not None,
        "max_members": conf["max_members"],
        "video_enabled": conf["video_enabled"],
        "fs_room_name": _fs_room_name(customer_id, room_number),
        "webrtc_join_url": f"/webrtc/conference/{conference_id}",
    }


# ---------------------------------------------------------------------------
# Live controls (via ESL)
# ---------------------------------------------------------------------------

def _parse_conference_list(raw: str) -> list[dict]:
    """Parse the output of 'conference <name> list' into structured data.

    FreeSWITCH conference list lines have this field order (semicolon-separated):
        member_id ; net_addr:port ; caller_id_number ; caller_id_name ; uuid ; codec ; flags

    Note: parts[1] is the network address (e.g. "10.0.0.1:30456"), NOT the
    caller ID.  The caller ID number is at parts[2] and the display name is at
    parts[3].  An earlier version of this parser had the offsets wrong, which
    caused caller_id_number to contain an IP:port string instead of the
    extension number, breaking the local-tile identification logic in the UI.
    """
    members = []
    if not raw:
        return members

    for line in raw.strip().split("\n"):
        line = line.strip()
        # Skip header/footer lines
        if not line or line.startswith("Conference") or line.startswith("+OK") or line.startswith("-ERR"):
            continue
        # Skip content-type / content-length ESL envelope lines
        if ":" in line and ";" not in line:
            continue

        parts = line.split(";")
        if len(parts) < 4:
            continue

        # parts[0] = member_id
        # parts[1] = net_addr:port  (skipped — not useful to the frontend)
        # parts[2] = caller_id_number  (e.g. "100")
        # parts[3] = caller_id_name    (e.g. "Keegan Grabhorn")
        # parts[4] = uuid
        # parts[5] = codec
        # parts[6] = flags             (e.g. "hear|speak|talking|video")
        member = {
            "member_id": parts[0].strip(),
            "caller_id": parts[2].strip() if len(parts) > 2 else "",
            "caller_name": parts[3].strip() if len(parts) > 3 else "",
            "uuid": parts[4].strip() if len(parts) > 4 else "",
            "codec": parts[5].strip() if len(parts) > 5 else "",
        }

        # Parse flags if present (e.g. "hear|speak|talking")
        if len(parts) > 6:
            flags_str = parts[6].strip()
            flags = [f.strip() for f in flags_str.split("|") if f.strip()]
            member["flags"] = flags
            member["is_talking"] = "talking" in flags
            member["is_muted"] = "speak" not in flags
        else:
            member["flags"] = []
            member["is_talking"] = False
            member["is_muted"] = False

        members.append(member)

    return members


@router.get("/{conference_id}/live")
async def get_live_status(
    conference_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Get live conference status from FreeSWITCH: current members, talking
    status, mute state.

    Sends ESL command: conference room_{customer_id}_{room_number} list
    """
    conf = await _get_conference_active(conference_id, customer_filter)
    fs_name = _fs_room_name(conf["customer_id"], conf["room_number"])

    response = await _send_esl_command(f"conference {fs_name} list")

    if not response or "-ERR" in response:
        # Conference not currently active in FS
        return {
            "conference_id": conference_id,
            "fs_room_name": fs_name,
            "is_active": False,
            "active": False,
            "member_count": 0,
            "members": [],
            "recording": False,
        }

    raw_members = _parse_conference_list(response)

    # Transform raw parsed fields into the shape the frontend expects:
    #   id                <- member_id (int)
    #   name              <- caller_name (falls back to caller_id if blank)
    #   caller_id_number  <- caller_id (the raw extension number, e.g. "100")
    #   talking           <- is_talking
    #   muted             <- is_muted
    #   video             <- False (audio-only conferences; update when MCU video is wired)
    #
    # caller_id_number is kept separate from name so the frontend can identify
    # the local user's tile by comparing against credentials.extension without
    # relying on display-name matching.
    members = [
        {
            "id": int(m["member_id"]) if m["member_id"].isdigit() else 0,
            "name": m["caller_name"] or m["caller_id"] or "Unknown",
            "caller_id_number": m["caller_id"] or "",
            "talking": m["is_talking"],
            "muted": m["is_muted"],
            "video": False,
        }
        for m in raw_members
    ]

    is_active = len(members) > 0
    return {
        "conference_id": conference_id,
        "fs_room_name": fs_name,
        "is_active": is_active,
        "active": is_active,
        "member_count": len(members),
        "members": members,
        "recording": False,
    }


@router.post("/{conference_id}/kick/{member_id}")
async def kick_member(
    conference_id: int,
    member_id: str,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Kick a participant from a live conference via ESL.

    member_id is the FreeSWITCH conference member ID (from /live endpoint).
    """
    conf = await _get_conference_active(conference_id, customer_filter)
    fs_name = _fs_room_name(conf["customer_id"], conf["room_number"])

    response = await _send_esl_command(f"conference {fs_name} kick {member_id}")

    if not response or "-ERR" in response:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to kick member: {response or 'ESL timeout'}",
        )

    return {"status": "kicked", "member_id": member_id}


@router.post("/{conference_id}/mute/{member_id}")
async def mute_member(
    conference_id: int,
    member_id: str,
    body: MuteAction = MuteAction(),
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Mute or unmute a participant in a live conference via ESL.

    body.mute = true (default) mutes, false unmutes.
    """
    conf = await _get_conference_active(conference_id, customer_filter)
    fs_name = _fs_room_name(conf["customer_id"], conf["room_number"])

    action = "mute" if body.mute else "unmute"
    response = await _send_esl_command(f"conference {fs_name} {action} {member_id}")

    if not response or "-ERR" in response:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to {action} member: {response or 'ESL timeout'}",
        )

    return {"status": action + "d", "member_id": member_id}


@router.post("/{conference_id}/record/start")
async def start_recording(
    conference_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Start recording a live conference via ESL.

    Recording path: /data/recordings/conferences/{customer_id}/{fs_room_name}_{timestamp}.wav
    """
    conf = await _get_conference_active(conference_id, customer_filter)
    customer_id = conf["customer_id"]
    fs_name = _fs_room_name(customer_id, conf["room_number"])

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    recording_path = f"/data/recordings/conferences/{customer_id}/{fs_name}_{timestamp}.wav"

    response = await _send_esl_command(f"conference {fs_name} record {recording_path}")

    if not response or "-ERR" in response:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to start recording: {response or 'ESL timeout'}",
        )

    # Create a session record to track the recording
    session = await db.fetch_one(
        """INSERT INTO conference_sessions (conference_id, recording_path)
           VALUES ($1, $2)
           RETURNING id, conference_id, started_at, recording_path""",
        conference_id, recording_path,
    )

    return {
        "status": "recording_started",
        "recording_path": recording_path,
        "session_id": session["id"],
    }


@router.post("/{conference_id}/record/stop")
async def stop_recording(
    conference_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Stop recording a live conference via ESL."""
    conf = await _get_conference_active(conference_id, customer_filter)
    fs_name = _fs_room_name(conf["customer_id"], conf["room_number"])

    # The 'norecord' command stops all recordings for the conference
    response = await _send_esl_command(f"conference {fs_name} norecord all")

    if not response or "-ERR" in response:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to stop recording: {response or 'ESL timeout'}",
        )

    # Close the most recent open session for this conference
    now = datetime.now(timezone.utc)
    await db.execute(
        """UPDATE conference_sessions
           SET ended_at = $1
           WHERE conference_id = $2 AND ended_at IS NULL""",
        now, conference_id,
    )

    return {"status": "recording_stopped"}
