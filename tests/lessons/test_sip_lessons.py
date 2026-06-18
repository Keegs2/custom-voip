"""SIP / FreeSWITCH "hard-won lessons" regression guard.

Phase 0 safety net. Every test below encodes ONE production lesson from
/Users/keegan/revup/CLAUDE.md as a mechanical assertion over the ACTUAL config
or code file the fix lives in. Each test's docstring quotes the lesson. If a
later phase removes or regresses a fix, the corresponding test FAILS — that is
the entire point. These pass against the current tree by construction (they
describe what is shipping today).

Run:
    python3 -m pytest tests/lessons/test_sip_lessons.py -v
"""
import pathlib
import re

import pytest

REPO = pathlib.Path(__file__).resolve().parents[2]

KAM = REPO / "docker" / "kamailio" / "kamailio.cfg"
KAM_ENTRY = REPO / "docker" / "kamailio" / "entrypoint.sh"
FS_INTERNAL = REPO / "docker" / "freeswitch" / "conf" / "sofia" / "internal.xml"
FS_EXTERNAL = REPO / "docker" / "freeswitch" / "conf" / "sofia" / "external.xml"
FS_DOCKERFILE = REPO / "docker" / "freeswitch" / "Dockerfile"
FS_ENTRY = REPO / "docker" / "freeswitch" / "entrypoint.sh"
FS_MODULES = REPO / "docker" / "freeswitch" / "conf" / "autoload_configs" / "modules.conf.xml"
FS_MAIN_XML = REPO / "docker" / "freeswitch" / "conf" / "freeswitch.xml"
INBOUND = REPO / "docker" / "freeswitch" / "scripts" / "inbound_router.lua"
TRUNK = REPO / "docker" / "freeswitch" / "scripts" / "trunk_outbound.lua"
PUBLIC_DP = REPO / "docker" / "freeswitch" / "conf" / "dialplan" / "public.xml"
MEDIA_COMPOSE = REPO / "docker-compose.media.yml"
SBC_COMPOSE = REPO / "docker-compose.sbc.yml"

# Phase 2 refactor: routing logic may live in inbound_router.lua OR be split into
# scripts/handlers/*.lua + scripts/lib/*.lua. These guards search wherever the
# code lives so the lesson stays enforced regardless of file layout.
SCRIPTS_DIR = REPO / "docker" / "freeswitch" / "scripts"
RCF_HANDLER = SCRIPTS_DIR / "handlers" / "rcf.lua"


def all_lua_scripts():
    """Every Lua source under scripts/ (top-level + handlers/ + lib/)."""
    return sorted(SCRIPTS_DIR.rglob("*.lua"))


_cache = {}


def read(path):
    p = pathlib.Path(path)
    if p not in _cache:
        _cache[p] = p.read_text()
    return _cache[p]


def region(text, start_marker, end_marker):
    """Return the slice of `text` between start_marker and the next end_marker."""
    s = text.index(start_marker)
    e = text.index(end_marker, s)
    return text[s:e]


def strip_hash_comments(text):
    """Drop full-line Kamailio '#' comments. Used so assertions about ACTIVE
    config are not fooled by explanatory comment blocks that quote the very
    anti-pattern they warn against (e.g. 'DO NOT use remove_hf("Via")')."""
    return "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))


def strip_lua_comments(text):
    """Remove Lua comments (full-line and inline '--...'). Same rationale: the
    RCF branch documents proxy_media at length in comments while never setting it."""
    out = []
    for line in text.splitlines():
        idx = line.find("--")
        out.append(line if idx < 0 else line[:idx])
    return "\n".join(out)


# =====================================================================
# KAMAILIO SBC LESSONS
# =====================================================================

def test_kam_r2_on_sbc_internal_record_route_only():
    """Double Record-Route: ';r2=on' is REQUIRED on the SBC_INTERNAL entry and
    must NEVER be on the VIP entry. 'Kamailio's rr module consumes the second
    own-Route in one loose_route() pass only when the first consumed Route
    carries the r2 param ... Never put r2=on on the VIP entry: Bandwidth's
    in-dialog requests must pop ONLY the VIP.' (CLAUDE.md)"""
    cfg = read(KAM)
    # A-leg (request_route): SBC_INTERNAL first w/ r2, VIP second.
    assert 'record_route_preset("SBC_INTERNAL_IP:5060;r2=on;lr", "ADVERTISE_IP:5060;lr")' in cfg
    # B-leg (TO_CARRIER): VIP first, SBC_INTERNAL second w/ r2.
    assert 'record_route_preset("ADVERTISE_IP:5060;lr", "SBC_INTERNAL_IP:5060;r2=on;lr")' in cfg
    # r2 is present on SBC_INTERNAL ...
    assert "SBC_INTERNAL_IP:5060;r2=on" in cfg
    # ... and NEVER on the VIP (ADVERTISE_IP) entry.
    assert "ADVERTISE_IP:5060;r2=on" not in cfg


