"""Append-only voicemail audit (``voicemail_access_log``, migration 54).

Every write here is FAIL-CLOSED for the caller: the helpers raise on any
database error and the caller turns that into a 503 without serving audio /
without committing the audited change (build-plan defect 10). The api role
may only INSERT + SELECT this table.

Actions (contract §1; the column is free text, these are the values in use):
deposit | play | download | greeting_upload | greeting_play |
greeting_fs_fetch | greeting_delete | message_delete | message_purge |
mailbox_create | mailbox_update | mailbox_delete | pin_set | key_create |
crypto_erase | retention_purge.
Sources: ui | freeswitch | system | admin.
"""
from __future__ import annotations

import ipaddress
import json
from dataclasses import dataclass
from typing import Any

#: Actions written at most once per playback token (unique index
#: uq_vm_access_log_playback_jti — its predicate must match this tuple).
ONCE_PER_TOKEN_ACTIONS = ("play", "download", "greeting_play")

_INSERT_COLUMNS = ("customer_id, mailbox_id, message_id, greeting_id, action, actor_user_id, "
                   "source, ip_address, user_agent, detail")
_INSERT_VALUES = ("$1::int, $2::int, $3::bigint, $4::int, $5::varchar, $6::int, "
                  "$7::varchar, $8::varchar, $9::varchar, $10::jsonb")


@dataclass(frozen=True)
class RequestInfo:
    """Who/where for an audit row (never contains secrets or tokens)."""

    actor_user_id: int | None = None
    ip_address: str | None = None
    user_agent: str | None = None

    @classmethod
    def from_request(cls, request: Any, actor_user_id: int | None = None) -> "RequestInfo":
        ip = None
        real_ip = request.headers.get("x-real-ip") if request is not None else None
        if real_ip:
            try:
                ip = str(ipaddress.ip_address(real_ip.strip()))
            except ValueError:
                ip = None
        if ip is None and request is not None and request.client is not None:
            ip = request.client.host
        ua = request.headers.get("user-agent") if request is not None else None
        return cls(actor_user_id=actor_user_id,
                   ip_address=(ip or None) and ip[:64],
                   user_agent=(ua or None) and ua[:255])


def _params(*, action: str, source: str, customer_id, mailbox_id, message_id, greeting_id,
            info: RequestInfo | None, detail: dict | None) -> tuple:
    info = info or RequestInfo()
    return (customer_id, mailbox_id, message_id, greeting_id, action, info.actor_user_id,
            source, info.ip_address, info.user_agent,
            json.dumps(detail, separators=(",", ":"), default=str) if detail is not None else None)


async def write_audit(conn: Any, *, action: str, source: str, customer_id: int | None = None,
                      mailbox_id: int | None = None, message_id: int | None = None,
                      greeting_id: int | None = None, info: RequestInfo | None = None,
                      detail: dict | None = None) -> None:
    """INSERT one audit row on ``conn`` (use the caller's transaction so the
    audited change and its audit row commit together). Raises on failure."""
    await conn.execute(
        f"INSERT INTO voicemail_access_log ({_INSERT_COLUMNS}) VALUES ({_INSERT_VALUES})",
        *_params(action=action, source=source, customer_id=customer_id, mailbox_id=mailbox_id,
                 message_id=message_id, greeting_id=greeting_id, info=info, detail=detail))


async def write_audit_once_per_token(conn: Any, *, action: str, jti: str, customer_id: int,
                                     mailbox_id: int | None = None, message_id: int | None = None,
                                     greeting_id: int | None = None,
                                     info: RequestInfo | None = None,
                                     detail: dict | None = None) -> bool:
    """Write a play/download/greeting_play row unless one already exists for
    this token (``jti``) — in ANY worker process (unique partial index).
    Returns True when this call inserted the row. Raises on DB failure."""
    if action not in ONCE_PER_TOKEN_ACTIONS:
        raise ValueError(f"{action!r} is not a once-per-token action")
    payload = dict(detail or {})
    payload["jti"] = jti
    row = await conn.fetchrow(
        f"INSERT INTO voicemail_access_log ({_INSERT_COLUMNS}) VALUES ({_INSERT_VALUES}) "
        "ON CONFLICT ((detail->>'jti')) WHERE action IN ('play', 'download', 'greeting_play') "
        "DO NOTHING RETURNING id",
        *_params(action=action, source="ui", customer_id=customer_id, mailbox_id=mailbox_id,
                 message_id=message_id, greeting_id=greeting_id, info=info, detail=payload))
    return row is not None
