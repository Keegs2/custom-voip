"""Phone-number detection and alias tokens (contract docs/IVR_ASSIST_INTERFACES.md §4.1).

Nothing CRAG sends to TED may carry a phone number or the customer's identity.
Every text that leaves (the message, history, number labels, prompt names and
texts, block labels, compiler issue messages) goes through
``AliasBook.alias_text``:

  * a NANP number in any common form (``+1 617 555 0100``, ``(617) 555-0100``,
    ``617.555.0100``, ``16175550100``, ``6175550100`` ...) that is one of the
    customer's own numbers becomes its ``[D<n>]``; any other becomes a
    ``[N<n>]`` that is stable for the whole conversation (at most 20 —
    beyond that, ``[number removed]``);
  * a ``+``-prefixed international number (8+ digits, any separators) becomes
    ``[number removed]`` (hardening: the US-only dial policy cannot use it,
    and the 7-digit rule below would miss a spaced one);
  * any remaining run of 7+ digits becomes ``[number removed]``.

The way back (``render`` for the customer, ``spoken`` for a new message's
text-to-speech words) is in the same book, so a token always means the same
number in both directions.

Pure: no DB, no clock.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Mapping, Optional

from services import customer_numbers as cn
from services.ivr import policy
from services.ivr.compiler import OwnNumber

TOKEN_RE = re.compile(r"\[(NP|D|N|P)([1-9][0-9]{0,2})\]")
NUMBER_REMOVED = "[number removed]"
MAX_DESTINATIONS = 200
MAX_PROMPTS = 100

# NANP: optional country code, (area) or area, exchange, line. Not glued to a
# digit or a '+' on the left, nor to a digit on the right (letters may touch
# it: "x617-555-0100" is still a number).
_NANP_RE = re.compile(
    r"(?<![\d+])"
    r"(?P<cc>\+\s?1[\s.-]?|1[\s.-]?)?"
    r"(?:\(\s?(?P<a1>[2-9]\d{2})\s?\)|(?P<a2>[2-9]\d{2}))"
    r"(?P<s1>[\s.-]?)"
    r"(?P<x>[2-9]\d{2})"
    r"(?P<s2>[\s.-]?)"
    r"(?P<l>\d{4})"
    r"(?!\d)", re.ASCII)
_INTL_RE = re.compile(r"(?<![\d+])\+(?:[\s.()-]{0,2}\d){8,15}(?!\d)", re.ASCII)
_RUN_RE = re.compile(r"\d{7,}", re.ASCII)
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_PARTIAL_TOKEN_RE = re.compile(r"\[[^\]\s]{0,20}$")

#: Neutral label of an unnamed number (contract §2 "label").
NEUTRAL_LABELS = {"rcf": "Forwarding number", "voicemail": "Mailbox", "ivr": "IVR number",
                  "trunk": "SIP trunk number"}


def pretty(e164: str) -> str:
    """+16175550100 -> 617-555-0100 (the customer-facing form, §4.1)."""
    if isinstance(e164, str) and len(e164) == 12 and e164.startswith("+1") \
            and e164[1:].isdigit():
        return f"{e164[2:5]}-{e164[5:8]}-{e164[8:]}"
    return e164


def clip(text: str, limit: int) -> str:
    """``text`` cut to ``limit`` characters without leaving half a token."""
    if len(text) <= limit:
        return text
    return _PARTIAL_TOKEN_RE.sub("", text[:limit]).rstrip()


def clean_free_text(text: str) -> str:
    """Control characters (other than newline / tab) become spaces."""
    return _CONTROL_RE.sub(" ", text)


def find_numbers(text: str) -> list[str]:
    """Every NANP number in ``text`` as +1 E.164, in order (tests / eval)."""
    out = []
    for m in _NANP_RE.finditer(text or ""):
        out.append("+1" + (m.group("a1") or m.group("a2")) + m.group("x") + m.group("l"))
    return out


@dataclass(frozen=True)
class Destination:
    alias: str          # "D3"
    did: str            # +1 E.164
    product: str        # rcf | voicemail | ivr | trunk
    label: str          # the number's name, else the neutral phrase (customer-facing)
    enabled: bool
    this_flow: bool


@dataclass(frozen=True)
class PromptInfo:
    """One of the customer's live prompts (``text`` = TTS words, None for audio)."""
    id: int
    name: str
    text: Optional[str] = None


