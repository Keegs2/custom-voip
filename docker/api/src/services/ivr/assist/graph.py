"""Draft graph (docs/IVR_INTERFACES.md §2) <-> alias graph (docs/IVR_ASSIST_INTERFACES.md §4).

The alias graph is the builder's draft without anything a model must not see
or does not need: no positions / viewport / edge ids / ``data`` wrapper, prompt
ids as ``P<n>`` (existing) or ``NP<n>`` (new), numbers as ``D<n>`` / ``N<n>``,
weekly ranges as ``{start, end}`` objects.

  * ``to_alias_graph`` (draft -> alias, the request's ``base``) keeps only
    what the alias schema can carry and what is valid: an unknown block type,
    a deleted prompt, a number that is not the customer's, a stale menu exit
    are dropped (the compiler reports them on the draft itself).
  * ``from_alias_graph`` (alias -> draft, a proposal) keeps the model's node
    ids (so nodes that already exist in ``base`` keep theirs and the builder
    can show what changed), gives every edge a new ``e_<nanoid>`` id, puts
    every node at ``{x: 0, y: 0}`` (the builder lays it out), and maps new
    messages to the NEGATIVE placeholder ids ``-1 … -20`` (``new_prompts``
    order). A reference that resolves to nothing is kept as something the
    compiler REJECTS (prompt id 0, no transfer target, no mailbox) so the
    repair round sees it — never silently dropped.

Pure: no DB.
"""
from __future__ import annotations

import re
import secrets
from datetime import date
from typing import Any, Mapping, Optional

from services.ivr import compiler
from services.ivr.assist import config
from services.ivr.assist.aliases import AliasBook, clip
from utils.phone import normalize_e164

ALIAS_TYPES = ("entry", "play", "menu", "schedule", "condition", "dial", "voicemail",
               "goto", "hangup")
_HANDLE_RE = re.compile(r"^(next|d:[0-9*#]|noInput|noMatch|open|closed|match|noAnswer)$")
_CLOCK_RE = re.compile(r"^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$")
_DATE_RE = re.compile(r"^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$")
_PREFIX_RE = re.compile(r"^\+1[0-9]{1,9}$")
_DIGITS = frozenset("0123456789*#")
_NANOID = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-"
MAX_PROMPTS_PER_LIST = 10
MAX_RANGES_PER_DAY = 4
MAX_CLOSED_DATES = 100
MAX_CALLER_VALUES = 50
MAX_LABEL = 60
#: A prompt reference that resolves to nothing (never a real or placeholder id).
UNKNOWN_PROMPT_ID = 0


class GraphTooLarge(Exception):
    """The base graph has more blocks / connections than the assistant takes."""


def new_edge_id() -> str:
    return "e_" + "".join(secrets.choice(_NANOID) for _ in range(16))


def _int(value: Any, lo: int, hi: int) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if lo <= value <= hi else None


def _config(node: Mapping[str, Any]) -> Mapping[str, Any]:
    data = node.get("data")
    if isinstance(data, Mapping) and isinstance(data.get("config"), Mapping):
        return data["config"]
    return {}


def _prompt_id(item: Any) -> Optional[int]:
    if isinstance(item, int) and not isinstance(item, bool):
        return item
    if isinstance(item, str):
        s = item.strip()
        if s.isascii() and (s.isdigit() or (s.startswith("-") and s[1:].isdigit())):
            return int(s)
    return None


# ---------------------------------------------------------------------------
# draft -> alias (the request's base)
# ---------------------------------------------------------------------------
def to_alias_graph(draft: Any, book: AliasBook, *,
                   placeholders: Optional[Mapping[int, str]] = None) -> Optional[dict]:
    """The alias form of ``draft`` — or None when there is nothing to change
    (no draft, or just the seeded Start block). Raises GraphTooLarge."""
    if not isinstance(draft, Mapping):
        return None
    ph = placeholders or {}
    nodes_in = draft.get("nodes") if isinstance(draft.get("nodes"), list) else []
    edges_in = draft.get("edges") if isinstance(draft.get("edges"), list) else []
    kept: dict[str, Mapping[str, Any]] = {}
    nodes: list[dict] = []
    for node in nodes_in:
        if not isinstance(node, Mapping):
            continue
        node_id, t = node.get("id"), node.get("type")
        if not isinstance(node_id, str) or not compiler.ID_RE.match(node_id) \
                or node_id in kept or t not in ALIAS_TYPES:
            continue
        kept[node_id] = node
        out: dict[str, Any] = {"id": node_id, "type": t}
        data = node.get("data") if isinstance(node.get("data"), Mapping) else {}
        label = data.get("label")
        if isinstance(label, str):
            clean = clip(" ".join(book.alias_text(label).split()), MAX_LABEL)
            if clean:
                out["label"] = clean
        out["config"] = _alias_config(t, _config(node), book, ph)
        nodes.append(out)
    if len(nodes) > config.MAX_NODES:
        raise GraphTooLarge(f"{len(nodes)} blocks")
    entry_ids = {i for i, n in kept.items() if n.get("type") == "entry"}
    edges: list[dict] = []
    used: set[tuple[str, str]] = set()
    for edge in edges_in:
        if not isinstance(edge, Mapping):
            continue
        src, tgt, handle = edge.get("source"), edge.get("target"), edge.get("sourceHandle")
        if src not in kept or tgt not in kept or tgt in entry_ids:
            continue
        valid = compiler.out_handles(kept[src])
        if handle is None and len(valid) == 1:
            handle = valid[0]
        if not isinstance(handle, str) or handle not in valid or not _HANDLE_RE.match(handle) \
                or (src, handle) in used:
            continue
        used.add((src, handle))
        edges.append({"source": src, "sourceHandle": handle, "target": tgt})
    if len(edges) > config.MAX_EDGES:
        raise GraphTooLarge(f"{len(edges)} connections")
    if len(nodes) == 1 and nodes[0]["type"] == "entry" and not edges:
        return None
    if not nodes:
        return None
    return {"nodes": nodes, "edges": edges}


