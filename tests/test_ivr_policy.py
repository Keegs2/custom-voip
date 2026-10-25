"""Visual IVR dial policy (services/ivr/policy.py, contract §6, decision D4 — US only)."""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

os.environ.setdefault("JWT_SECRET_KEY", "test-secret")
REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
if str(API_SRC) not in sys.path:
    sys.path.insert(0, str(API_SRC))

from services.ivr import policy  # noqa: E402


@pytest.mark.parametrize("raw,e164", [
    ("+16174544217", "+16174544217"),          # MA (the live test DID's area)
    ("(774) 404-5256", "+17744045256"),        # bare NANP formatted
    ("1-212-234-5678", "+12122345678"),        # NY
    ("+12022345678", "+12022345678"),          # DC
    ("+19072345678", "+19072345678"),          # Alaska
    ("+18082345678", "+18082345678"),          # Hawaii
    ("+17872345678", "+17872345678"),          # Puerto Rico
    ("+19392345678", "+19392345678"),          # Puerto Rico overlay
    ("+13402345678", "+13402345678"),          # USVI
    ("+16712345678", "+16712345678"),          # Guam
    ("+16702345678", "+16702345678"),          # CNMI
    ("+16842345678", "+16842345678"),          # American Samoa
    ("+18002345678", "+18002345678"),          # toll-free 800
    ("+18332345678", "+18332345678"),
    ("+18882345678", "+18882345678"),
    ("+15652345678", "+15652345678"),          # GA, assigned (in service 2027)
])
def test_allowed_us_numbers(raw, e164):
    r = policy.check_external(raw)
    assert r.ok, r
    assert r.e164 == e164


@pytest.mark.parametrize("raw,code", [
    ("+14162345678", "not_us"),        # Toronto, Canada
    ("+16042345678", "not_us"),        # Vancouver, Canada
    ("+15142345678", "not_us"),        # Montreal, Canada
    ("+18672345678", "not_us"),        # Yukon/NWT/Nunavut, Canada
    ("+18762345678", "not_us"),        # Jamaica (Caribbean NANP)
    ("+18092345678", "not_us"),        # Dominican Republic
    ("+12422345678", "not_us"),        # Bahamas
    ("+14412345678", "not_us"),        # Bermuda
    ("+12842345678", "not_us"),        # BVI
    ("+16492345678", "not_us"),        # Turks & Caicos
    ("+19002345678", "premium"),       # 900 premium
    ("+18222345678", "not_us"),        # 822 toll-free code not in service
    ("+19352345678", "not_us"),        # unassigned NPA
    ("+15002345678", "not_us"),        # 5XX non-geographic
    ("+17102345678", "not_us"),        # US government 710
    ("+16179762345", "special_number"),  # 976 premium exchange
    ("+16174112345", "special_number"),  # N11 exchange
    ("+16179112345", "special_number"),
    ("+12125550123", "special_number"),  # 555-01xx fictional
    ("+12125551212", "special_number"),  # directory assistance
    ("+442071234567", "not_us"),       # UK
    ("+5215512345678", "not_us"),      # Mexico
    ("+11234567890", "number_invalid"),  # NPA starts with 1
    ("+12121234567", "number_invalid"),  # NXX starts with 1
    ("911", "number_invalid"),
    ("", "number_required"),
    (None, "number_required"),
    ("sip:x@example.com", "number_invalid"),
])
def test_blocked_numbers(raw, code):
    r = policy.check_external(raw)
    assert not r.ok
    assert r.code == code
    assert r.message and r.message[0].isupper()


def test_npa_tables_are_pinned_and_disjoint():
    assert policy.NPA_TABLE_DATE == "2026-10-25"
    assert len(policy._US_STATE_NPA_TEXT) == 51                # 50 states + DC
    assert len(policy.US_STATE_NPAS) == 375
    assert set(policy._US_STATE_NPA_TEXT) >= {"DC", "AK", "HI"}
    territories = set().union(*map(set, policy.US_TERRITORY_NPAS.values()))
    assert territories == {"787", "939", "340", "671", "670", "684"}
    assert not territories & policy.US_STATE_NPAS
    assert not policy.US_TOLL_FREE_NPAS & policy.US_STATE_NPAS
    canada = {"204", "226", "236", "249", "250", "289", "306", "343", "365", "403", "416",
              "418", "431", "437", "438", "450", "506", "514", "519", "548", "579", "581",
              "587", "604", "613", "639", "647", "705", "709", "778", "780", "782", "807",
              "819", "825", "867", "873", "902", "905"}
    caribbean = {"242", "246", "264", "268", "284", "345", "441", "473", "649", "658", "664",
                 "721", "758", "767", "784", "809", "829", "849", "868", "869", "876"}
    assert not (canada | caribbean | {"900"}) & policy.ALLOWED_NPAS
    assert all(len(n) == 3 and n.isdigit() and n[0] in "23456789"
               for n in policy.ALLOWED_NPAS)


OWN = {"+16175550101": "rcf", "+16175550201": "voicemail", "+16175550301": "ivr",
       "+16175550401": "trunk", "+16175550501": "api"}


@pytest.mark.parametrize("did,product", [("+16175550101", "rcf"), ("6175550201", "voicemail"),
                                         ("+16175550301", "ivr"), ("+16175550401", "trunk")])
def test_own_numbers(did, product):
    r = policy.check_own(did, OWN, frozenset({"+16175550999"}))
    assert r.ok and r.code == product


def test_own_number_rejections():
    self_dids = frozenset({"+16175550301"})
    assert policy.check_own("+16175550301", OWN, self_dids).code == "self_transfer"
    assert policy.check_own("+16175550888", OWN, self_dids).code == "not_own_number"  # foreign
    assert policy.check_own("+16175550501", OWN, self_dids).code == "not_own_number"  # api
    assert policy.check_own("", OWN, self_dids).code == "number_required"
    assert policy.check_own("junk", OWN, self_dids).code == "not_own_number"
