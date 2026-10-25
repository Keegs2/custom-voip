"""IVR compiler: draft graph (contract §2) -> plan (contract §3).

Pure (no DB, no FastAPI, no clock). The ONLY writer of the executable plan:
FreeSWITCH trusts nothing else, and the browser's own compile step is never
stored (decision D2). ``compile_flow`` validates and compiles in one pass and
returns every problem as an ``Issue`` keyed by block (``node_id``) and exit
(``handle``) with a customer-readable message.

Fixes over the unified branch's ``flow/compile/ivr.ts`` (review 2026-10-25):
  * prompts play in the order the customer listed them (unified reversed the
    menu prompt run);
  * loops are kept — a Go-to compiles to a direct pointer at its target, so
    "press 9 to repeat" works (unified silently dropped every back edge);
  * an edge whose handle no longer exists (a deleted menu digit, or any
    handle the block type does not have) is PRUNED with a warning — it can
    never route (unified compiled it, so a deleted digit still routed);
  * Start is mandatory and unique, and no edge may point at it;
  * transfer targets are validated by the dial policy (services/ivr/policy):
    own numbers against the customer's CURRENT numbers, outside numbers by
    the US-only rule (D4); caller ID is a boolean only (D5);
  * a Play / Menu needs at least one prompt, and every prompt id must be one
    of the customer's live prompts.

Plan rules (contract §3): node ids ``^[A-Za-z0-9_-]{1,40}$``; digits
``^[0-9*#]$``; every prompt is a sha256 of stored audio; every pointer is a
plan node id or ``None`` (= hang up); NO customer free text anywhere (labels,
names and TTS text stay in the graph). Only blocks reachable from Start are
compiled; unreachable blocks are reported as warnings and left out.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Iterable, Mapping, Optional

from services.ivr import limits, policy
from utils.phone import normalize_e164

COMPILER_VERSION = "ivr-1"
PLAN_VERSION = 1
GRAPH_SCHEMA_VERSION = 1

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$", re.ASCII)
DIGIT_RE = re.compile(r"^[0-9*#]$", re.ASCII)
SHA_RE = re.compile(r"^[0-9a-f]{64}$", re.ASCII)
_HHMM_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$|^24:00$", re.ASCII)
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$", re.ASCII)
_PREFIX_RE = re.compile(r"^\+\d{1,15}$", re.ASCII)

NODE_TYPES = ("entry", "play", "menu", "schedule", "condition", "dial", "voicemail",
              "goto", "hangup")
DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")

#: Pinned timezone list (contract §2) — P2's lib/schedule.lua carries all of them.
TIMEZONES = ("America/New_York", "America/Detroit", "America/Chicago", "America/Denver",
             "America/Phoenix", "America/Los_Angeles", "America/Anchorage",
             "Pacific/Honolulu", "America/Puerto_Rico")

MAX_RANGES_PER_DAY = 4
MAX_CLOSED_DATES = 366
MAX_CALLER_VALUES = 50
MAX_MENU_DIGITS = 12
CONDITION_MODES = ("prefix", "equals", "anonymous")


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Issue:
    """One validation finding (contract §8.2 ``Issue``)."""
    code: str
    message: str
    node_id: Optional[str] = None
    handle: Optional[str] = None

    def as_dict(self) -> dict:
        out: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.node_id is not None:
            out["node_id"] = self.node_id
        if self.handle is not None:
            out["handle"] = self.handle
        return out


@dataclass(frozen=True)
class PromptRef:
    """A LIVE (not deleted) prompt of the flow's customer."""
    sha256: str
    name: str


@dataclass(frozen=True)
class OwnNumber:
    """One of the customer's current numbers (services/customer_numbers)."""
    did: str
    product: str
    name: Optional[str] = None
    enabled: bool = True


@dataclass
class CompileContext:
    customer_id: int
    flow_id: int
    version: int
    prompts: Mapping[int, PromptRef] = field(default_factory=dict)
    numbers: Mapping[str, OwnNumber] = field(default_factory=dict)
    #: The IVR numbers bound to THIS flow (a transfer to one of them loops).
    self_dids: frozenset[str] = frozenset()


