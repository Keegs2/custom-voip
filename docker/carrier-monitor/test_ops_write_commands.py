#!/usr/bin/env python3
"""
test_ops_write_commands.py — offline self-check for the ops-agent WRITE verbs.

Runs with NO live switch. It monkeypatches the two execution primitives in
ops_commands (`_run_argv` for kamcmd, `_run_esl` for FreeSWITCH ESL) so a "run"
captures the argv/verb it WOULD execute instead of touching a real box, then
asserts:

  * every new WRITE command_id is present in the catalog and flagged mutating,
  * WRITE_COMMAND_IDS and the per-spec `mutating` flag agree,
  * each argv/verb builder produces the EXACT expected argv/verb for a good param,
  * each validator REJECTS malformed params (bad UUID / non-IP / out-of-range
    group / bad enum / bad address / bad loglevel / bad tag) with ValueError,
  * role-gating is intact (fs.* only on fs, kamcmd.* only on sbc),
  * the build-time hard-exclusion assertion passes for the real catalog AND fires
    for a deliberately-planted forbidden entry.

Run either way:
    python3 -m pytest -q test_ops_write_commands.py
    python3 test_ops_write_commands.py        # plain-assert fallback, no pytest
"""

import os

# Pin a deterministic role/env BEFORE importing the module (role is detected once
# at import). SBC lets us exercise the kamcmd builders directly; the FS/ESL builders
# are plain functions we call regardless of detected role.
os.environ.setdefault("OPS_AGENT_ROLE", "sbc")
os.environ.setdefault("SBC_PROXY_IP", "10.142.0.100")

import ops_commands as oc  # noqa: E402


# --------------------------------------------------------------------------- #
# Capture harness: swap the execution primitives for recorders.
# --------------------------------------------------------------------------- #

class _Capture:
    """Context manager that patches oc._run_argv / oc._run_esl to record calls."""

    def __init__(self):
        self.argv = None
        self.verb = None

    def __enter__(self):
        self._orig_argv = oc._run_argv
        self._orig_esl = oc._run_esl

        def rec_argv(argv, timeout):
            self.argv = [str(a) for a in argv]
            return True, 0, "", ""

        def rec_esl(verb, timeout):
            self.verb = str(verb)
            return True, 0, "", ""

        oc._run_argv = rec_argv
        oc._run_esl = rec_esl
        return self

    def __exit__(self, *exc):
        oc._run_argv = self._orig_argv
        oc._run_esl = self._orig_esl
        return False


def _argv_for(fn, params):
    with _Capture() as cap:
        fn(params, 10.0)
    return cap.argv


def _verb_for(fn, params):
    with _Capture() as cap:
        fn(params, 10.0)
    return cap.verb


def _expect_valueerror(fn, params, label):
    try:
        with _Capture():
            fn(params, 10.0)
    except ValueError:
        return
    raise AssertionError(f"expected ValueError for {label}: params={params!r}")


_KAM_PREFIX = ["kamcmd", "-s", "unix:/var/run/kamailio/kamailio_ctl"]


# --------------------------------------------------------------------------- #
# 1) Catalog membership + mutating-flag mechanism.
# --------------------------------------------------------------------------- #

_EXPECTED_WRITE_IDS = {
    "fs.uuid_kill",
    "fs.reloadxml",
    "fs.sofia_rescan",
    "fs.loglevel",
    "call.canary",
    "kamcmd.dispatcher.reload",
    "kamcmd.dispatcher.set_state",
    "kamcmd.htable.block",
    "kamcmd.htable.unblock",
}


def test_write_ids_in_catalog_and_flagged():
    for cid in _EXPECTED_WRITE_IDS:
        assert cid in oc.CATALOG, f"{cid} missing from CATALOG"
        assert oc.CATALOG[cid]["mutating"] is True, f"{cid} not mutating=True"
        assert oc.is_mutating(cid), f"is_mutating({cid}) false"
    # The frozenset and the per-spec flag agree exactly.
    assert set(oc.WRITE_COMMAND_IDS) == _EXPECTED_WRITE_IDS
    # Reads stay non-mutating.
    for cid in ("kamcmd.dispatcher_list", "fs.status", "host.docker_ps"):
        assert oc.CATALOG[cid]["mutating"] is False
        assert not oc.is_mutating(cid)