def test_kam_double_record_route_enabled():
    """'Double Record-Route Required for Multi-VM ... enable_double_rr=1 is set,
    and both legs use record_route_preset() with two URIs.' (CLAUDE.md)"""
    cfg = read(KAM)
    assert re.search(r'modparam\(\s*"rr"\s*,\s*"enable_double_rr"\s*,\s*1\s*\)', cfg)
    # Two presets in two routes (A-leg + TO_CARRIER B-leg).
    assert cfg.count("record_route_preset(") >= 2


def test_kam_alias_sbc_internal_ip():
    """'Requires: alias=SBC_INTERNAL_IP:5060 in Kamailio config so loose_route()
    recognizes the inner RR address as local. Without this, Kamailio doesn't
    match the inner RR and creates an infinite routing loop for ACKs.' (CLAUDE.md)"""
    assert "alias=SBC_INTERNAL_IP:5060" in read(KAM)


def test_kam_topoh_module_disabled():
    """'topoh module is disabled. It conflicts with manual header cleanup by
    adding TH= markers. All topology hiding is done via explicit remove_hf() +
    append_hf() + SDP subst_body().' (CLAUDE.md)"""
    cfg = read(KAM)
    # No ACTIVE loadmodule for topoh (commented '# loadmodule' lines are fine).
    assert re.search(r'^\s*loadmodule\s+"topoh\.so"', cfg, re.M) is None


def test_kam_nat_detect_not_applied_to_freeswitch():
    """'NAT detection must NOT apply to FreeSWITCH traffic. force_rport() adds
    ;received=... to FS's Via, leaking Docker IPs. fix_nated_contact() overwrites
    FS's clean Contact... NAT_DETECT is ONLY for inbound from Bandwidth.' (CLAUDE.md)"""
    cfg = read(KAM)
    # The FS->carrier outbound branch must NOT call NAT_DETECT before TO_CARRIER.
    # (Strip comments — that branch's comment block explains why NOT to call it.)
    fs_outbound = strip_hash_comments(
        region(cfg, "OUTBOUND: FreeSWITCH -> Kamailio -> Bandwidth", "route(TO_CARRIER);"))
    assert "route(NAT_DETECT)" not in fs_outbound
    # Re-INVITEs only get NAT_DETECT when the source is NOT internal (carrier).
    assert re.search(
        r'if\s*\(!route\(IS_INTERNAL_SOURCE\)\)\s*\{\s*route\(NAT_DETECT\);',
        cfg,
    )


def test_kam_record_route_after_msg_apply_changes_in_to_carrier():
    """'record_route() must come AFTER msg_apply_changes() in TO_CARRIER. The
    reverse order causes msg_apply_changes() to silently fail ... which means ALL
    header cleanup is silently ignored.' (CLAUDE.md)"""
    body = strip_hash_comments(
        region(read(KAM), "route[TO_CARRIER] {", "# Failure route for outbound carrier"))
    assert body.index("msg_apply_changes()") < body.index("record_route_preset(")


def test_kam_contact_before_msg_apply_changes_in_to_carrier():
    """'Contact must be added BEFORE msg_apply_changes(). The dialog module reads
    Contact during record_route() ... If Contact is absent, you get "bad sip
    message or missing Contact hdr" -> no dialog -> ACK routing breaks -> BYE 404.'
    (CLAUDE.md)"""
    body = strip_hash_comments(
        region(read(KAM), "route[TO_CARRIER] {", "# Failure route for outbound carrier"))
    assert body.index('append_hf("Contact:') < body.index("msg_apply_changes()")


def test_kam_to_carrier_does_not_strip_via():
    """'subst() cannot fix Via corruption ... Solution: Leave FS's Via in place.
    Two Vias is valid per RFC 3261.' TO_CARRIER must NOT remove_hf("Via")."""
    body = strip_hash_comments(
        region(read(KAM), "route[TO_CARRIER] {", "# Failure route for outbound carrier"))
    assert 'remove_hf("Via")' not in body


def test_kam_session_expires_normalized_to_1800_in_reply_handler():
    """'Kamailio REPLY_HANDLER normalizes all carrier Session-Expires to 1800.'
    Bandwidth sometimes sends Session-Expires: 30, below the RFC 4028 minimum of
    90, which FS silently ignores -> the carrier kills the call. (CLAUDE.md)"""
    body = region(read(KAM), "onreply_route[REPLY_HANDLER] {", "# Failure route for dispatcher failover")
    assert 'remove_hf("Session-Expires")' in body
    assert 'append_hf("Session-Expires: 1800;refresher=uac\\r\\n")' in body