def _alias_prompts(raw: Any, book: AliasBook, ph: Mapping[int, str]) -> Optional[list[str]]:
    if not isinstance(raw, list):
        return None
    out: list[str] = []
    for item in raw:
        pid = _prompt_id(item)
        if pid is None:
            continue
        ref = book.p_alias(pid) if pid > 0 else ph.get(pid)
        if ref is not None:
            out.append(ref)
    return out[:MAX_PROMPTS_PER_LIST] or None


def _alias_config(t: str, cfg: Mapping[str, Any], book: AliasBook,
                  ph: Mapping[int, str]) -> dict:
    out: dict[str, Any] = {}

    def prompts(key: str) -> None:
        refs = _alias_prompts(cfg.get(key), book, ph)
        if refs:
            out[key] = refs

    if t in ("play", "hangup"):
        prompts("prompts")
    elif t == "menu":
        prompts("prompts")
        raw = cfg.get("digits")
        if isinstance(raw, list):
            digits: list[str] = []
            for d in raw:
                if isinstance(d, str) and d in _DIGITS and d not in digits:
                    digits.append(d)
            if digits:
                out["digits"] = digits[:12]
        timeout = _int(cfg.get("timeoutSec"), 1, 30)
        if timeout is not None:
            out["timeoutSec"] = timeout
        retries = _int(cfg.get("retries"), 0, 5)
        if retries is not None:
            out["retries"] = retries
        prompts("invalidPrompts")
        prompts("noInputPrompts")
    elif t == "schedule":
        if cfg.get("tz") in compiler.TIMEZONES:
            out["tz"] = cfg["tz"]
        weekly = cfg.get("weekly")
        if isinstance(weekly, Mapping):
            days: dict[str, list[dict]] = {}
            for day in compiler.DAYS:
                ranges = weekly.get(day)
                if not isinstance(ranges, list):
                    continue
                spans = []
                for rng in ranges:
                    if isinstance(rng, (list, tuple)) and len(rng) == 2 \
                            and all(isinstance(x, str) and _CLOCK_RE.match(x) for x in rng):
                        spans.append({"start": rng[0], "end": rng[1]})
                days[day] = spans[:MAX_RANGES_PER_DAY]
            out["weekly"] = days
        closed = cfg.get("closedDates")
        if isinstance(closed, list):
            dates: list[str] = []
            for d in closed:
                if isinstance(d, str) and _DATE_RE.match(d) and d not in dates:
                    try:
                        date.fromisoformat(d)
                    except ValueError:
                        continue
                    dates.append(d)
            if dates:
                out["closedDates"] = sorted(dates)[:MAX_CLOSED_DATES]
    elif t == "condition":
        mode = cfg.get("mode")
        if mode in compiler.CONDITION_MODES:
            out["mode"] = mode
        raw = cfg.get("values")
        if mode in ("prefix", "equals") and isinstance(raw, list):
            values: list[str] = []
            for v in raw:
                ref = _alias_condition_value(mode, v, book)
                if ref is not None and ref not in values:
                    values.append(ref)
            if values:
                out["values"] = values[:MAX_CALLER_VALUES]
    elif t == "dial":
        target = _alias_target(cfg.get("target"), book)
        if target is not None:
            out["target"] = target
        if isinstance(cfg.get("passCallerId"), bool):
            out["passCallerId"] = cfg["passCallerId"]
        ring = _int(cfg.get("ringTimeoutSec"), 5, 120)
        if ring is not None:
            out["ringTimeoutSec"] = ring
    elif t == "voicemail":
        did = cfg.get("did")
        if isinstance(did, str):
            try:
                dest = book.own(normalize_e164(did))
            except ValueError:
                dest = None
            if dest is not None and dest.product == "voicemail":
                out["mailbox"] = dest.alias
    elif t == "goto":
        target = cfg.get("targetNodeId")
        if isinstance(target, str) and compiler.ID_RE.match(target):
            out["targetNodeId"] = target
    return out