# --------------------------------------------------------------------------- #
# 2) Role-gating.
# --------------------------------------------------------------------------- #

def test_role_gating():
    assert oc.is_valid_for_role("fs.uuid_kill", oc.ROLE_FS)
    assert not oc.is_valid_for_role("fs.uuid_kill", oc.ROLE_SBC)
    assert not oc.is_valid_for_role("fs.uuid_kill", oc.ROLE_SERVICES)
    assert oc.is_valid_for_role("kamcmd.htable.block", oc.ROLE_SBC)
    assert not oc.is_valid_for_role("kamcmd.htable.block", oc.ROLE_FS)
    assert oc.is_valid_for_role("call.canary", oc.ROLE_FS)
    assert not oc.is_valid_for_role("call.canary", oc.ROLE_SBC)


# --------------------------------------------------------------------------- #
# 3) kamcmd WRITE builders — exact argv on good params.
# --------------------------------------------------------------------------- #

def test_dispatcher_reload_argv():
    assert _argv_for(oc._kam_dispatcher_reload, {}) == _KAM_PREFIX + [
        "dispatcher.reload"
    ]


def test_dispatcher_set_state_argv():
    argv = _argv_for(
        oc._kam_dispatcher_set_state,
        {"state": "ap", "group": 2, "address": "sip:67.231.2.12:5060"},
    )
    assert argv == _KAM_PREFIX + [
        "dispatcher.set_state", "ap", "2", "sip:67.231.2.12:5060"
    ]
    # bare host:port is normalized to sip:host:port
    argv2 = _argv_for(
        oc._kam_dispatcher_set_state,
        {"state": "i", "group": 1, "address": "10.142.0.100:5080"},
    )
    assert argv2 == _KAM_PREFIX + [
        "dispatcher.set_state", "i", "1", "sip:10.142.0.100:5080"
    ]
    # bracketed IPv6 with port
    argv3 = _argv_for(
        oc._kam_dispatcher_set_state,
        {"state": "d", "group": 3, "address": "[2001:db8::1]:5060"},
    )
    assert argv3 == _KAM_PREFIX + [
        "dispatcher.set_state", "d", "3", "sip:[2001:db8::1]:5060"
    ]


def test_dispatcher_set_state_rejects_bad():
    _expect_valueerror(oc._kam_dispatcher_set_state,
                       {"state": "x", "group": 2, "address": "sip:1.2.3.4:5060"},
                       "bad state token")
    _expect_valueerror(oc._kam_dispatcher_set_state,
                       {"state": "a", "group": 0, "address": "sip:1.2.3.4:5060"},
                       "group below range")
    _expect_valueerror(oc._kam_dispatcher_set_state,
                       {"state": "a", "group": -1, "address": "sip:1.2.3.4:5060"},
                       "negative group")
    _expect_valueerror(oc._kam_dispatcher_set_state,
                       {"state": "a", "group": "two", "address": "sip:1.2.3.4:5060"},
                       "non-int group")
    _expect_valueerror(oc._kam_dispatcher_set_state,
                       {"state": "a", "group": 2, "address": "1.2.3.4; DROP"},
                       "address with junk")
    _expect_valueerror(oc._kam_dispatcher_set_state,
                       {"state": "a", "group": 2, "address": "999.1.1.1"},
                       "bad IPv4 octet")
    _expect_valueerror(oc._kam_dispatcher_set_state,
                       {"state": "a", "group": 2, "address": "1.2.3.4:99999"},
                       "port out of range")
    _expect_valueerror(oc._kam_dispatcher_set_state,
                       {"state": "a", "group": 2, "address": "2001:db8::1"},
                       "unbracketed IPv6")
    _expect_valueerror(oc._kam_dispatcher_set_state,
                       {"state": "a", "group": 2, "address": ""},
                       "empty address")


