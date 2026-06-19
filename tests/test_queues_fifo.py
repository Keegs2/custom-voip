"""Phase 8 — live mod_fifo queue parsing + tenant-scoping unit tests (no infra).

Exercises ``services.fifo_queues`` against SYNTHETIC ``fifo list`` XML output.
Pure stdlib import (no DB/Redis/FS/Docker), mirroring test_conference_live.py.

Covers:
  * queue-name → owning customer_id extraction + prefix-stripped display name
  * tenant visibility (admin sees all; user sees only own-prefix queues)
  * safe-name guard (ESL command-injection prevention)
  * fifo list XML parsing: depth (explicit attr OR counted callers), members
  * graceful empty parse for None / non-XML / error / +OK-wrapped payloads
  * end-to-end scope: A's view never contains B's queue, prefix stripped

Run:  python3 -m pytest tests/test_queues_fifo.py -q
"""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
API_SRC = REPO / "docker" / "api" / "src"
sys.path.insert(0, str(API_SRC))

from services.fifo_queues import (  # noqa: E402
    fs_queue_name,
    is_safe_queue_name,
    queue_owner_customer_id,
    queue_display_name,
    queue_visible,
    parse_fifo_list,
    scope_queues,
)


# --------------------------------------------------------------------------
# queue name <-> tenant
# --------------------------------------------------------------------------
def test_fs_queue_name():
    assert fs_queue_name(5, "support") == "fifo_5_support"


def test_queue_owner_and_display():
    assert queue_owner_customer_id("fifo_5_support") == 5
    assert queue_display_name("fifo_5_support") == "support"
    # sub-name itself contains underscores
    assert queue_owner_customer_id("fifo_5_vip_support") == 5
    assert queue_display_name("fifo_5_vip_support") == "vip_support"


def test_queue_owner_none_for_unknown_scheme():
    assert queue_owner_customer_id("global") is None
    assert queue_owner_customer_id("fifo_abc_x") is None  # non-numeric tenant
    assert queue_owner_customer_id("") is None
    # display name passes through unchanged when it doesn't match the scheme
    assert queue_display_name("global") == "global"


def test_queue_visible_admin_and_user():
    assert queue_visible("fifo_5_support", None) is True   # admin sees all
    assert queue_visible("fifo_5_support", 5) is True
    assert queue_visible("fifo_6_support", 5) is False     # cross-tenant
    assert queue_visible("global", 5) is False             # unowned


def test_is_safe_queue_name_rejects_injection():
    assert is_safe_queue_name("fifo_5_support") is True
    assert is_safe_queue_name("fifo_5_support kick all") is False  # space
    assert is_safe_queue_name("fifo_5\nlist") is False             # newline (%0A)
    assert is_safe_queue_name("fifo_5;bgapi") is False
    assert is_safe_queue_name("") is False


# --------------------------------------------------------------------------
# fifo list XML parsing
# --------------------------------------------------------------------------
def _synthetic_fifo_list():
    return (
        '<fifo_report>'
        '  <fifo name="fifo_5_support" consumer_total="2" caller_total="1">'
        '    <callers>'
        '      <caller uuid="abc-123" caller_id_number="+15551112222"'
        '              caller_id_name="Alice" status="WAITING"/>'
        '    </callers>'
        '    <consumers>'
        '      <consumer uuid="def-456" caller_id_number="agent1"/>'
        '    </consumers>'
        '  </fifo>'
        '  <fifo name="fifo_6_sales">'
        '    <callers>'
        '      <caller uuid="g-1" caller_id_number="200"/>'
        '      <caller uuid="g-2" caller_id_number="201"/>'
        '    </callers>'
        '  </fifo>'
        '</fifo_report>'
    )


def test_parse_depth_and_members():
    parsed = parse_fifo_list(_synthetic_fifo_list())
    assert len(parsed) == 2

    support = next(q for q in parsed if q["name"] == "fifo_5_support")
    # explicit caller_total attr wins
    assert support["depth"] == 1
    assert len(support["members"]) == 1
    alice = support["members"][0]
    assert alice["uuid"] == "abc-123"
    assert alice["caller_id_number"] == "+15551112222"
    assert alice["caller_id_name"] == "Alice"
    assert alice["status"] == "WAITING"

    sales = next(q for q in parsed if q["name"] == "fifo_6_sales")
    # no count attr -> depth counted from <caller> elements
    assert sales["depth"] == 2
    assert len(sales["members"]) == 2


def test_parse_single_bare_fifo_element():
    raw = '<fifo name="fifo_5_x"><callers></callers></fifo>'
    parsed = parse_fifo_list(raw)
    assert len(parsed) == 1
    assert parsed[0]["name"] == "fifo_5_x"
    assert parsed[0]["depth"] == 0
    assert parsed[0]["members"] == []


def test_parse_tolerates_ok_envelope_prefix():
    raw = '+OK\n<fifo_report><fifo name="fifo_5_x"></fifo></fifo_report>'
    parsed = parse_fifo_list(raw)
    assert len(parsed) == 1
    assert parsed[0]["name"] == "fifo_5_x"


def test_parse_graceful_on_bad_input():
    assert parse_fifo_list(None) == []
    assert parse_fifo_list("") == []
    assert parse_fifo_list("-ERR no reply") == []
    assert parse_fifo_list("not xml at all") == []
    assert parse_fifo_list("<fifo_report><fifo name=") == []  # truncated/invalid
    assert parse_fifo_list("<fifo_report></fifo_report>") == []  # no fifos


# --------------------------------------------------------------------------
# end-to-end scoping
# --------------------------------------------------------------------------
def test_scope_hides_other_tenant_queues_and_strips_prefix():
    parsed = parse_fifo_list(_synthetic_fifo_list())

    # customer 5 sees only fifo_5_support, display name stripped to "support"
    view5 = scope_queues(parsed, 5)
    assert len(view5) == 1
    assert view5[0]["name"] == "support"
    assert view5[0]["fs_name"] == "fifo_5_support"
    assert view5[0]["customer_id"] == 5
    assert view5[0]["depth"] == 1

    # customer 6 sees only fifo_6_sales
    view6 = scope_queues(parsed, 6)
    assert {q["fs_name"] for q in view6} == {"fifo_6_sales"}
    assert view6[0]["name"] == "sales"

    # admin sees both
    view_admin = scope_queues(parsed, None)
    assert {q["fs_name"] for q in view_admin} == {"fifo_5_support", "fifo_6_sales"}


def test_scope_empty_when_esl_unreachable():
    # _send_esl_command -> None on Docker Desktop -> parse [] -> scope []
    assert scope_queues(parse_fifo_list(None), 5) == []
