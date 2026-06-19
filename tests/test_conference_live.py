"""Phase 7 — live-conference parsing + tenant-scoping unit tests (no infra).

Exercises ``services.conference_rooms`` against SYNTHETIC ``conference json_list``
output. Pure stdlib import (no DB/Redis/FS/Docker), mirroring test_esl_consumer.

Covers:
  * room-name → owning customer_id extraction (conf_ and room_ schemes)
  * tenant visibility (admin sees all; user sees only own-prefix rooms)
  * safe-name guard (ESL command-injection prevention)
  * json_list parsing: members, mute/talking/video flags, recording node
  * graceful empty parse for None / non-JSON / error / +OK-wrapped payloads
  * end-to-end scope: A's view never contains B's conf_ room

Run:  python3 -m pytest tests/test_conference_live.py -q
"""
import sys
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
sys.path.insert(0, str(API_SRC))

from services.conference_rooms import (  # noqa: E402
    conf_room_name,
    is_safe_room_name,
    room_owner_customer_id,
    room_visible,
    parse_conference_json_list,
    scope_conferences,
)


# --------------------------------------------------------------------------
# room name <-> tenant
# --------------------------------------------------------------------------
def test_conf_room_name_matches_shared_contract():
    # lowercase, every non-alnum -> _
    assert conf_room_name(5, "Sales Floor!") == "conf_5_sales_floor_"
    assert conf_room_name(42, "ACME-East") == "conf_42_acme_east"


def test_room_owner_for_both_schemes():
    assert room_owner_customer_id("conf_5_sales") == 5
    assert room_owner_customer_id("room_12_700") == 12
    # programmatic name whose sanitized suffix itself contains underscores/digits
    assert room_owner_customer_id("conf_5_sales_floor_2") == 5


def test_room_owner_none_for_unknown_scheme():
    assert room_owner_customer_id("global") is None
    assert room_owner_customer_id("conf_abc_x") is None  # non-numeric tenant
    assert room_owner_customer_id("") is None


def test_room_visible_admin_sees_all():
    assert room_visible("conf_5_x", None) is True
    assert room_visible("room_99_700", None) is True


def test_room_visible_user_scoped_to_own_prefix():
    assert room_visible("conf_5_x", 5) is True
    assert room_visible("room_5_700", 5) is True
    assert room_visible("conf_6_x", 5) is False     # cross-tenant
    assert room_visible("global", 5) is False        # unowned


def test_is_safe_room_name_rejects_injection():
    assert is_safe_room_name("conf_5_sales") is True
    assert is_safe_room_name("conf_5_sales kick all") is False   # space
    assert is_safe_room_name("conf_5\nlist") is False            # newline (%0A)
    assert is_safe_room_name("conf_5;bgapi") is False
    assert is_safe_room_name("") is False


# --------------------------------------------------------------------------
# json_list parsing
# --------------------------------------------------------------------------
def _synthetic_json_list():
    return json.dumps([
        {
            "conference_name": "conf_5_sales",
            "members": [
                {
                    "id": "1", "type": "caller",
                    "caller_id_name": "Alice", "caller_id_number": "100",
                    "flags": {"can_speak": True, "talking": True, "has_video": False},
                },
                {
                    "id": "2", "type": "caller",
                    "caller_id_name": "Bob", "caller_id_number": "101",
                    "flags": {"can_speak": False, "talking": False, "has_video": True},
                },
                {"type": "recording_node", "id": "0", "flags": {}},
            ],
        },
        {
            "conference_name": "room_6_700",
            "members": [
                {
                    "id": "9", "type": "caller",
                    "caller_id_name": "Carol", "caller_id_number": "200",
                    "flags": {"can_speak": True, "talking": False},
                },
            ],
        },
    ])


def test_parse_members_and_flags():
    parsed = parse_conference_json_list(_synthetic_json_list())
    assert len(parsed) == 2
    sales = next(c for c in parsed if c["name"] == "conf_5_sales")
    # recording_node excluded from members, surfaced as recording flag
    assert sales["member_count"] == 2
    assert sales["recording"] is True

    alice = sales["members"][0]
    assert alice["id"] == 1
    assert alice["name"] == "Alice"
    assert alice["caller_id_number"] == "100"
    assert alice["talking"] is True
    assert alice["muted"] is False
    assert alice["video"] is False

    bob = sales["members"][1]
    assert bob["muted"] is True       # can_speak False
    assert bob["video"] is True


def test_parse_graceful_on_bad_input():
    assert parse_conference_json_list(None) == []
    assert parse_conference_json_list("") == []
    assert parse_conference_json_list("-ERR no reply") == []
    assert parse_conference_json_list("not json at all") == []
    assert parse_conference_json_list("[") == []           # truncated JSON
    assert parse_conference_json_list("[]") == []          # no conferences


def test_parse_tolerates_ok_envelope_prefix():
    parsed = parse_conference_json_list('+OK\n[{"conference_name": "conf_5_x", "members": []}]')
    assert len(parsed) == 1
    assert parsed[0]["name"] == "conf_5_x"


# --------------------------------------------------------------------------
# end-to-end scoping
# --------------------------------------------------------------------------
def test_scope_hides_other_tenant_rooms():
    parsed = parse_conference_json_list(_synthetic_json_list())
    # customer 5 sees only conf_5_sales, never room_6_700
    view5 = scope_conferences(parsed, 5)
    names5 = {c["fs_room_name"] for c in view5}
    assert names5 == {"conf_5_sales"}
    assert view5[0]["customer_id"] == 5

    # customer 6 sees only room_6_700
    view6 = scope_conferences(parsed, 6)
    assert {c["fs_room_name"] for c in view6} == {"room_6_700"}

    # admin sees both
    view_admin = scope_conferences(parsed, None)
    assert {c["fs_room_name"] for c in view_admin} == {"conf_5_sales", "room_6_700"}


def test_scope_empty_when_esl_unreachable():
    # _send_esl_command -> None on Docker Desktop -> parse [] -> scope []
    assert scope_conferences(parse_conference_json_list(None), 5) == []
