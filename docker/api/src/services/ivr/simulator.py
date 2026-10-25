"""IVR simulator: walk a compiled plan for a caller, a time and key presses.

Pure (no DB, no clock — ``at`` is passed in). Returns a "what the caller
hears" transcript (contract §8.2 ``SimStep`` = ``{node_id, kind, says, note}``)
and the outcome, following the runtime semantics of contract §3:

  * menu: play the prompts, wait for one key. No key -> no-input prompts and
    retry; a key that is not an option -> invalid prompts and retry; after
    ``retries`` re-prompts the call takes on_noinput / on_nomatch by the LAST
    failure type. Keys are consumed from ``digits`` in order; when they run
    out the caller is treated as pressing nothing.
  * hours: the local date (in the block's time zone) on a closed date ->
    closed; else open when the local minute falls in one of that weekday's
    [start, end) ranges. Uses zoneinfo, so DST is exact.
  * caller: anonymous (no number) matches only mode ``anonymous``; ``prefix``
    = starts with any value; ``equals`` = equals any value.
  * transfer / voicemail end the walk (the simulator assumes the transfer is
    answered; the note names the no-answer exit). ``None`` = hang up.
  * the plan's ``max_steps`` (node entries) bounds every walk -> ``limit``.

Schedule/caller matching is the port of the unified branch's
``routers/ivr.py`` ``_schedule_matches`` / ``_caller_matches`` (zoneinfo),
restricted to the plan's pinned shape (same-day [start, end) ranges, no
overnight windows — the compiler splits nothing, the builder never emits one).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping, Optional
from zoneinfo import ZoneInfo

from utils.phone import normalize_e164

DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
OUTCOMES = ("transfer", "voicemail", "hangup", "limit")
_ANONYMOUS = {"", "anonymous", "restricted", "private", "unknown", "unavailable"}
#: Transcript rows are bounded too (a menu retry adds rows without a node entry).
MAX_TRANSCRIPT_STEPS = 400


def pretty_number(e164: str) -> str:
    """+17744045256 -> '+1 774-404-5256' (NANP); anything else unchanged."""
    if isinstance(e164, str) and len(e164) == 12 and e164.startswith("+1") and e164[1:].isdigit():
        return f"+1 {e164[2:5]}-{e164[5:8]}-{e164[8:]}"
    return e164


def caller_is_anonymous(caller: Optional[str]) -> bool:
    return caller is None or caller.strip().lower() in _ANONYMOUS


def _canonical_caller(caller: str) -> str:
    try:
        return normalize_e164(caller)
    except ValueError:
        return caller.strip()


def caller_matches(node: Mapping[str, Any], caller: Optional[str]) -> bool:
    """A plan ``caller`` node against the caller number (see module doc)."""
    mode = node.get("mode")
    if caller_is_anonymous(caller):
        return mode == "anonymous"
    if mode == "anonymous":
        return False
    num = _canonical_caller(caller)
    values = node.get("values") or []
    if mode == "prefix":
        return any(num.startswith(v) for v in values)
    if mode == "equals":
        return num in values
    return False


def hours_state(node: Mapping[str, Any], at: datetime) -> tuple[bool, str]:
    """(open?, reason) for a plan ``hours`` node at the instant ``at``."""
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    local = at.astimezone(ZoneInfo(node["tz"]))
    stamp = local.strftime("%a %Y-%m-%d %H:%M %Z")
    if local.date().isoformat() in (node.get("closed_dates") or []):
        return False, f"{stamp}: a closed date"
    minute = local.hour * 60 + local.minute
    for start, end in (node.get("weekly") or {}).get(DAYS[local.weekday()], []):
        if start <= minute < end:
            return True, f"{stamp}: open"
    return False, f"{stamp}: outside open hours"


#: How a transfer to one of the customer's own numbers is described.
OWN_TARGET_WORDS: dict[str, str] = {
    "rcf": "your call forwarding number",
    "voicemail": "your voicemail box",
    "ivr": "your IVR",
    "trunk": "your SIP trunk number",
}

#: Customer-facing name of each block type (the builder's palette labels),
#: used when a block has no name of its own.
BLOCK_TYPE_NAMES: dict[str, str] = {
    "entry": "Start", "play": "Play message", "menu": "Menu", "schedule": "Business hours",
    "condition": "Caller check", "dial": "Transfer", "voicemail": "Voicemail",
    "goto": "Go to", "hangup": "Hang up",
}


def block_names_from_graph(graph: Mapping[str, Any]) -> dict[str, str]:
    """node id -> the block's display name (its label, else its type's name)."""
    out: dict[str, str] = {}
    for n in (graph or {}).get("nodes") or []:
        if not isinstance(n, Mapping) or not isinstance(n.get("id"), str):
            continue
        data = n.get("data") if isinstance(n.get("data"), Mapping) else {}
        label = data.get("label")
        name = label.strip() if isinstance(label, str) and label.strip() else \
            BLOCK_TYPE_NAMES.get(n.get("type"), "the next block")
        out[n["id"]] = name[:100]
    return out


def simulate(plan: Mapping[str, Any], *, caller: Optional[str], at: datetime,
             digits: list[str] | tuple[str, ...] = (),
             prompt_names: Optional[Mapping[str, Mapping[str, list[str]]]] = None,
             block_names: Optional[Mapping[str, str]] = None) -> dict:
    """Walk ``plan``; return ``{"steps": [SimStep...], "outcome": str}``.

    ``block_names`` (node id -> the block's name in the draft graph) lets a
    note point at a block the customer recognises; the plan itself carries no
    names (no customer free text, contract §3)."""
    names = prompt_names or {}
    blocks = block_names or {}
    nodes: Mapping[str, Mapping[str, Any]] = plan.get("nodes", {})
    max_steps = int((plan.get("limits") or {}).get("max_steps", 200))
    keys = list(digits)
    steps: list[dict] = []

    def says(node_id: str, field: str, shas: list[str]) -> list[str]:
        listed = list((names.get(node_id) or {}).get(field) or [])
        out = []
        for i, _ in enumerate(shas):
            out.append(listed[i] if i < len(listed) else f"Message {i + 1}")
        return out

    def step(node_id: Optional[str], kind: str, said: list[str], note: str) -> None:
        if len(steps) < MAX_TRANSCRIPT_STEPS:
            steps.append({"node_id": node_id, "kind": kind, "says": said, "note": note})

    current: Optional[str] = plan.get("start")
    entries = 0
    while True:
        if current is None:
            step(None, "end", [], "The call ends.")
            return {"steps": steps, "outcome": "hangup"}
        node = nodes.get(current)
        if node is None:
            step(current, "end", [], "The call ends.")
            return {"steps": steps, "outcome": "hangup"}
        entries += 1
        if entries > max_steps:
            step(current, "limit", [], f"The call has gone through {max_steps} steps and is "
                 "ended with a goodbye.")
            return {"steps": steps, "outcome": "limit"}
        t = node["t"]

        if t == "play":
            step(current, "play", says(current, "prompts", node["prompts"]), "Plays a message.")
            current = node.get("next")

        elif t == "menu":
            options = node.get("digits") or {}
            retries = int(node.get("retries", 0))
            wait_s = int(node.get("timeout_ms", 5000)) // 1000
            attempt, last, chosen = 0, "noinput", None
            while True:
                said = says(current, "prompts", node["prompts"])
                key = keys.pop(0) if keys else None
                if key is None:
                    last = "noinput"
                    note = f"No key pressed within {wait_s} s."
                    said += says(current, "noinput_prompts", node.get("noinput_prompts") or [])
                elif key in options:
                    chosen = key
                    step(current, "menu", said, f"The caller presses {key}.")
                    break
                else:
                    last = "nomatch"
                    note = f"The caller presses {key}, which isn't an option."
                    said += says(current, "invalid_prompts", node.get("invalid_prompts") or [])
                attempt += 1
                if attempt > retries:
                    exit_name = "no input" if last == "noinput" else "invalid key"
                    step(current, "menu", said, f"{note} No tries left — takes the "
                         f"{exit_name} exit.")
                    break
                step(current, "menu", said, f"{note} Tries again.")
            if chosen is not None:
                current = options[chosen]
            else:
                current = node.get("on_noinput") if last == "noinput" else node.get("on_nomatch")

        elif t == "hours":
            is_open, reason = hours_state(node, at)
            step(current, "hours", [], f"{reason} — takes the {'Open' if is_open else 'Closed'}"
                 " exit.")
            current = node.get("open") if is_open else node.get("closed")

        elif t == "caller":
            hit = caller_matches(node, caller)
            who = "anonymous" if caller_is_anonymous(caller) else pretty_number(
                _canonical_caller(caller))
            step(current, "caller", [], f"Caller {who} {'matches' if hit else 'does not match'}.")
            current = node.get("match") if hit else node.get("nomatch")

        elif t == "transfer":
            dest = node["dest"]
            number = dest.get("e164") or dest.get("did")
            where = (OWN_TARGET_WORDS.get(dest.get("product"), "one of your numbers")
                     if dest["kind"] == "own" else "an outside number")
            shown = "the caller's number" if node.get("pass_caller_id") else "the IVR number"
            fallback = node.get("on_noanswer")
            fallback_name = blocks.get(fallback) if fallback else None
            tail = (f" If nobody answers within {node.get('ring_timeout')} s the call continues "
                    + (f"at \u201c{fallback_name}\u201d." if fallback_name
                       else "on the No answer route.") if fallback else
                    f" If nobody answers within {node.get('ring_timeout')} s the call ends.")
            step(current, "transfer", [], f"Transfers to {pretty_number(number)} ({where}), "
                 f"showing {shown}.{tail}")
            return {"steps": steps, "outcome": "transfer"}

        elif t == "voicemail":
            step(current, "voicemail", [], f"Sends the caller to the voicemail box "
                 f"{pretty_number(node['did'])}.")
            return {"steps": steps, "outcome": "voicemail"}

        elif t == "hangup":
            step(current, "hangup", says(current, "prompts", node.get("prompts") or []),
                 "Hangs up.")
            return {"steps": steps, "outcome": "hangup"}

        else:  # a plan from a newer compiler — never guess
            step(current, "end", [], "The call ends.")
            return {"steps": steps, "outcome": "hangup"}
