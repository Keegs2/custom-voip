"""One Flow assistant job, without a database (contract docs/IVR_ASSIST_INTERFACES.md §2 / §5.1).

    request = alias(message, history, base, destinations, prompts)   §2 / §4
    TED  ->  proposal | clarify | cannot_build                       §3
    proposal -> de-alias -> compile with the customer's REAL context
                plus the new messages as synthetic prompts
             -> errors? call TED again with round "repair" (at most 2)
    -> the customer-facing result (§5.2), errors left after the repairs in
       ``issues`` (the customer can fix the rest by hand)

``run`` takes everything it needs in ``AssistInput`` and talks to TED only
through ``call_ted`` — the API job (jobs.py), the eval runner (eval.py) and
the tests share it unchanged.
"""
from __future__ import annotations

import dataclasses
import hashlib
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Mapping, Optional

from services.ivr import compiler
from services.ivr.assist import config, graph as ag
from services.ivr.assist.aliases import AliasBook, PromptInfo, clip
from services.ivr.assist.ted_client import FAILED, TedError
from services.ivr.compiler import CompileContext, Issue, OwnNumber, PromptRef

logger = logging.getLogger(__name__)

CallTed = Callable[[dict], Awaitable[dict]]


@dataclass
class AssistInput:
    """Everything one job needs (no DB)."""
    message: str                                   # the customer's own words
    conversation_id: str
    compile_ctx: CompileContext                    # the customer's REAL context
    numbers: list[OwnNumber]
    prompts: list[PromptInfo]
    #: earlier turns of this conversation, customer-facing text, oldest first
    history: list[tuple[str, str]] = field(default_factory=list)
    base_graph: Optional[dict] = None              # §2 draft (or a stored proposal)
    #: the stored proposal's new messages when refining it ({placeholder_id, name, text})
    base_new_prompts: list[dict] = field(default_factory=list)
    #: the conversation's outside numbers so far ([N<k>] = external_numbers[k-1])
    external_numbers: list[str] = field(default_factory=list)
    max_new_prompts: int = config.MAX_NEW_PROMPTS


@dataclass
class AssistOutcome:
    status: str                                    # done | failed
    public: Optional[dict] = None                  # §5.2 shape when done
    error_code: Optional[str] = None
    retry_after_s: Optional[int] = None
    rounds: int = 0
    request_ids: list[str] = field(default_factory=list)
    external_numbers: list[str] = field(default_factory=list)
    #: the last compile of a proposal (eval / tests: the plan to simulate)
    compiled: Optional[compiler.CompileResult] = None


def placeholder_sha(index: int) -> str:
    """A syntactically valid, never-stored audio sha for placeholder -index."""
    return hashlib.sha256(f"ivr-assist-placeholder:{index}".encode()).hexdigest()


def compile_proposal(draft: dict, ctx: CompileContext,
                     new_prompts: list[dict]) -> compiler.CompileResult:
    """Compile a proposal: the real context + each new message as a synthetic prompt."""
    extra = {np["placeholder_id"]: PromptRef(placeholder_sha(-np["placeholder_id"]), np["name"])
             for np in new_prompts}
    return compiler.compile_flow(draft, dataclasses.replace(
        ctx, prompts={**ctx.prompts, **extra}))


class _Request:
    """The fixed part of every round's request (§2: a repair re-sends it)."""

    def __init__(self, inp: AssistInput):
        self.book = AliasBook(inp.numbers, inp.compile_ctx.self_dids, inp.prompts,
                              inp.external_numbers)
        book = self.book
        # Alias order = who gets the low N numbers: the message first.
        self.message = clip(book.alias_text(inp.message.strip()), config.MAX_MESSAGE_CHARS)
        placeholders = {np["placeholder_id"]: f"NP{-np['placeholder_id']}"
                        for np in inp.base_new_prompts}
        self.base = ag.to_alias_graph(inp.base_graph, book, placeholders=placeholders)
        self.base_new_prompts = [] if self.base is None else self.alias_new_prompts(
            [{"key": f"NP{-np['placeholder_id']}", "name": np["name"], "text": np["text"]}
             for np in inp.base_new_prompts])
        self.history = []
        for role, text in inp.history[-config.HISTORY_TURNS:]:
            aliased = clip(book.alias_text(text).strip(), config.MAX_MESSAGE_CHARS)
            if aliased:
                self.history.append({"role": role, "text": aliased})
        self.prompts = book.request_prompts()
        self.destinations = book.request_destinations()
        self.external_numbers = book.external_aliases()
        self.limits = {"max_nodes": config.MAX_NODES,
                       "max_new_prompts": max(0, min(config.MAX_NEW_PROMPTS,
                                                     inp.max_new_prompts)),
                       "max_prompt_chars": config.MAX_PROMPT_CHARS}
        self.conversation_id = inp.conversation_id

    def alias_new_prompts(self, nps: list[Mapping[str, Any]], *,
                          allocate: bool = True) -> list[dict]:
        """``base_new_prompts`` entries. A repair re-sends TED's own new
        prompts with ``allocate=False``: a raw number in them becomes
        ``[number removed]`` and ``external_numbers`` stays what round 1 sent."""
        book = self.book
        out = []
        for i, np in enumerate(nps[:config.MAX_NEW_PROMPTS]):
            name = clip(" ".join(book.alias_text(np.get("name") or "",
                                                 allocate=allocate).split()), 100)
            text = clip(book.alias_text(np.get("text") or "", allocate=allocate).strip(),
                        config.MAX_PROMPT_CHARS)
            out.append({"key": np["key"], "name": name or f"New message {i + 1}",
                        "text": text or (name or f"New message {i + 1}")})
        return out

    def payload(self, round_: str, base: Optional[dict], base_new_prompts: list[dict],
                issues: Optional[list[dict]]) -> dict:
        return {
            "v": 1,
            "request_id": str(uuid.uuid4()),
            "conversation_id": self.conversation_id,
            "round": round_,
            "message": self.message,
            "history": self.history,
            "base": base,
            "base_new_prompts": base_new_prompts if base is not None else [],
            "destinations": self.destinations,
            "prompts": self.prompts,
            "external_numbers": self.external_numbers,
            "repair": {"issues": issues} if issues else None,
            "limits": self.limits,
        }


