"""Dial policy for IVR transfer targets (contract docs/IVR_INTERFACES.md §6).

Pure (no DB, no FastAPI). P1 enforces it at publish (and on every
validate/simulate); FreeSWITCH (P2) re-checks the E.164 SHAPE at call time.

External targets (decision D4 — US only):
  * shape ``^\\+1[2-9]\\d{2}[2-9]\\d{6}$`` (+1 NANP);
  * ALLOWED: an NPA assigned to one of the 50 states or DC
    (``US_STATE_NPAS``), a US territory (``US_TERRITORY_NPAS``: PR 787/939,
    USVI 340, Guam 671, CNMI 670, AS 684) or US toll-free 8YY
    (``US_TOLL_FREE_NPAS``: 800/833/844/855/866/877/888);
  * BLOCKED: everything else — Canadian NPAs, the Caribbean / other non-US
    NANP countries, premium 900, the N11 and 976 exchanges, 555-01xx
    (fictional) and 555-1212 (directory assistance), unassigned NPAs, and
    anything that is not +1.

Own targets: the DID must be one of the customer's CURRENT numbers (the
``customer_numbers`` owned set) in product rcf | voicemail | ivr | trunk; an
IVR transferring to its OWN number is an error (it would loop straight back
into itself).

Caller ID: ``passCallerId`` is a boolean; there is no custom caller ID.

NPA TABLES — PINNED. Source: NANPA "NPA Database" CSV,
https://reports.nanpa.com/public/npa_report.csv, "File Date,10/25/2026",
downloaded 2026-10-25 (sha256 85ef5d9585bb2a288371fda770af0025fb47254500d22b1c4667886b93372d1e).
``US_STATE_NPAS`` = every row with COUNTRY=US, USE=G (geographic),
ASSIGNED=Yes and a state/DC LOCATION — in service, plus the three assigned
and scheduled ones (451 NC, 565 GA, 761 KY), so a number in a new US area
code is never blocked once it goes live. Territories are the same query's
AS/CNMI/GU/PR/VI rows. Refresh: re-download the CSV, re-run that filter,
replace the strings below, bump ``NPA_TABLE_DATE`` and update the tests.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Mapping, Optional

from utils.phone import normalize_e164

NPA_TABLE_DATE = "2026-10-25"

#: State / DC -> its assigned geographic NPAs (NANPA, see the module docstring).
_US_STATE_NPA_TEXT: dict[str, str] = {
    "AK": "907",
    "AL": "205 251 256 334 483 659 938",
    "AR": "327 479 501 870",
    "AZ": "480 520 602 623 928",
    "CA": "209 213 279 310 323 341 350 357 369 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 738 747 760 805 818 820 831 837 840 858 909 916 925 949 951",
    "CO": "303 719 720 748 970 983",
    "CT": "203 475 860 959",
    "DC": "202 771",
    "DE": "302",
    "FL": "239 305 321 324 352 386 407 448 561 645 656 689 727 728 754 772 786 813 850 863 904 941 954",
    "GA": "229 404 470 478 565 678 706 762 770 912 943",
    "HI": "808",
    "IA": "319 515 563 641 712",
    "ID": "208 986",
    "IL": "217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 861 872",
    "IN": "219 260 317 463 574 765 812 930",
    "KS": "316 620 785 913",
    "KY": "270 364 502 606 761 859",
    "LA": "225 318 337 457 504 985",
    "MA": "339 351 413 508 617 774 781 857 978",
    "MD": "227 240 301 410 443 667",
    "ME": "207",
    "MI": "231 248 269 313 517 586 616 679 734 810 906 947 989",
    "MN": "218 320 507 612 651 763 924 952",
    "MO": "235 314 417 557 573 636 660 816 975",
    "MS": "228 471 601 662 769",
    "MT": "406",
    "NC": "252 336 451 472 704 743 828 910 919 980 984",
    "ND": "701",
    "NE": "308 402 531",
    "NH": "603",
    "NJ": "201 551 609 640 732 848 856 862 908 973",
    "NM": "505 575",
    "NV": "702 725 775",
    "NY": "212 315 329 332 347 363 465 516 518 585 607 624 631 646 680 716 718 838 845 914 917 929 934",
    "OH": "216 220 234 283 326 330 380 419 436 440 513 567 614 740 937",
    "OK": "405 539 572 580 918",
    "OR": "458 503 541 971",
    "PA": "215 223 267 272 412 445 484 570 582 610 717 724 814 835 878",
    "RI": "401",
    "SC": "803 821 839 843 854 864",
    "SD": "605",
    "TN": "423 615 629 729 731 865 901 931",
    "TX": "210 214 254 281 325 346 361 409 430 432 469 512 621 682 713 726 737 806 817 830 832 903 915 936 940 945 956 972 979",
    "UT": "385 435 801",
    "VA": "276 434 540 571 686 703 757 804 826 948",
    "VT": "802",
    "WA": "206 253 360 425 509 564",
    "WI": "262 274 353 414 534 608 715 920",
    "WV": "304 681",
    "WY": "307",
}

US_STATE_NPAS: frozenset[str] = frozenset(
    npa for npas in _US_STATE_NPA_TEXT.values() for npa in npas.split())

#: US territories in the NANP (contract §6).
US_TERRITORY_NPAS: Mapping[str, tuple[str, ...]] = {
    "PR": ("787", "939"),
    "VI": ("340",),
    "GU": ("671",),
    "CNMI": ("670",),
    "AS": ("684",),
}
_TERRITORY_SET: frozenset[str] = frozenset(
    npa for npas in US_TERRITORY_NPAS.values() for npa in npas)

#: US toll-free 8YY codes in service (822 / 880-889 others are not).
US_TOLL_FREE_NPAS: frozenset[str] = frozenset(
    {"800", "833", "844", "855", "866", "877", "888"})

ALLOWED_NPAS: frozenset[str] = US_STATE_NPAS | _TERRITORY_SET | US_TOLL_FREE_NPAS

#: Premium-rate NPA (also simply absent from ALLOWED_NPAS — named for the message).
PREMIUM_NPAS: frozenset[str] = frozenset({"900"})

#: Exchanges (NXX) that are never a valid transfer destination in any NPA:
#: N11 service codes and the 976 premium exchange.
BLOCKED_NXX: frozenset[str] = frozenset(
    {f"{n}11" for n in "23456789"} | {"976"})

NANP_SHAPE = re.compile(r"^\+1[2-9]\d{2}[2-9]\d{6}$", re.ASCII)

#: Products an own-number transfer may land on (never api — retired, hidden).
OWN_TARGET_PRODUCTS: tuple[str, ...] = ("rcf", "voicemail", "ivr", "trunk")


@dataclass(frozen=True)
class PolicyResult:
    ok: bool
    code: str = ""
    message: str = ""
    e164: Optional[str] = None


def _reject(code: str, message: str, e164: Optional[str] = None) -> PolicyResult:
    return PolicyResult(False, code, message, e164)


def check_external(raw: object) -> PolicyResult:
    """Is ``raw`` an outside number an IVR may transfer to (D4)?

    Accepts any phone format ``utils.phone.normalize_e164`` understands; the
    canonical E.164 is returned in ``e164`` on success. Messages are
    customer-readable sentences.
    """
    if not isinstance(raw, str) or not raw.strip():
        return _reject("number_required", "Enter the phone number to transfer to.")
    try:
        e164 = normalize_e164(raw)
    except ValueError:
        return _reject("number_invalid",
                       "That isn't a valid phone number. Use a US number like +1 617-555-0123.")
    if not e164.startswith("+1"):
        return _reject("not_us", "Transfers can only go to US phone numbers.", e164)
    if not NANP_SHAPE.match(e164):
        return _reject("number_invalid",
                       "That isn't a valid US phone number. Use a number like +1 617-555-0123.",
                       e164)
    npa, nxx, line = e164[2:5], e164[5:8], e164[8:]
    if npa in PREMIUM_NPAS:
        return _reject("premium", "Premium-rate (900) numbers can't be used.", e164)
    if npa not in ALLOWED_NPAS:
        return _reject("not_us",
                       "Transfers can only go to US numbers (the 50 states, DC, US territories "
                       "and US toll-free). That area code is outside the US.", e164)
    if nxx in BLOCKED_NXX:
        return _reject("special_number",
                       "Service numbers (like 411 or 911) and premium 976 numbers can't be used.",
                       e164)
    if nxx == "555" and (line.startswith("01") or line == "1212"):
        return _reject("special_number",
                       "Directory-assistance and fictional 555 numbers can't be used.", e164)
    return PolicyResult(True, e164=e164)


def check_own(raw: object, own_numbers: Mapping[str, str], self_dids: frozenset[str] | set[str]
              ) -> PolicyResult:
    """Is ``raw`` one of the customer's CURRENT numbers an IVR may transfer to?

    ``own_numbers`` maps canonical DID -> product (the customer_numbers owned
    set); ``self_dids`` are the IVR numbers bound to the flow being compiled.
    On success ``e164`` is the DID and ``code`` carries its product.
    """
    if not isinstance(raw, str) or not raw.strip():
        return _reject("number_required", "Choose one of your numbers to transfer to.")
    try:
        did = normalize_e164(raw)
    except ValueError:
        return _reject("not_own_number", "Choose one of your numbers to transfer to.")
    product = own_numbers.get(did)
    if product is None:
        return _reject("not_own_number",
                       "That number isn't on your account any more. Choose another number.", did)
    if product not in OWN_TARGET_PRODUCTS:
        return _reject("not_own_number", "Calls can't be transferred to that number.", did)
    if did in self_dids:
        return _reject("self_transfer",
                       "This IVR can't transfer to its own number — the call would loop.", did)
    return PolicyResult(True, code=product, e164=did)
