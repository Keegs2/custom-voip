"""Tenant-scoping + parsing helpers for LIVE FreeSWITCH conferences — Phase 7.

Pure stdlib (json/re) so the parsing + tenant-scoping logic is unit-testable
with SYNTHETIC ESL output and carries no heavy import cost (no fastapi/asyncpg/
boto3). Two naming schemes share the FreeSWITCH conference space:

    UCaaS scheduled rooms              room_<customer_id>_<room_number>
    Programmable-voice <Conference>    conf_<customer_id>_<sanitized_name>

Tenant ownership is encoded ENTIRELY in the room-name prefix. The programmatic
``conf_`` rooms (created by the TwiML ``<Conference>`` verb) have NO backing row
in the ``conferences`` table, so the prefix is the ONLY tenant gate for them —
which is exactly why the scope check lives here and is exercised by unit tests.
"""
import json
import re
from typing import Optional, List, Dict, Any

# Both tenant-namespaced room schemes on the media server.
ROOM_PREFIXES = ("conf_", "room_")

# Conference/room names are alphanumerics + underscore only. Anything else in a
# room-name path segment (spaces, newlines from %0A, ';', '&') is rejected before
# it can reach an ESL command line — prevents ESL command injection.
SAFE_ROOM_RE = re.compile(r"^[A-Za-z0-9_]+$")


def conf_room_name(customer_id: int, name: str) -> str:
    """Programmable-voice ``<Conference name="X">`` for customer C → FS room
    ``conf_<C>_<sanitized X>``. MUST match the telephony agent's sanitizer:
    lowercase, every non-alphanumeric character → ``_``."""
    sanitized = "".join(ch if ch.isalnum() else "_" for ch in name).lower()
    return f"conf_{customer_id}_{sanitized}"


def is_safe_room_name(room_name: str) -> bool:
    """True only for alnum+underscore names (see SAFE_ROOM_RE). Guards every
    room-name value that is interpolated into an ESL command string."""
    return bool(room_name) and bool(SAFE_ROOM_RE.match(room_name))


def room_owner_customer_id(room_name: str) -> Optional[int]:
    """Extract the owning customer_id encoded in a FS conference room name, or
    None when the name matches neither tenant scheme."""
    if not room_name:
        return None
    for prefix in ROOM_PREFIXES:
        if room_name.startswith(prefix):
            head = room_name[len(prefix):].split("_", 1)[0]
            if head.isdigit():
                return int(head)
    return None


def room_visible(room_name: str, customer_filter: Optional[int]) -> bool:
    """Whether the requester may see/control this room. ``customer_filter`` is
    None for admins (see everything); otherwise the user's own customer_id."""
    if customer_filter is None:
        return True
    return room_owner_customer_id(room_name) == customer_filter


def _member_view(m: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize one FS ``conference json_list`` member into the shape the
    frontend consumes (matching the per-room ``/live`` endpoint)."""
    flags = m.get("flags") if isinstance(m.get("flags"), dict) else {}
    number = str(m.get("caller_id_number") or m.get("caller_id") or "")
    name = m.get("caller_id_name") or m.get("caller_name") or number or "Unknown"
    mid = str(m.get("id") or m.get("member_id") or "0")
    # can_speak is the authoritative mute signal in json_list; fall back to the
    # legacy 'speak' flag if present.
    muted = (flags.get("can_speak") is False) or (flags.get("speak") is False)
    return {
        "id": int(mid) if mid.isdigit() else 0,
        "name": name,
        "caller_id_number": number,
        "talking": bool(flags.get("talking")),
        "muted": bool(muted),
        "video": bool(flags.get("has_video") or flags.get("video")),
    }


def parse_conference_json_list(raw: Optional[str]) -> List[Dict[str, Any]]:
    """Parse ``conference json_list`` output into
    ``[{name, member_count, members, recording}]``.

    Returns ``[]`` for any empty / non-JSON / error payload. This is the graceful
    path that matters on Docker Desktop, where ``_send_esl_command`` returns None
    because the bridge-networked API container cannot reach host-net FreeSWITCH —
    the live endpoint must degrade to empty, never 500.
    """
    if not raw:
        return []
    text = raw.strip()
    # Tolerate a leading ``+OK`` line or other envelope noise: start at the first
    # JSON opener.
    start = -1
    for i, ch in enumerate(text):
        if ch in "[{":
            start = i
            break
    if start == -1:
        return []
    try:
        data = json.loads(text[start:])
    except (ValueError, TypeError):
        return []
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list):
        return []

    out: List[Dict[str, Any]] = []
    for conf in data:
        if not isinstance(conf, dict):
            continue
        name = conf.get("conference_name") or conf.get("name") or ""
        if not name:
            continue
        members: List[Dict[str, Any]] = []
        recording = False
        for m in conf.get("members", []) or []:
            if not isinstance(m, dict):
                continue
            # FS represents an active recording as a synthetic 'recording_node'
            # member — surface it as a flag, not a participant.
            if m.get("type") == "recording_node":
                recording = True
                continue
            members.append(_member_view(m))
        out.append({
            "name": name,
            "member_count": len(members),
            "members": members,
            "recording": recording,
        })
    return out


def scope_conferences(
    parsed: List[Dict[str, Any]], customer_filter: Optional[int]
) -> List[Dict[str, Any]]:
    """Filter parsed conferences to those VISIBLE to the tenant and attach the
    owning customer_id. Admins (customer_filter None) see every room."""
    result: List[Dict[str, Any]] = []
    for conf in parsed:
        if not room_visible(conf["name"], customer_filter):
            continue
        result.append({
            "fs_room_name": conf["name"],
            "customer_id": room_owner_customer_id(conf["name"]),
            "member_count": conf["member_count"],
            "members": conf["members"],
            "recording": conf["recording"],
        })
    return result