def test_htable_block_unblock_argv():
    assert _argv_for(oc._kam_htable_block, {"key": "203.0.113.7"}) == \
        _KAM_PREFIX + ["htable.sht_set", "blocked", "203.0.113.7", "1"]
    assert _argv_for(oc._kam_htable_unblock, {"key": "203.0.113.7"}) == \
        _KAM_PREFIX + ["htable.sht_rm", "blocked", "203.0.113.7"]
    # CIDR accepted + canonicalized (203.0.113.9/24 -> network 203.0.113.0/24).
    assert _argv_for(oc._kam_htable_block, {"key": "203.0.113.9/24"}) == \
        _KAM_PREFIX + ["htable.sht_set", "blocked", "203.0.113.0/24", "1"]
    # IPv6 host.
    assert _argv_for(oc._kam_htable_block, {"key": "2001:db8::5"}) == \
        _KAM_PREFIX + ["htable.sht_set", "blocked", "2001:db8::5", "1"]


def test_htable_rejects_bad_key():
    for bad in ("not-an-ip", "1.2.3.999", "1.2.3.4 5.6.7.8", "", "10.0.0.0/99",
                "; rm -rf /", "1.2.3.4; DROP"):
        _expect_valueerror(oc._kam_htable_block, {"key": bad}, f"bad key {bad!r}")
        _expect_valueerror(oc._kam_htable_unblock, {"key": bad}, f"bad key {bad!r}")


# --------------------------------------------------------------------------- #
# 4) FS ESL WRITE builders — exact verb on good params.
# --------------------------------------------------------------------------- #

def test_fs_uuid_kill_verb():
    good = "11111111-1111-4111-8111-111111111111"
    assert _verb_for(oc._fs_uuid_kill, {"uuid": good}) == f"uuid_kill {good}"


def test_fs_uuid_kill_rejects_bad():
    for bad in ("", "not-a-uuid", "11111111-1111-4111-8111",
                "11111111-1111-4111-8111-111111111111 extra",
                "; reloadxml", "11111111_1111_4111_8111_111111111111"):
        _expect_valueerror(oc._fs_uuid_kill, {"uuid": bad}, f"bad uuid {bad!r}")


def test_fs_reloadxml_verb():
    assert _verb_for(oc._fs_reloadxml, {}) == "reloadxml"


def test_fs_sofia_rescan_verb():
    assert _verb_for(oc._fs_sofia_rescan, {"profile": "internal"}) == \
        "sofia profile internal rescan"
    assert _verb_for(oc._fs_sofia_rescan, {"profile": "external"}) == \
        "sofia profile external rescan"


def test_fs_sofia_rescan_rejects_bad():
    for bad in ("", "gateway", "internal external", "internal;stop",
                "public", "INTERNAL "):
        _expect_valueerror(oc._fs_sofia_rescan, {"profile": bad},
                           f"bad profile {bad!r}")


def test_fs_loglevel_verb_and_range():
    for lvl in range(0, 8):
        assert _verb_for(oc._fs_loglevel, {"level": lvl}) == f"fsctl loglevel {lvl}"
    # Default revert value is 6 (INFO).
    assert oc.FS_DEFAULT_LOGLEVEL == 6
    for bad in (-1, 8, 100, "seven", True, 3.5):
        _expect_valueerror(oc._fs_loglevel, {"level": bad}, f"bad level {bad!r}")


# --------------------------------------------------------------------------- #
# 5) Canary tag validator (the only request-derived canary input).
# --------------------------------------------------------------------------- #

def test_canary_tag_validator():
    assert oc._canary_tag(None) == ""
    assert oc._canary_tag("") == ""
    assert oc._canary_tag("nightly_smoke-1") == "nightly_smoke-1"
    for bad in ("has space", "semi;colon", "quote\"", "x" * 41, "amp&", "$(x)"):
        try:
            oc._canary_tag(bad)
        except ValueError:
            continue
        raise AssertionError(f"expected ValueError for canary tag {bad!r}")