def test_kam_bw_dedup_htable_present():
    """'Duplicate INVITEs: Bandwidth sends the same inbound call from multiple
    edge proxies simultaneously ... Kamailio deduplicates via bw_dedup htable
    (key=FromUser::ToUser, TTL=3s), responding 482 Merged to duplicates.' (CLAUDE.md)"""
    cfg = read(KAM)
    assert re.search(r'modparam\(\s*"htable"\s*,\s*"htable"\s*,\s*"bw_dedup=>', cfg)
    assert "$sht(bw_dedup=>$fU::$tU)" in cfg
    assert 'sl_send_reply("482"' in cfg


def test_kam_carrier_422_and_5xx_failover_present():
    """'422 handling: If Bandwidth rejects with 422 ... Kamailio retries with
    Session-Expires: 3600, Min-SE: 900. 5xx failover: On 500/503/408/480/404
    from primary carrier IP, Kamailio fails over to alternate Bandwidth IP (flag
    8 prevents infinite loop).' (CLAUDE.md)"""
    cfg = read(KAM)
    assert "failure_route[CARRIER_FAILURE]" in cfg
    assert 't_check_status("422")' in cfg
    assert 't_check_status("500|503|408|480|404")' in cfg
    assert "setflag(8)" in cfg  # one-shot in-trunk failover guard
    assert "setflag(9)" in cfg  # cross-trunk loop guard


def test_kam_entrypoint_adds_vip_to_loopback():
    """'GCP external passthrough NLBs deliver packets with the destination still
    set to the VIP — the VM kernel only accepts them ... if the VIP is a local
    address.' The SBC entrypoint adds the NLB VIP to loopback. (kamailio/CLAUDE.md)"""
    assert 'ip addr add "${VIP}/32" dev lo' in read(KAM_ENTRY)


# =====================================================================
# FREESWITCH LESSONS
# =====================================================================

def test_fs_two_sofia_profiles_internal_5080_external_5090():
    """'Two sofia profiles required: Internal (5080) receives inbound. External
    (5090) sends outbound. The internal profile does NOT apply ext-sip-ip to
    outbound Via/Contact — that's why external exists.' (CLAUDE.md)"""
    assert 'profile name="internal"' in read(FS_INTERNAL)
    assert 'internal_sip_port=5080' in read(FS_MAIN_XML)
    assert 'name="sip-port" value="$${internal_sip_port}"' in read(FS_INTERNAL)
    assert 'profile name="external"' in read(FS_EXTERNAL)
    assert 'name="sip-port" value="5090"' in read(FS_EXTERNAL)


def test_fs_local_network_acl_loopback_auto_on_both_profiles():
    """'local-network-acl=loopback.auto: Required on both FS sofia profiles.
    Without it, Kamailio's 172.28.0.1 is treated as "local" and SDP gets the
    private IP instead of ext-rtp-ip.' (CLAUDE.md)"""
    needle = 'name="local-network-acl" value="loopback.auto"'
    assert needle in read(FS_INTERNAL)
    assert needle in read(FS_EXTERNAL)


def test_fs_minimum_session_expires_90_on_both_profiles():
    """'FreeSWITCH has minimum-session-expires=90 and silently ignores any value
    below that.' Both profiles must pin minimum-session-expires=90. (CLAUDE.md)"""
    needle = 'name="minimum-session-expires" value="90"'
    assert needle in read(FS_INTERNAL)
    assert needle in read(FS_EXTERNAL)


def test_fs_no_nonat_flag_in_cmd():
    """'FS -nonat flag: Do NOT use it. Disables ext-rtp-ip/ext-sip-ip processing,
    causing SDP to contain Docker internal IPs instead of public IP.' (CLAUDE.md)"""
    cmd_line = next(l for l in read(FS_DOCKERFILE).splitlines() if l.strip().startswith("CMD ["))
    assert "-nonat" not in cmd_line
    # And nothing in the media compose re-adds it.
    assert "-nonat" not in read(MEDIA_COMPOSE)


def test_fs_no_proxy_media_in_rcf_bridge_path():
    """'No proxy_media in RCF path. Default media mode works correctly.
    proxy_media was removed after the Cloud NAT fix.' Only the TRUNK path sets
    proxy_media. (CLAUDE.md / scripts/CLAUDE.md)"""
    # The RCF bridge logic lives either in handlers/rcf.lua (post Phase 2 split)
    # or in the rcf branch of inbound_router.lua (pre-split). Check wherever it is.
    if RCF_HANDLER.exists():
        rcf_branch = strip_lua_comments(read(RCF_HANDLER))
    else:
        rcf_branch = strip_lua_comments(
            region(read(INBOUND), 'if product_type == "rcf" then',
                   'elseif product_type == "api" then'))
    assert "proxy_media" not in rcf_branch
    # Sanity: the trunk path DOES still set it somewhere (so the test is meaningful).
    assert any('set_var("proxy_media", "true")' in read(p) for p in all_lua_scripts())