@dataclass
class CompileResult:
    plan: Optional[dict]
    errors: list[Issue]
    warnings: list[Issue]
    #: node_id -> plan prompt field -> prompt names (for the simulator; never
    #: written into the plan).
    prompt_names: dict[str, dict[str, list[str]]] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.errors and self.plan is not None


# ---------------------------------------------------------------------------
# Graph shape (also used on every draft write)
# ---------------------------------------------------------------------------
def default_graph() -> dict:
    """The draft a new flow starts with: just the Start block."""
    return {
        "schemaVersion": GRAPH_SCHEMA_VERSION,
        "nodes": [{"id": "n_start", "type": "entry", "position": {"x": 0, "y": 0},
                   "data": {"label": "Start", "config": {}}}],
        "edges": [],
    }


def check_graph_shape(graph: Any) -> list[Issue]:
    """Structural problems that make a graph unusable (also refused on save).

    Content problems (prompts, numbers, wiring) are only reported by
    ``compile_flow`` — a draft may be saved half-built, but never without its
    one Start block or with malformed ids.
    """
    if not isinstance(graph, dict):
        return [Issue("graph_invalid", "The call flow could not be read.")]
    issues: list[Issue] = []
    if graph.get("schemaVersion") != GRAPH_SCHEMA_VERSION:
        issues.append(Issue("graph_version", "This call flow was made by a newer or older "
                                             "builder. Reload the page and try again."))
    nodes, edges = graph.get("nodes"), graph.get("edges")
    if not isinstance(nodes, list) or not isinstance(edges, list):
        issues.append(Issue("graph_invalid", "The call flow could not be read."))
        return issues
    if len(nodes) > limits.MAX_NODES:
        issues.append(Issue("too_many_blocks",
                            f"A call flow can have at most {limits.MAX_NODES} blocks."))
    if len(edges) > limits.MAX_EDGES:
        issues.append(Issue("too_many_connections",
                            f"A call flow can have at most {limits.MAX_EDGES} connections."))
    seen: set[str] = set()
    entries: list[str] = []
    for node in nodes:
        if not isinstance(node, dict):
            issues.append(Issue("graph_invalid", "The call flow could not be read."))
            continue
        node_id = node.get("id")
        if not isinstance(node_id, str) or not ID_RE.match(node_id):
            issues.append(Issue("block_id_invalid", "A block has an invalid id."))
            continue
        if node_id in seen:
            issues.append(Issue("block_id_duplicate", "Two blocks share the same id.", node_id))
            continue
        seen.add(node_id)
        if not isinstance(node.get("type"), str):
            issues.append(Issue("block_type_invalid", "This block has no type.", node_id))
        elif node["type"] == "entry":
            entries.append(node_id)
    if not entries:
        issues.append(Issue("start_missing", "Every call flow needs its Start block."))
    for extra in entries[1:]:
        issues.append(Issue("start_duplicate", "A call flow can only have one Start block.",
                            extra))
    return issues


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _config(node: dict) -> dict:
    data = node.get("data")
    if isinstance(data, dict) and isinstance(data.get("config"), dict):
        return data["config"]
    return {}


def _int_in(value: Any, lo: int, hi: int) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if lo <= value <= hi else None


def _menu_digits(node: dict) -> list[str]:
    """The menu's declared digits, valid ones only (validation reports the rest)."""
    raw = _config(node).get("digits")
    out: list[str] = []
    if isinstance(raw, list):
        for d in raw:
            if isinstance(d, str) and DIGIT_RE.match(d) and d not in out:
                out.append(d)
    return out


def out_handles(node: dict) -> tuple[str, ...]:
    """The exits a block type has, in a stable order (also the BFS order)."""
    t = node.get("type")
    if t in ("entry", "play"):
        return ("next",)
    if t == "menu":
        return tuple(f"d:{d}" for d in _menu_digits(node)) + ("noInput", "noMatch")
    if t == "schedule":
        return ("open", "closed")
    if t == "condition":
        return ("match", "noMatch")
    if t == "dial":
        return ("noAnswer",)
    return ()