def test_canary_constants_are_safe():
    # Destination is the fixed test DID, never a param. Carrier is primary.
    assert oc.CANARY_DEST == "+16174544217"
    assert oc.CANARY_CARRIER == "primary"
    # The canary can only ever emit a bgapi originate to the fixed DID via the SBC.
    render = oc._render_argv_text("call.canary")
    assert "originate" in render and oc.CANARY_DEST in render
    assert "bgapi" in render  # and it's the ONLY allowed bgapi (asserted below)


# --------------------------------------------------------------------------- #
# 6) Hard-exclusion assertion: passes for real catalog, fires for a bad entry.
# --------------------------------------------------------------------------- #

def test_hard_exclusion_passes_for_real_catalog():
    # Must not raise for the shipped catalog.
    oc.assert_no_forbidden_commands()


def test_hard_exclusion_fires_on_forbidden_entry():
    # Plant a deliberately-dangerous entry, assert the audit rejects it, restore.
    def _bad_shutdown(_p, t):
        return oc._run_esl("fsctl shutdown asap", t)

    def _bad_bgapi(_p, t):
        return oc._run_esl("bgapi originate sofia/x/y &park", t)

    def _bad_hupall(_p, t):
        return oc._run_esl("hupall NORMAL_CLEARING", t)

    for badfn, label in (
        (_bad_shutdown, "shutdown"),
        (_bad_hupall, "hupall"),
    ):
        oc.CATALOG["fs.__evil__"] = oc._fsr(badfn, mutating=True)
        try:
            raised = False
            try:
                oc.assert_no_forbidden_commands()
            except AssertionError:
                raised = True
            assert raised, f"audit failed to reject planted {label} entry"
        finally:
            oc.CATALOG.pop("fs.__evil__", None)

    # Arbitrary (non-canary) bgapi must also be rejected. Add it to WRITE set-safe
    # position; the bgapi branch triggers because the id isn't call.canary.
    oc.CATALOG["fs.__evil_bg__"] = oc._fsr(_bad_bgapi, mutating=True)
    try:
        raised = False
        try:
            oc.assert_no_forbidden_commands()
        except AssertionError:
            raised = True
        assert raised, "audit failed to reject arbitrary bgapi entry"
    finally:
        oc.CATALOG.pop("fs.__evil_bg__", None)

    # After cleanup the real catalog is clean again.
    oc.assert_no_forbidden_commands()


# --------------------------------------------------------------------------- #
# 7) End-to-end dispatch through run_command for a WRITE (with captured exec).
# --------------------------------------------------------------------------- #

def test_run_command_dispatch_write_kamcmd():
    with _Capture() as cap:
        res = oc.run_command(
            "kamcmd.htable.block", {"key": "198.51.100.4"}, oc.ROLE_SBC
        )
    assert res["ok"] is True
    assert cap.argv == _KAM_PREFIX + [
        "htable.sht_set", "blocked", "198.51.100.4", "1"
    ]


def test_run_command_rejects_role_mismatch():
    try:
        oc.run_command("kamcmd.htable.block", {"key": "1.2.3.4"}, oc.ROLE_FS)
    except ValueError:
        return
    raise AssertionError("run_command allowed a role mismatch")


def test_run_command_rejects_unknown():
    try:
        oc.run_command("fs.__nope__", {}, oc.ROLE_FS)
    except ValueError:
        return
    raise AssertionError("run_command allowed an unknown command_id")


# --------------------------------------------------------------------------- #
# Plain-assert runner (no pytest dependency required).
# --------------------------------------------------------------------------- #

def _run_all():
    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    passed = 0
    for t in tests:
        t()
        passed += 1
        print(f"  ok  {t.__name__}")
    print(f"\n{passed}/{len(tests)} tests passed")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(_run_all())