def test_fs_mod_local_stream_disabled_and_silence_stream_used():
    """'mod_local_stream disabled. Requires local_stream.conf.xml which doesn't
    exist ... RCF uses silence_stream://-1 instead.' (CLAUDE.md)"""
    modules = read(FS_MODULES)
    # No ACTIVE load line (commented '<!-- <load .../> -->' is fine).
    assert re.search(r'^\s*<load module="mod_local_stream"/>', modules, re.M) is None
    assert "silence_stream://" in read(FS_INTERNAL)


def test_fs_entrypoint_hairpin_loopback():
    """'GCE Hairpin NAT ... The entrypoint.sh adds the public IP to the loopback
    interface: ip addr add "${PUBLIC_IP}/32" dev lo.' (CLAUDE.md)"""
    assert 'ip addr add "${PUBLIC_IP}/32" dev lo' in read(FS_ENTRY)


def test_fs_rtp_keepalive_on_both_profiles():
    """'FreeSWITCH: rtp-keepalive-sec=15 sends comfort packets to keep RTP
    pinholes open' against GCE's 30-second UDP idle timeout. (CLAUDE.md)"""
    needle = 'name="rtp-keepalive-sec" value="15"'
    assert needle in read(FS_INTERNAL)
    assert needle in read(FS_EXTERNAL)


def test_fs_healthcheck_uses_esl_password():
    """'ESL password in health checks: fs_cli needs -p $ESL_PASSWORD. Without it,
    health check fails, Docker restarts FS, orphaned processes hold ports.'
    (CLAUDE.md)"""
    compose = read(MEDIA_COMPOSE)
    hc = next(l for l in compose.splitlines() if "fs_cli" in l)
    assert "-p $ESL_PASSWORD" in hc
    assert "sofia status" in hc


def test_fs_no_gateway_bridge_syntax():
    """'Gateway syntax deprecated. All outbound bridges use
    sofia/external/dest@proxy:5060 ... The old sofia/gateway/carrier/dest syntax
    produced corrupted Contact headers.' (CLAUDE.md)"""
    # No outbound-bridge script (top-level, handlers/, or lib/) may use gateway syntax.
    saw_external = False
    for path in all_lua_scripts():
        for line in read(path).splitlines():
            if line.strip().startswith("--"):
                continue  # Lua comment
            assert "sofia/gateway/" not in line, f"gateway syntax in {path}: {line}"
        if "sofia/external/" in read(path):
            saw_external = True
    assert saw_external, "no sofia/external/ bridge found in any script"


def test_fs_session_timer_export_in_lua():
    """'FS exports sip_session_timeout=1800 and sip_min_session_expires=90 to the
    B-leg.' set_var only sets the A-leg; export propagates to B-leg. (CLAUDE.md)"""
    # The session-timer export may be inline (inbound_router/trunk_outbound) or
    # consolidated into a lib/ helper after the Phase 2 split. Assert it survives
    # somewhere in the routing code for both the inbound and trunk paths.
    blob = "\n".join(read(p) for p in all_lua_scripts())
    assert 'export", "sip_session_timeout=1800"' in blob
    assert 'export", "sip_minimum_session_expires=90"' in blob


def test_compose_net_admin_capability_for_loopback_add():
    """The loopback IP adds (GCE hairpin NAT on media, NLB VIP on SBC) 'Require
    NET_ADMIN Docker capability.' (CLAUDE.md)"""
    assert "NET_ADMIN" in read(MEDIA_COMPOSE)
    assert "NET_ADMIN" in read(SBC_COMPOSE)


@pytest.mark.skip(reason=(
    "Non-mechanical lesson: 'FreeSWITCH CANNOT generate Session-Expires or "
    "Min-SE from channel variables — a build/version limitation, so Kamailio "
    "adds the RFC 4028 headers at the SBC layer.' This is a runtime behavior of "
    "the compiled mod_sofia binary, not a config string, so it cannot be "
    "asserted by static file inspection. Verify with a live SIPp/Homer capture "
    "(see docker/sipp/scenarios) that the FS->carrier INVITE has no "
    "Session-Expires until Kamailio's TO_CARRIER adds 'Session-Expires: 1800'."
))
def test_fs_cannot_emit_session_expires_runtime_only():
    pass