def _minutes(hhmm: str) -> int:
    if hhmm == "24:00":
        return 1440
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def _merge_ranges(ranges: Iterable[tuple[int, int]]) -> list[list[int]]:
    merged: list[list[int]] = []
    for s, e in sorted(ranges):
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return merged


def _strongly_connected(adj: Mapping[str, list[str]]) -> list[list[str]]:
    """Tarjan's SCCs, iterative (plans are <= 200 nodes; deterministic order)."""
    index: dict[str, int] = {}
    low: dict[str, int] = {}
    on_stack: set[str] = set()
    stack: list[str] = []
    out: list[list[str]] = []
    counter = 0
    for root in adj:
        if root in index:
            continue
        work: list[tuple[str, int]] = [(root, 0)]
        while work:
            v, i = work.pop()
            if i == 0:
                index[v] = low[v] = counter
                counter += 1
                stack.append(v)
                on_stack.add(v)
            succ = adj.get(v, [])
            if i < len(succ):
                work.append((v, i + 1))
                w = succ[i]
                if w not in index:
                    work.append((w, 0))
                elif w in on_stack:
                    low[v] = min(low[v], index[w])
                continue
            if low[v] == index[v]:
                comp: list[str] = []
                while True:
                    w = stack.pop()
                    on_stack.discard(w)
                    comp.append(w)
                    if w == v:
                        break
                out.append(comp)
            if work:
                parent = work[-1][0]
                low[parent] = min(low[parent], low[v])
    return out


