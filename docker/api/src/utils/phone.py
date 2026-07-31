"""Canonical phone-number normalization — the ONE source of truth.

Canonical form
--------------
E.164 with a leading ``+``, **PRESERVING the country code**.

The ONLY implicit default is: a **bare 10-digit** number (no ``+``, no country
code) is treated as US NANP and gets ``+1`` prepended. We NEVER strip a ``+`` and
NEVER force ``+1`` onto a number that already carries a country code. International
numbers (``+44…``, ``+52…``) are ingested and passed through UNCHANGED.

This value becomes a routing AND billing key (it is what the ``number_routing``
view / on-net resolver, the CDR ``customer_id`` join, and every DID unique index
match on), so correctness and cross-layer consistency are load-bearing.

Cross-layer contract (MUST STAY IDENTICAL)
------------------------------------------
Three implementations of THIS EXACT algorithm run on the platform and must agree
character-for-character on every input:
  * Python  — this module (``docker/api/src/utils/phone.py``)  ← REFERENCE
  * Lua     — FreeSWITCH  (``docker/freeswitch/scripts/lib/number_utils.lua``)
  * TS      — React UI    (``docker/ui/src/utils/phone.ts``)
If you change the rule here, change it in all three and re-verify the shared test
vectors below. Any divergence silently mis-routes or mis-bills calls.

Shared test vectors (all layers must produce these)
---------------------------------------------------
    normalize_e164('5551234567')      == '+15551234567'   # bare 10-digit US default
    normalize_e164('15551234567')     == '+15551234567'   # 1 + NANP
    normalize_e164('+15551234567')    == '+15551234567'   # already canonical
    normalize_e164('(555) 123-4567')  == '+15551234567'   # punctuation stripped
    normalize_e164('+44 7911 123456') == '+447911123456'  # INTERNATIONAL preserved (NOT +1)
    normalize_e164('+5215512345678')  == '+5215512345678' # MX preserved
    normalize_e164('447911123456')    -> ValueError        # no +, not NANP -> ambiguous
    normalize_e164('1001')            -> ValueError        # too short for a DID
    normalize_e164('')                -> ValueError

    normalize_forward_destination('1001')           == '1001'          # PBX extension, verbatim
    normalize_forward_destination('5551234567')     == '+15551234567'  # else full E.164
    normalize_forward_destination('+44 7911 123456')== '+447911123456'

    is_valid_e164('+447911123456') is True
    is_valid_e164('447911123456')  is False
"""

import re

__all__ = ["normalize_e164", "normalize_forward_destination", "is_valid_e164"]

# Cosmetic separators that carry no routing meaning and are dropped when
# collecting the significant digits: '+', space, '-', '(', ')', '.'. We do NOT
# strip arbitrary letters — a stray letter leaves a non-digit in the input and the
# number fails validation (fail-closed). Kept as documentation of the exact set the
# Lua/TS ports must also treat as separators; the code below uses ``str.isdigit``.
_SEPARATORS = frozenset("+ -().")

# A 3-6 digit local PBX extension (e.g. 1001) — valid ONLY as a forward/failover
# destination, never as an ownable DID.
_EXTENSION_RE = re.compile(r"\d{3,6}")


def _digits(s: str) -> str:
    """Return only the ASCII decimal digits of ``s`` (drop +, space, -, (, ), .).

    Any non-separator, non-digit character (e.g. a letter) is left in place so the
    caller's length/shape checks fail closed rather than silently accepting junk.
    """
    return "".join(ch for ch in s if ch.isdigit())


def normalize_e164(raw: str) -> str:
    """Normalize ``raw`` to canonical E.164 (``+`` + country code + subscriber).

    Rules (in order):
      1. Strip surrounding whitespace; empty -> ValueError.
      2. Remember whether the input started with ``+`` (explicit country code).
      3. Collect the digit characters (dropping + space - ( ) .).
      4. If it started with ``+``: it already carries a country code — PRESERVE it.
         Require 8-15 total digits with a non-zero leading digit; return ``+`` + digits.
      5. Bare ``1``+10 NANP (11 digits, ``1`` then ``[2-9]``): return ``+`` + digits.
      6. Bare 10-digit NANP (``[2-9]`` first): return ``+1`` + digits — the ONLY
         place ``+1`` is ever synthesized.
      7. Anything else is ambiguous -> ValueError (caller must supply full E.164).

    Args:
        raw: A phone number in any accepted human/DB format.

    Returns:
        The canonical ``+E.164`` string.

    Raises:
        ValueError: If ``raw`` is empty or cannot be unambiguously canonicalized.
    """
    if raw is None:
        raise ValueError("phone number is required")

    s = raw.strip()
    if not s:
        raise ValueError("phone number is required")

    has_plus = s.startswith("+")
    d = _digits(s)

    if has_plus:
        # Explicit country code present. PRESERVE it exactly — never re-add 1, never
        # strip. E.164 allows up to 15 digits; require a sane minimum and a non-zero
        # leading digit (country codes never start with 0).
        if 8 <= len(d) <= 15 and d[0] in "123456789":
            return "+" + d
        raise ValueError(
            f"malformed E.164 number: '{raw}' "
            "(expected '+' followed by 8-15 digits, leading digit 1-9)"
        )

    # No leading '+': only unambiguous North American Numbering Plan shapes are
    # accepted, so we never mislabel a foreign national number as US.
    if len(d) == 11 and d[0] == "1" and d[1] in "23456789":
        # 1 + 10-digit NANP (leading '1' country code typed without the '+').
        return "+" + d
    if len(d) == 10 and d[0] in "23456789":
        # Bare 10-digit US NANP — the ONLY case where we synthesize the +1.
        return "+1" + d

    raise ValueError(
        f"cannot normalize '{raw}': provide full E.164 with country code, "
        "e.g. +447911123456"
    )


def normalize_forward_destination(raw: str) -> str:
    """Normalize an RCF ``forward_to`` / ``failover_to`` destination.

    A destination may be a **local PBX extension** (3-6 bare digits, e.g. ``1001``
    for FreeSWITCH/Zoiper testing), which is kept verbatim. Anything else must be a
    full phone number and is run through :func:`normalize_e164` (so 10-digit US and
    international ``+CC`` inputs canonicalize identically to a DID).

    Args:
        raw: A forward/failover destination in any accepted format.

    Returns:
        The extension string as-is, or the canonical ``+E.164`` number.

    Raises:
        ValueError: If ``raw`` is neither a 3-6 digit extension nor a valid E.164.
    """
    if raw is None:
        raise ValueError("destination is required")

    s = raw.strip()
    # Local PBX extension: 3-6 digits, exactly. Kept verbatim (not a PSTN number).
    if _EXTENSION_RE.fullmatch(s):
        return s
    return normalize_e164(s)


def is_valid_e164(raw: str) -> bool:
    """Non-raising predicate: True iff ``raw`` normalizes to canonical E.164.

    Note this returns False for a bare 3-6 digit extension — extensions are only
    meaningful for :func:`normalize_forward_destination`, not as standalone DIDs.
    """
    try:
        normalize_e164(raw)
        return True
    except (ValueError, TypeError):
        return False