def _alias_condition_value(mode: str, value: Any, book: AliasBook) -> Optional[str]:
    if not isinstance(value, str):
        return None
    if mode == "prefix":
        s = re.sub(r"[\s().-]", "", value)
        # A +1 prefix shorter than a full number; anything longer IS a number
        # (and never leaves CRAG), anything else is not representable.
        return s if _PREFIX_RE.match(s) else None
    try:
        e164 = normalize_e164(value)
    except ValueError:
        return None
    return book.n_alias(e164, allow_own=True)


def _alias_target(target: Any, book: AliasBook) -> Optional[dict]:
    if not isinstance(target, Mapping):
        return None
    kind = target.get("kind")
    raw = target.get("did") if kind == "own" else target.get("number") if kind == "external" \
        else None
    if not isinstance(raw, str):
        return None
    try:
        e164 = normalize_e164(raw)
    except ValueError:
        return None
    if kind == "own":
        dest = book.own(e164)
        return {"kind": "own", "ref": dest.alias} if dest is not None else None
    n = book.n_alias(e164)
    return {"kind": "external", "ref": n} if n is not None else None


# ---------------------------------------------------------------------------
# alias -> draft (a proposal)
# ---------------------------------------------------------------------------
def placeholder_ids(new_prompts: list[Mapping[str, Any]]) -> dict[str, int]:
    """``NP`` key -> placeholder prompt id: -1, -2, … in ``new_prompts`` order."""
    out: dict[str, int] = {}
    for np in new_prompts:
        key = np.get("key")
        if isinstance(key, str) and key not in out and len(out) < config.MAX_NEW_PROMPTS:
            out[key] = -(len(out) + 1)          # a repeated key keeps its first id
    return out


def from_alias_graph(graph: Mapping[str, Any], book: AliasBook, np_ids: Mapping[str, int],
                     np_names: Optional[Mapping[str, str]] = None) -> dict:
    """The §2 draft graph of a (schema-valid) alias graph."""
    nodes: list[dict] = []
    for node in graph.get("nodes") or []:
        data: dict[str, Any] = {}
        label = node.get("label")
        if isinstance(label, str) and label.strip():
            data["label"] = clip(book.render(label, np_names), 100)
        data["config"] = _draft_config(node["type"], node.get("config") or {}, book, np_ids)
        nodes.append({"id": node["id"], "type": node["type"], "position": {"x": 0, "y": 0},
                      "data": data})
    edges = [{"id": new_edge_id(), "source": e["source"], "sourceHandle": e["sourceHandle"],
              "target": e["target"]} for e in graph.get("edges") or []]
    return {"schemaVersion": compiler.GRAPH_SCHEMA_VERSION, "nodes": nodes, "edges": edges}


def _draft_prompts(refs: Any, book: AliasBook, np_ids: Mapping[str, int]) -> list[int]:
    out: list[int] = []
    for ref in refs if isinstance(refs, list) else []:
        if isinstance(ref, str) and ref.startswith("NP"):
            out.append(np_ids.get(ref, UNKNOWN_PROMPT_ID))
        elif isinstance(ref, str):
            p = book.prompt(ref)
            out.append(p.id if p is not None else UNKNOWN_PROMPT_ID)
    return out


def _draft_config(t: str, cfg: Mapping[str, Any], book: AliasBook,
                  np_ids: Mapping[str, int]) -> dict:
    out: dict[str, Any] = {}
    for key in ("prompts", "invalidPrompts", "noInputPrompts"):
        if key in cfg:
            out[key] = _draft_prompts(cfg[key], book, np_ids)
    if t == "menu":
        for key in ("digits", "timeoutSec", "retries"):
            if key in cfg:
                out[key] = cfg[key]
    elif t == "schedule":
        if "tz" in cfg:
            out["tz"] = cfg["tz"]
        weekly = cfg.get("weekly") or {}
        out["weekly"] = {day: [[r["start"], r["end"]] for r in weekly.get(day) or []]
                         for day in compiler.DAYS}
        if "closedDates" in cfg:
            out["closedDates"] = list(cfg["closedDates"])
    elif t == "condition":
        if "mode" in cfg:
            out["mode"] = cfg["mode"]
        values: list[str] = []
        for v in cfg.get("values") or []:
            if v.startswith("N"):
                number = book.external_number(v)
                if number is not None:
                    values.append(number)
            else:
                values.append(v)
        out["values"] = values
    elif t == "dial":
        target = cfg.get("target")
        if isinstance(target, Mapping):
            ref = target.get("ref", "")
            if ref.startswith("D"):
                dest = book.destination(ref)
                if dest is not None:
                    out["target"] = {"kind": "own", "did": dest.did}
            else:
                number = book.external_number(ref)
                if number is not None:
                    out["target"] = {"kind": "external", "number": number}
        for key in ("passCallerId", "ringTimeoutSec"):
            if key in cfg:
                out[key] = cfg[key]
    elif t == "voicemail":
        dest = book.destination(cfg.get("mailbox", ""))
        if dest is not None:
            out["did"] = dest.did
    elif t == "goto":
        if "targetNodeId" in cfg:
            out["targetNodeId"] = cfg["targetNodeId"]
    return out