def _repair_issues(errors: list[Issue], book: AliasBook) -> list[dict]:
    out = []
    for e in errors[:30]:
        item = {"code": clip(e.code, 64) or "error",
                "message": clip(" ".join(book.alias_text(e.message, allocate=False).split()),
                                300) or "This block has a problem."}
        if e.node_id is not None and compiler.ID_RE.match(e.node_id):
            item["node_id"] = e.node_id
        out.append(item)
    return out


@dataclass
class _Proposal:
    result: dict            # TED's result (alias form)
    public: dict            # §5.2 proposal (de-aliased)
    errors: list[Issue]
    compiled: compiler.CompileResult


def _de_alias_proposal(result: Mapping[str, Any], book: AliasBook,
                       ctx: CompileContext) -> _Proposal:
    nps = list(result.get("new_prompts") or [])[:config.MAX_NEW_PROMPTS]
    np_ids = ag.placeholder_ids(nps)
    names: dict[str, str] = {}
    public_nps: list[dict] = []
    extra: list[Issue] = []
    for np in nps:
        pid = np_ids.get(np["key"])
        if pid is None:
            continue
        name = clip(" ".join(book.render(np["name"]).split()), 100) or f"New message {-pid}"
        names[np["key"]] = name
        text = book.spoken(np["text"])
        if not text:
            extra.append(Issue("new_message_empty",
                               f"The new message “{name}” has no words to say."))
        elif len(text) > config.MAX_PROMPT_CHARS:
            extra.append(Issue("new_message_too_long",
                               f"The new message “{name}” is longer than "
                               f"{config.MAX_PROMPT_CHARS} characters once its numbers are "
                               "written out. Shorten it."))
        public_nps.append({"placeholder_id": pid, "name": name,
                           "text": text[:config.MAX_PROMPT_CHARS]})
    draft = ag.from_alias_graph(result["graph"], book, np_ids, names)
    compiled = compile_proposal(draft, ctx, public_nps)
    errors = list(compiled.errors) + extra
    public = {
        "kind": "proposal",
        "draft_graph": draft,
        "new_prompts": public_nps,
        "summary": book.render(result.get("summary"), names),
        "assumptions": [a for a in (book.render(x, names) for x in result.get("assumptions")
                                    or []) if a],
        "issues": [e.as_dict() for e in errors],
        "warnings": [w.as_dict() for w in compiled.warnings],
    }
    return _Proposal(dict(result), public, errors, compiled)


def _render_other(result: Mapping[str, Any], book: AliasBook) -> dict:
    if result["kind"] == "clarify":
        return {"kind": "clarify", "question": book.render(result["question"])}
    return {"kind": "cannot_build", "message": book.render(result["message"])}


async def run(inp: AssistInput, call_ted: CallTed, *,
              deadline: Optional[float] = None) -> AssistOutcome:
    """Propose, then repair at most ``config.MAX_REPAIRS`` times (§5.1).

    ``deadline`` (time.monotonic()) — no new TED call starts after it minus
    one call timeout, so the result is stored before the job reads as stale.
    """
    req = _Request(inp)
    out = AssistOutcome(status="failed", external_numbers=list(req.book.external))
    base, base_nps, issues = req.base, req.base_new_prompts, None
    last: Optional[_Proposal] = None
    for attempt in range(1 + config.MAX_REPAIRS):
        if attempt and deadline is not None \
                and time.monotonic() + config.ted_timeout_s() > deadline:
            logger.info("ivr assist: out of time after %d round(s); returning the last "
                        "proposal with its issues", out.rounds)
            break
        payload = req.payload("repair" if attempt else "propose", base, base_nps, issues)
        out.rounds += 1
        out.request_ids.append(payload["request_id"])
        try:
            body = await call_ted(payload)
        except TedError as exc:
            if last is not None:
                logger.info("ivr assist: repair round failed (%s); returning the last "
                            "proposal with its issues", exc.code)
                break
            out.error_code, out.retry_after_s = exc.code, exc.retry_after_s
            return out
        result = body["result"]
        if result["kind"] != "proposal":
            if last is not None:
                # A repair that turns into a question/refusal does not replace
                # the proposal the customer can already fix by hand.
                break
            out.status, out.public = "done", _render_other(result, req.book)
            return out
        try:
            last = _de_alias_proposal(result, req.book, inp.compile_ctx)
        except Exception as exc:  # noqa: BLE001 — a schema-valid graph we cannot read
            logger.error("ivr assist: could not de-alias a proposal (%s)", type(exc).__name__)
            if out.public is None and last is None:
                out.error_code = FAILED
                return out
            break
        out.compiled = last.compiled
        if not last.errors or attempt == config.MAX_REPAIRS:
            break
        base = last.result["graph"]
        base_nps = req.alias_new_prompts(last.result.get("new_prompts") or [],
                                         allocate=False)
        issues = _repair_issues(last.errors, req.book)
    if last is None:
        out.error_code = FAILED
        return out
    out.status, out.public, out.compiled = "done", last.public, last.compiled
    out.external_numbers = list(req.book.external)
    return out