# ---------------------------------------------------------------------------
# The compiler
# ---------------------------------------------------------------------------
class _Compiler:
    def __init__(self, graph: dict, ctx: CompileContext):
        self.graph = graph
        self.ctx = ctx
        self.errors: list[Issue] = []
        self.warnings: list[Issue] = []
        self.nodes: dict[str, dict] = {n["id"]: n for n in graph["nodes"]}
        self.entry_id = next(n["id"] for n in graph["nodes"] if n["type"] == "entry")
        self.out: dict[tuple[str, str], str] = {}
        self.prompt_names: dict[str, dict[str, list[str]]] = {}
        self._goto_cache: dict[str, Optional[str]] = {}

    # -- issues -------------------------------------------------------------
    def err(self, code: str, message: str, node_id: str | None = None,
            handle: str | None = None) -> None:
        self.errors.append(Issue(code, message, node_id, handle))

    def warn(self, code: str, message: str, node_id: str | None = None,
             handle: str | None = None) -> None:
        self.warnings.append(Issue(code, message, node_id, handle))

    # -- edges ----------------------------------------------------------------
    def build_edges(self) -> None:
        for edge in self.graph["edges"]:
            if not isinstance(edge, dict):
                self.warn("connection_invalid", "A connection could not be read and was ignored.")
                continue
            src, tgt, handle = edge.get("source"), edge.get("target"), edge.get("sourceHandle")
            if not isinstance(src, str) or src not in self.nodes:
                self.warn("connection_dangling",
                          "A connection from a deleted block was ignored.")
                continue
            if not isinstance(tgt, str) or tgt not in self.nodes:
                self.warn("connection_dangling",
                          "A connection to a deleted block was ignored.", src,
                          handle if isinstance(handle, str) else None)
                continue
            valid = out_handles(self.nodes[src])
            if handle is None and len(valid) == 1:
                handle = valid[0]
            if not isinstance(handle, str) or handle not in valid:
                # e.g. a menu digit that was removed after it was wired.
                self.warn("connection_pruned",
                          "A connection from an exit this block no longer has was removed.",
                          src, handle if isinstance(handle, str) else None)
                continue
            if tgt == self.entry_id:
                self.err("connection_to_start", "Nothing can connect back into Start. "
                         "Use a Go to block to send callers back to a step.", src, handle)
                continue
            if (src, handle) in self.out:
                self.err("connection_duplicate",
                         "This exit is connected twice. Remove one of the connections.",
                         src, handle)
                continue
            self.out[(src, handle)] = tgt

    # -- goto resolution ----------------------------------------------------
    def resolve(self, node_id: Optional[str]) -> Optional[str]:
        """Follow Go to blocks to the real target (None = hang up)."""
        seen: list[str] = []
        current = node_id
        while current is not None:
            node = self.nodes.get(current)
            if node is None:
                return None
            if current == self.entry_id:
                current = self.out.get((self.entry_id, "next"))
                if current in seen:
                    return None
                continue
            if node.get("type") != "goto":
                return current
            if current in seen:
                return None  # reported once by validate_goto
            seen.append(current)
            target = _config(node).get("targetNodeId")
            current = target if isinstance(target, str) and target in self.nodes else None
        return None

    def pointer(self, node_id: str, handle: str) -> Optional[str]:
        return self.resolve(self.out.get((node_id, handle)))

    # -- reachability -------------------------------------------------------
    def reachable(self) -> list[str]:
        order: list[str] = []
        seen = {self.entry_id}
        queue = [self.entry_id]
        while queue:
            node_id = queue.pop(0)
            order.append(node_id)
            node = self.nodes[node_id]
            succ: list[str] = []
            for handle in out_handles(node):
                tgt = self.out.get((node_id, handle))
                if tgt is not None:
                    succ.append(tgt)
            if node.get("type") == "goto":
                target = _config(node).get("targetNodeId")
                if isinstance(target, str) and target in self.nodes:
                    succ.append(target)
            for s in succ:
                if s not in seen:
                    seen.add(s)
                    queue.append(s)
        return order

    # -- field validators ---------------------------------------------------
    def prompts(self, node_id: str, cfg: dict, key: str, plan_field: str, *,
                required: bool) -> list[str]:
        raw = cfg.get(key)
        if raw is None:
            raw = []
        if not isinstance(raw, list):
            self.err("prompts_invalid", "The messages for this block could not be read.",
                     node_id)
            return []
        if not raw and required:
            self.err("prompts_required", "Choose at least one message to play.", node_id)
            return []
        if len(raw) > limits.MAX_PROMPTS_PER_BLOCK:
            self.err("prompts_too_many",
                     f"A block can play at most {limits.MAX_PROMPTS_PER_BLOCK} messages.",
                     node_id)
            return []
        shas: list[str] = []
        names: list[str] = []
        for item in raw:
            pid = item if isinstance(item, int) and not isinstance(item, bool) else None
            if pid is None and isinstance(item, str) and item.isascii() and item.isdigit():
                pid = int(item)
            ref = self.ctx.prompts.get(pid) if pid is not None else None
            if ref is None:
                self.err("prompt_missing",
                         "A message used here was deleted or can't be found. Choose another.",
                         node_id)
                continue
            if not SHA_RE.match(ref.sha256):
                self.err("prompt_missing", "A message used here has no audio. Choose another.",
                         node_id)
                continue
            shas.append(ref.sha256)
            names.append(ref.name)
        self.prompt_names.setdefault(node_id, {})[plan_field] = names
        return shas

    def exit_or_warn(self, node_id: str, handle: str, message: str) -> Optional[str]:
        target = self.pointer(node_id, handle)
        if (node_id, handle) not in self.out:
            self.warn("exit_unconnected", message, node_id, handle)
        return target

    # -- per type -----------------------------------------------------------
    def compile_play(self, node_id: str, cfg: dict) -> dict:
        shas = self.prompts(node_id, cfg, "prompts", "prompts", required=True)
        nxt = self.exit_or_warn(node_id, "next", "The call ends after this message. "
                                "Connect it to the next step if that's not what you want.")
        return {"t": "play", "prompts": shas, "next": nxt}

    def compile_menu(self, node_id: str, node: dict, cfg: dict) -> dict:
        shas = self.prompts(node_id, cfg, "prompts", "prompts", required=True)
        raw_digits = cfg.get("digits")
        digits = _menu_digits(node)
        if not isinstance(raw_digits, list) or not raw_digits:
            self.err("menu_digits_required", "Choose at least one key callers can press.",
                     node_id)
        elif len(digits) != len(raw_digits):
            self.err("menu_digits_invalid",
                     "Menu keys must be 0-9, * or #, and each key can be used once.", node_id)
        elif len(digits) > MAX_MENU_DIGITS:
            self.err("menu_digits_invalid", f"A menu can have at most {MAX_MENU_DIGITS} keys.",
                     node_id)
        timeout = cfg.get("timeoutSec", 5)
        timeout_v = _int_in(timeout, 1, 30)
        if timeout_v is None:
            self.err("menu_timeout_invalid", "Wait time must be between 1 and 30 seconds.",
                     node_id)
            timeout_v = 5
        retries = cfg.get("retries", 2)
        retries_v = _int_in(retries, 0, 5)
        if retries_v is None:
            self.err("menu_retries_invalid", "Retries must be between 0 and 5.", node_id)
            retries_v = 2
        invalid = self.prompts(node_id, cfg, "invalidPrompts", "invalid_prompts",
                               required=False)
        noinput = self.prompts(node_id, cfg, "noInputPrompts", "noinput_prompts",
                               required=False)
        routes: dict[str, Optional[str]] = {}
        connected = 0
        for d in digits:
            handle = f"d:{d}"
            if (node_id, handle) in self.out:
                connected += 1
            else:
                self.warn("exit_unconnected",
                          f"Pressing {d} ends the call. Connect it to a step.", node_id, handle)
            routes[d] = self.pointer(node_id, handle)
        if digits and connected == 0:
            self.err("menu_unconnected", "Connect at least one menu key to a step.", node_id)
        on_noinput = self.exit_or_warn(node_id, "noInput",
                                       "If the caller presses nothing, the call ends.")
        on_nomatch = self.exit_or_warn(node_id, "noMatch",
                                       "If the caller presses a wrong key, the call ends.")
        return {"t": "menu", "prompts": shas, "digits": routes,
                "timeout_ms": timeout_v * 1000, "retries": retries_v,
                "invalid_prompts": invalid, "noinput_prompts": noinput,
                "on_noinput": on_noinput, "on_nomatch": on_nomatch}

    def compile_schedule(self, node_id: str, cfg: dict) -> dict:
        tz = cfg.get("tz")
        if tz not in TIMEZONES:
            self.err("schedule_timezone_invalid", "Choose a US time zone.", node_id)
            tz = TIMEZONES[0]
        weekly_raw = cfg.get("weekly")
        weekly: dict[str, list[list[int]]] = {d: [] for d in DAYS}
        bad_hours = False
        if not isinstance(weekly_raw, dict) or any(k not in DAYS for k in weekly_raw):
            bad_hours = True
        else:
            for day in DAYS:
                ranges = weekly_raw.get(day, [])
                if not isinstance(ranges, list) or len(ranges) > MAX_RANGES_PER_DAY:
                    bad_hours = True
                    continue
                spans: list[tuple[int, int]] = []
                for rng in ranges:
                    if (not isinstance(rng, list) or len(rng) != 2
                            or not all(isinstance(x, str) and _HHMM_RE.match(x) for x in rng)
                            or rng[0] == "24:00"):
                        bad_hours = True
                        continue
                    s, e = _minutes(rng[0]), _minutes(rng[1])
                    if s >= e:
                        bad_hours = True
                        continue
                    spans.append((s, e))
                weekly[day] = _merge_ranges(spans)
        if bad_hours:
            self.err("schedule_hours_invalid",
                     f"Opening hours must be up to {MAX_RANGES_PER_DAY} times per day, "
                     "each from HH:MM to a later HH:MM (use 24:00 for midnight).", node_id)
        closed_raw = cfg.get("closedDates", [])
        closed: list[str] = []
        if not isinstance(closed_raw, list) or len(closed_raw) > MAX_CLOSED_DATES:
            self.err("schedule_dates_invalid",
                     f"Closed dates must be a list of up to {MAX_CLOSED_DATES} dates.", node_id)
        else:
            for d in closed_raw:
                try:
                    if not isinstance(d, str) or not _DATE_RE.match(d):
                        raise ValueError
                    date.fromisoformat(d)
                except ValueError:
                    self.err("schedule_dates_invalid",
                             "Closed dates must be real dates (YYYY-MM-DD).", node_id)
                    continue
                if d not in closed:
                    closed.append(d)
            closed.sort()
        if not bad_hours and not any(weekly.values()):
            self.warn("schedule_never_open",
                      "These hours are never open, so callers always take the Closed exit.",
                      node_id)
        on_open = self.exit_or_warn(node_id, "open", "During open hours the call ends here.")
        on_closed = self.exit_or_warn(node_id, "closed",
                                      "Outside open hours the call ends here.")
        return {"t": "hours", "tz": tz, "weekly": weekly, "closed_dates": closed,
                "open": on_open, "closed": on_closed}

    def compile_condition(self, node_id: str, cfg: dict) -> dict:
        mode = cfg.get("mode")
        if mode not in CONDITION_MODES:
            self.err("caller_mode_invalid", "Choose how to check the caller.", node_id)
            mode = "prefix"
        raw = cfg.get("values", [])
        values: list[str] = []
        if not isinstance(raw, list):
            self.err("caller_values_invalid", "The caller numbers could not be read.", node_id)
            raw = []
        if mode == "anonymous":
            if raw:
                self.warn("caller_values_ignored",
                          "Numbers are ignored when checking for anonymous callers.", node_id)
        elif not raw:
            self.err("caller_values_required", "Add at least one number to check.", node_id)
        elif len(raw) > MAX_CALLER_VALUES:
            self.err("caller_values_invalid",
                     f"A caller check can have at most {MAX_CALLER_VALUES} numbers.", node_id)
        else:
            for v in raw:
                clean = None
                if isinstance(v, str):
                    if mode == "prefix":
                        s = re.sub(r"[\s().-]", "", v)
                        clean = s if _PREFIX_RE.match(s) else None
                    else:
                        try:
                            clean = normalize_e164(v)
                        except ValueError:
                            clean = None
                if clean is None:
                    self.err("caller_value_invalid",
                             "Numbers must start with + and the country code, like +1617"
                             if mode == "prefix" else
                             "Enter full phone numbers, like +1 617-555-0123.", node_id)
                    continue
                if clean not in values:
                    values.append(clean)
        on_match = self.exit_or_warn(node_id, "match",
                                     "When the caller matches, the call ends here.")
        on_nomatch = self.exit_or_warn(node_id, "noMatch",
                                       "When the caller doesn't match, the call ends here.")
        return {"t": "caller", "mode": mode, "values": values,
                "match": on_match, "nomatch": on_nomatch}

    def compile_dial(self, node_id: str, cfg: dict) -> dict:
        target = cfg.get("target")
        dest: dict[str, Any] = {"kind": "external", "e164": "+10000000000"}
        if not isinstance(target, dict) or target.get("kind") not in ("own", "external"):
            self.err("transfer_target_required",
                     "Choose where to transfer the call: one of your numbers or an outside "
                     "US number.", node_id)
        elif target["kind"] == "own":
            res = policy.check_own(target.get("did"),
                                   {d: n.product for d, n in self.ctx.numbers.items()},
                                   self.ctx.self_dids)
            if not res.ok:
                self.err(res.code, res.message, node_id)
            else:
                dest = {"kind": "own", "did": res.e164, "product": res.code}
                number = self.ctx.numbers.get(res.e164)
                if number is not None and not number.enabled:
                    self.warn("transfer_target_off",
                              "That number is turned off, so transferred callers will be "
                              "rejected until it is turned back on.", node_id)
        else:
            res = policy.check_external(target.get("number"))
            if not res.ok:
                self.err(res.code, res.message, node_id)
            else:
                dest = {"kind": "external", "e164": res.e164}
        pass_cid = cfg.get("passCallerId", True)
        if not isinstance(pass_cid, bool):
            self.err("transfer_caller_id_invalid",
                     "Choose whether to show the caller's number or the IVR number.", node_id)
            pass_cid = True
        ring = _int_in(cfg.get("ringTimeoutSec", 30), 5, 120)
        if ring is None:
            self.err("transfer_ring_invalid", "Ring time must be between 5 and 120 seconds.",
                     node_id)
            ring = 30
        on_noanswer = self.exit_or_warn(node_id, "noAnswer",
                                        "If nobody answers, the call ends.")
        return {"t": "transfer", "dest": dest, "pass_caller_id": pass_cid,
                "ring_timeout": ring, "on_noanswer": on_noanswer}

    def compile_voicemail(self, node_id: str, cfg: dict) -> dict:
        raw = cfg.get("did")
        did = None
        if isinstance(raw, str):
            try:
                did = normalize_e164(raw)
            except ValueError:
                did = None
        number = self.ctx.numbers.get(did) if did else None
        if number is None or number.product != "voicemail":
            self.err("voicemail_missing", "Choose one of your voicemail boxes.", node_id)
            return {"t": "voicemail", "did": did or "+10000000000"}
        if not number.enabled:
            self.warn("voicemail_off", "That voicemail box is turned off, so callers sent "
                      "there will be rejected until it is turned back on.", node_id)
        return {"t": "voicemail", "did": did}

    def compile_hangup(self, node_id: str, cfg: dict) -> dict:
        return {"t": "hangup",
                "prompts": self.prompts(node_id, cfg, "prompts", "prompts", required=False)}

    def validate_goto(self, node_id: str, cfg: dict) -> None:
        target = cfg.get("targetNodeId")
        if not isinstance(target, str) or target not in self.nodes:
            self.err("goto_target_missing", "Choose the block to go to.", node_id)
            return
        if target == node_id:
            self.err("goto_loop", "A Go to block can't point at itself.", node_id)
            return
        seen = {node_id}
        current = target
        while self.nodes[current].get("type") == "goto":
            if current in seen:
                self.err("goto_loop", "These Go to blocks point at each other in a circle.",
                         node_id)
                return
            seen.add(current)
            nxt = _config(self.nodes[current]).get("targetNodeId")
            if not isinstance(nxt, str) or nxt not in self.nodes:
                return  # reported on that goto
            current = nxt

    # -- driver ---------------------------------------------------------------
    def run(self) -> CompileResult:
        self.build_edges()
        order = self.reachable()
        reachable = set(order)
        for node in self.graph["nodes"]:
            if node["id"] not in reachable:
                self.warn("unreachable", "No path from Start reaches this block, so callers "
                          "never hear it.", node["id"])

        start_target = self.out.get((self.entry_id, "next"))
        if start_target is None:
            self.err("start_unconnected", "Connect Start to the first step of the call.",
                     self.entry_id, "next")

        plan_nodes: dict[str, dict] = {}
        for node_id in order:
            node = self.nodes[node_id]
            t = node.get("type")
            cfg = _config(node)
            if t == "entry":
                continue
            if t not in NODE_TYPES:
                self.err("block_unknown", "This kind of block isn't available for IVR.", node_id)
                continue
            if t == "goto":
                self.validate_goto(node_id, cfg)
            elif t == "play":
                plan_nodes[node_id] = self.compile_play(node_id, cfg)
            elif t == "menu":
                plan_nodes[node_id] = self.compile_menu(node_id, node, cfg)
            elif t == "schedule":
                plan_nodes[node_id] = self.compile_schedule(node_id, cfg)
            elif t == "condition":
                plan_nodes[node_id] = self.compile_condition(node_id, cfg)
            elif t == "dial":
                plan_nodes[node_id] = self.compile_dial(node_id, cfg)
            elif t == "voicemail":
                plan_nodes[node_id] = self.compile_voicemail(node_id, cfg)
            elif t == "hangup":
                plan_nodes[node_id] = self.compile_hangup(node_id, cfg)

        start = self.resolve(start_target) if start_target is not None else None
        if start_target is not None and start is None and not self.errors:
            self.err("start_unconnected", "Start leads nowhere. Connect it to a real step.",
                     self.entry_id, "next")

        self.check_loops(plan_nodes)

        if self.errors:
            return CompileResult(None, self.errors, self.warnings, self.prompt_names)

        prompts: list[str] = []
        for pnode in plan_nodes.values():
            for key in ("prompts", "invalid_prompts", "noinput_prompts"):
                for sha in pnode.get(key, ()):
                    if sha not in prompts:
                        prompts.append(sha)
        plan = {
            "v": PLAN_VERSION,
            "compiler": COMPILER_VERSION,
            "flow_id": self.ctx.flow_id,
            "version": self.ctx.version,
            "customer_id": self.ctx.customer_id,
            "start": start,
            "limits": {"max_steps": limits.MAX_STEPS, "max_seconds": limits.MAX_SECONDS},
            "prompts": prompts,
            "nodes": plan_nodes,
        }
        return CompileResult(plan, self.errors, self.warnings, self.prompt_names)

    def check_loops(self, plan_nodes: Mapping[str, dict]) -> None:
        """A loop that never waits for the caller spins until the step budget
        ends the call: an error when nothing plays in it, else a warning."""
        adj = {nid: [p for p in pointers(node) if p is not None and p in plan_nodes]
               for nid, node in plan_nodes.items()}
        for comp in _strongly_connected(adj):
            if len(comp) == 1 and comp[0] not in adj[comp[0]]:
                continue
            types = {plan_nodes[n]["t"] for n in comp}
            if types & {"menu", "transfer"}:
                continue
            first = min(comp, key=lambda n: list(plan_nodes).index(n))
            if "play" in types or any(plan_nodes[n].get("prompts") for n in comp):
                self.warn("loop_without_menu",
                          "These blocks repeat forever without waiting for the caller; the "
                          "call ends after a few minutes.", first)
            else:
                self.err("loop_silent",
                         "These blocks send the call around in a circle without playing "
                         "anything. Add a message or a menu, or end the call.", first)


