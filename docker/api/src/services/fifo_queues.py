"""Tenant-scoping + parsing helpers for LIVE FreeSWITCH ``mod_fifo`` queues — Phase 8.

Pure stdlib (``xml``/``re``) so the parsing + tenant-scoping logic is
unit-testable with SYNTHETIC ESL output and carries no heavy import cost (no
fastapi/asyncpg/boto3). Mirrors :mod:`services.conference_rooms`.

``mod_fifo`` queues used by the platform are tenant-namespaced:

    fifo_<customer_id>_<name>

Tenant ownership is encoded ENTIRELY in the queue-name prefix — the queues are
created on the media server (FreeSWITCH) and have no backing DB row, so the
prefix is the ONLY tenant gate. The display name shown to a customer has the
``fifo_<customer_id>_`` prefix stripped.

``fifo list`` emits XML (``<fifo_report><fifo name=...><callers><caller .../>``).
The parser is defensive: it tolerates an ``+OK`` envelope, a single bare
``<fifo>`` element, missing count attributes (falls back to counting waiting
``<caller>`` elements), and returns ``[]`` for any empty / non-XML / error
payload. That graceful path is what matters on Docker Desktop, where
``_send_esl_command`` returns None because the bridge-networked API container
cannot reach host-net FreeSWITCH — the live endpoints must degrade to empty,
never 500.
"""
import re
import xml.etree.ElementTree as ET
from typing import Optional, List, Dict, Any

# Tenant-namespaced queue prefix on the media server.
QUEUE_PREFIX = "fifo_"

# Queue names are alphanumerics + underscore only. Anything else (spaces,
# newlines from %0A, ';', '&') is rejected before it can reach an ESL command
# line — prevents ESL command injection. Mirrors conference_rooms.SAFE_ROOM_RE.
SAFE_QUEUE_RE = re.compile(r"^[A-Za-z0-9_]+$")


def fs_queue_name(customer_id: int, name: str) -> str:
    """Customer C's queue ``name`` → FS fifo ``fifo_<C>_<name>``."""
    return f"{QUEUE_PREFIX}{customer_id}_{name}"


def is_safe_queue_name(name: str) -> bool:
    """True only for alnum+underscore names (see SAFE_QUEUE_RE). Guards every
    queue-name value interpolated into an ESL command string."""
    return bool(name) and bool(SAFE_QUEUE_RE.match(name))


def queue_owner_customer_id(name: str) -> Optional[int]:
    """Extract the owning customer_id encoded in a FS fifo name, or None when
    the name does not match the ``fifo_<digits>_`` scheme."""
    if not name or not name.startswith(QUEUE_PREFIX):
        return None
    head = name[len(QUEUE_PREFIX):].split("_", 1)[0]
    return int(head) if head.isdigit() else None


def queue_display_name(name: str) -> str:
    """Strip the ``fifo_<customer_id>_`` prefix for display. Returns the original
    name unchanged when it does not match the tenant scheme."""
    if not name or not name.startswith(QUEUE_PREFIX):
        return name
    head, sep, tail = name[len(QUEUE_PREFIX):].partition("_")
    if head.isdigit() and sep:
        return tail
    return name


def queue_visible(name: str, customer_filter: Optional[int]) -> bool:
    """Whether the requester may see this queue. ``customer_filter`` is None for
    admins (see everything); otherwise the user's own customer_id."""
    if customer_filter is None:
        return True
    return queue_owner_customer_id(name) == customer_filter


def _to_int(value: Optional[str]) -> Optional[int]:
    if value is None:
        return None
    try:
        return int(value)
    except (ValueError, TypeError):
        return None


def _caller_view(el: ET.Element) -> Dict[str, Any]:
    """Normalize one waiting ``<caller>`` element into the shape the frontend
    consumes. Attributes vary across FS builds, so several aliases are tried."""
    a = el.attrib
    number = a.get("caller_id_number") or a.get("cid_number") or ""
    name = a.get("caller_id_name") or a.get("cid_name") or number or "Unknown"
    return {
        "uuid": a.get("uuid") or a.get("call_uuid") or "",
        "caller_id_number": number,
        "caller_id_name": name,
        "status": a.get("status") or "",
    }


def parse_fifo_list(raw: Optional[str]) -> List[Dict[str, Any]]:
    """Parse ``fifo list`` XML output into ``[{name, depth, members}]``.

    ``depth`` is the number of waiting callers: an explicit ``caller_total`` /
    ``waiting_count`` attribute when present, else a count of ``<caller>``
    descendants. Returns ``[]`` for any empty / non-XML / error payload (the
    Docker-Desktop graceful path).
    """
    if not raw:
        return []
    text = raw.strip()
    start = text.find("<")
    end = text.rfind(">")
    if start == -1 or end == -1 or end < start:
        return []
    try:
        root = ET.fromstring(text[start:end + 1])
    except ET.ParseError:
        return []

    fifos = [root] if root.tag == "fifo" else root.findall(".//fifo")

    out: List[Dict[str, Any]] = []
    for f in fifos:
        name = f.get("name") or ""
        if not name:
            continue
        callers = f.findall(".//caller")
        members = [_caller_view(c) for c in callers]
        depth = _to_int(f.get("caller_total"))
        if depth is None:
            depth = _to_int(f.get("waiting_count"))
        if depth is None:
            depth = len(members)
        out.append({"name": name, "depth": depth, "members": members})
    return out


def scope_queues(
    parsed: List[Dict[str, Any]], customer_filter: Optional[int]
) -> List[Dict[str, Any]]:
    """Filter parsed queues to those VISIBLE to the tenant, strip the prefix for
    display, and attach the owning customer_id. Admins (customer_filter None) see
    every queue."""
    result: List[Dict[str, Any]] = []
    for q in parsed:
        if not queue_visible(q["name"], customer_filter):
            continue
        result.append({
            "name": queue_display_name(q["name"]),
            "fs_name": q["name"],
            "customer_id": queue_owner_customer_id(q["name"]),
            "depth": q["depth"],
        })
    return result