class AliasBook:
    """The aliases of one job: ``D`` (own numbers), ``N`` (other numbers of
    the conversation), ``P`` (existing prompts)."""

    def __init__(self, numbers: Iterable[OwnNumber], self_dids: Iterable[str] = (),
                 prompts: Iterable[PromptInfo] = (), external_numbers: Iterable[str] = ()):
        self_set = frozenset(self_dids)
        own = sorted((n for n in numbers if n.product in policy.OWN_TARGET_PRODUCTS),
                     key=lambda n: (cn.product_sort_key(n.product), n.did))
        counters: dict[str, int] = {}
        self.destinations: list[Destination] = []
        #: own numbers past MAX_DESTINATIONS: never sent, never usable.
        self._unlisted_own: set[str] = set()
        for number in own:
            counters[number.product] = counters.get(number.product, 0) + 1
            if len(self.destinations) >= MAX_DESTINATIONS:
                self._unlisted_own.add(number.did)
                continue
            name = " ".join((number.name or "").split())
            label = name or f"{NEUTRAL_LABELS[number.product]} {counters[number.product]}"
            self.destinations.append(Destination(
                f"D{len(self.destinations) + 1}", number.did, number.product, label,
                bool(number.enabled), number.did in self_set))
        self._by_did = {d.did: d for d in self.destinations}
        self._by_alias = {d.alias: d for d in self.destinations}
        self.external: list[str] = []
        for e164 in external_numbers:
            if isinstance(e164, str) and e164 not in self.external and len(self.external) < 20:
                self.external.append(e164)
        self.prompts: list[PromptInfo] = sorted(prompts, key=lambda p: p.id)[:MAX_PROMPTS]
        self._p_alias = {p.id: f"P{i + 1}" for i, p in enumerate(self.prompts)}
        self._p_by_alias = {f"P{i + 1}": p for i, p in enumerate(self.prompts)}

    # -- numbers ---------------------------------------------------------------
    def destination(self, alias: str) -> Optional[Destination]:
        return self._by_alias.get(alias)

    def own(self, did: str) -> Optional[Destination]:
        return self._by_did.get(did)

    def n_alias(self, e164: str, *, allocate: bool = True,
                allow_own: bool = False) -> Optional[str]:
        """``N<k>`` for an outside number (allocating a new one when allowed).

        ``allow_own``: a Caller check (``equals``) value is always an ``N``
        alias (contract §3 rule 5), even when it is one of the customer's own
        numbers (a PBX calling in with its own caller ID)."""
        if e164 in self.external:
            return f"N{self.external.index(e164) + 1}"
        if allocate and len(self.external) < 20 \
                and (allow_own or (e164 not in self._by_did and e164 not in self._unlisted_own)):
            self.external.append(e164)
            return f"N{len(self.external)}"
        return None

    def external_number(self, alias: str) -> Optional[str]:
        if not alias.startswith("N") or not alias[1:].isdigit():
            return None
        k = int(alias[1:])
        return self.external[k - 1] if 1 <= k <= len(self.external) else None

    def number_token(self, e164: str, *, allocate: bool = True) -> str:
        own = self._by_did.get(e164)
        if own is not None:
            return f"[{own.alias}]"
        if e164 in self._unlisted_own:
            return NUMBER_REMOVED
        n = self.n_alias(e164, allocate=allocate)
        return f"[{n}]" if n else NUMBER_REMOVED

    def alias_text(self, text: Optional[str], *, allocate: bool = True) -> str:
        """``text`` with every phone number replaced (see the module doc)."""
        if not text:
            return ""

        def nanp(m: re.Match) -> str:
            e164 = "+1" + (m.group("a1") or m.group("a2")) + m.group("x") + m.group("l")
            cc = m.group("cc") or ""
            token = self.number_token(e164, allocate=allocate)
            # "press 1 6175550100": a bare "1 " before an unformatted 10-digit
            # number is a separate word, not the country code — keep it.
            if cc and not cc.startswith("+") and len(cc) > 1 and m.group("a2") \
                    and not m.group("s1") and not m.group("s2"):
                return cc + token
            return token

        out = _NANP_RE.sub(nanp, clean_free_text(text))
        out = _INTL_RE.sub(NUMBER_REMOVED, out)
        return _RUN_RE.sub(NUMBER_REMOVED, out)

    # -- prompts -----------------------------------------------------------------
    def p_alias(self, prompt_id: int) -> Optional[str]:
        return self._p_alias.get(prompt_id)

    def prompt(self, alias: str) -> Optional[PromptInfo]:
        return self._p_by_alias.get(alias)

    # -- the request's lists (aliased; call AFTER the message is aliased so the
    #    customer's own numbers get the lowest N aliases) ---------------------
    def request_destinations(self) -> list[dict]:
        return [{"alias": d.alias, "product": d.product,
                 "label": clip(self.alias_text(d.label), 120) or d.alias,
                 "enabled": d.enabled, "this_flow": d.this_flow}
                for d in self.destinations]

    def request_prompts(self) -> list[dict]:
        out = []
        for i, p in enumerate(self.prompts):
            name = clip(" ".join(self.alias_text(p.name).split()), 100) or f"Message {i + 1}"
            text = clip(self.alias_text(p.text), 1000) if p.text else ""
            out.append({"alias": f"P{i + 1}", "name": name, "text": text or None})
        return out

    def external_aliases(self) -> list[str]:
        return [f"N{i + 1}" for i in range(len(self.external))]

    # -- the way back -----------------------------------------------------------
    def render(self, text: Optional[str],
               new_prompt_names: Optional[Mapping[str, str]] = None) -> str:
        """Customer-facing text: ``[D1]`` -> ``Billing line (617-555-0100)``,
        ``[N1]`` -> ``617-555-0100``, ``[P1]`` / ``[NP1]`` -> the name in quotes."""
        names = new_prompt_names or {}

        def repl(m: re.Match) -> str:
            kind, alias = m.group(1), m.group(1) + m.group(2)
            if kind == "D":
                d = self._by_alias.get(alias)
                return f"{d.label} ({pretty(d.did)})" if d else "one of your numbers"
            if kind == "N":
                number = self.external_number(alias)
                return pretty(number) if number else "an outside number"
            if kind == "P":
                p = self._p_by_alias.get(alias)
                return f"“{p.name}”" if p else "a message"
            name = names.get(alias)
            return f"“{name}”" if name else "a new message"

        return TOKEN_RE.sub(repl, clean_free_text(text or "")).strip()

    def spoken(self, text: Optional[str]) -> str:
        """A new message's words for text-to-speech: numbers spelled
        ``617-555-0100``, message tokens and ``[number removed]`` dropped."""
        def repl(m: re.Match) -> str:
            kind, alias = m.group(1), m.group(1) + m.group(2)
            if kind == "D":
                d = self._by_alias.get(alias)
                return pretty(d.did) if d else ""
            if kind == "N":
                number = self.external_number(alias)
                return pretty(number) if number else ""
            return ""

        out = TOKEN_RE.sub(repl, text or "").replace(NUMBER_REMOVED, "")
        out = re.sub(r"[\x00-\x1f\x7f]", " ", out)
        out = re.sub(r"\s+", " ", out)
        out = re.sub(r"\s+([,.;:!?])", r"\1", out)
        return out.strip()