def pointers(node: Mapping[str, Any]) -> list[Optional[str]]:
    """Every next/branch pointer of a plan node (contract §3)."""
    t = node.get("t")
    if t == "play":
        return [node.get("next")]
    if t == "menu":
        return list(node.get("digits", {}).values()) + [node.get("on_noinput"),
                                                         node.get("on_nomatch")]
    if t == "hours":
        return [node.get("open"), node.get("closed")]
    if t == "caller":
        return [node.get("match"), node.get("nomatch")]
    if t == "transfer":
        return [node.get("on_noanswer")]
    return []


def compile_flow(graph: Any, ctx: CompileContext) -> CompileResult:
    """Validate + compile ``graph`` for ``ctx``. Never raises on bad input."""
    shape = check_graph_shape(graph)
    if shape:
        return CompileResult(None, shape, [], {})
    return _Compiler(graph, ctx).run()


def plan_summary(plan: Mapping[str, Any], warnings: Iterable[Issue] = ()) -> dict:
    """A small, free-text-free description of a plan (publish response)."""
    by_type: dict[str, int] = {}
    destinations: list[str] = []
    for node in plan.get("nodes", {}).values():
        by_type[node["t"]] = by_type.get(node["t"], 0) + 1
        if node["t"] == "transfer":
            dest = node["dest"]
            num = dest.get("e164") or dest.get("did")
            if num not in destinations:
                destinations.append(num)
        elif node["t"] == "voicemail" and node["did"] not in destinations:
            destinations.append(node["did"])
    return {"blocks": len(plan.get("nodes", {})), "prompts": len(plan.get("prompts", [])),
            "by_type": by_type, "destinations": destinations,
            "warnings": [w.as_dict() for w in warnings]}
