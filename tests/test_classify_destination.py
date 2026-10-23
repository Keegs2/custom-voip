"""classify_destination (lib/number_utils.lua) — toll-free vs LD classifier.

Drives the REAL Lua module under a standalone `lua` interpreter (no
FreeSWITCH, no DB — same spirit as tests/lua/onnet_router_harness.lua) and
asserts the termination traffic-class contract that migration 44 +
inbound_router.lua's trunk filter ride on:

  * NANP 8YY (800/833/844/855/866/877/888 + exactly 7 digits) -> 'tollfree'
    in every accepted input form: bare 10-digit, 11-digit with leading 1,
    +1 E.164, and formatted variants (digits are collapsed first, so the
    classifier is STRICTLY WIDER than the naive regex
    ^\\+?1?8(00|88|77|66|55|44|33)\\d{7}$ — it also classifies formatted
    input like '(800) 555-1234', which the regex would miss).
  * EVERYTHING else -> 'ld': non-8YY NANP, unassigned 8YY NPAs (822...),
    international (+44..., even +44 800...), short/long digit runs, empty,
    nil. 'ld' is the safe default — the consumer treats 'ld' as the
    unrestricted class, so a misparse can never route an LD call onto the
    tollfree-only Sinch OSAO trunk (contract requirement).

Skips when no `lua` interpreter is on PATH (CI without Lua). Run:
    python3 -m pytest tests/test_classify_destination.py -q
"""
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
NUMBER_UTILS = REPO / "docker" / "freeswitch" / "scripts" / "lib" / "number_utils.lua"

LUA = shutil.which("lua") or shutil.which("lua5.4") or shutil.which("lua5.3") \
    or shutil.which("lua5.1") or shutil.which("luajit")

TOLLFREE_NPAS = ("800", "833", "844", "855", "866", "877", "888")


def _vectors():
    """(Lua input expression, expected class) pairs."""
    v = []
    for npa in TOLLFREE_NPAS:
        v.append((f'"{npa}5551234"', "tollfree"))    # bare 10-digit
        v.append((f'"1{npa}5551234"', "tollfree"))   # 11-digit, leading 1
        v.append((f'"+1{npa}5551234"', "tollfree"))  # +1 E.164
    v += [
        ('"(800) 555-1234"', "tollfree"),  # formatted (digit-collapse)
        ('"+8005551234"', "tollfree"),     # '+' + bare 10 digits (regex parity)
        ("8005551234", "tollfree"),        # numeric scalar (defensive tostring)
        # --- ld: everything else ---
        ('"8225551234"', "ld"),            # reserved-but-unassigned 8YY NPA
        ('"8125551234"', "ld"),            # ordinary NANP 812
        ('"18125551234"', "ld"),
        ('"+18125551234"', "ld"),
        ('"+17744045256"', "ld"),          # live test DID form
        ('"+447911123456"', "ld"),         # international
        ('"+448005551234"', "ld"),         # international containing '800'
        ('"800555123"', "ld"),             # 9 digits — too short
        ('"80055512345"', "ld"),           # 11 digits, no leading 1
        ('"18005551234567"', "ld"),        # too long
        ('"1800555123"', "ld"),            # 10 digits starting 1 (NPA '180')
        ('""', "ld"),                      # empty
        ("nil", "ld"),                     # nil
    ]
    return v


@pytest.mark.skipif(LUA is None, reason="no lua interpreter on PATH")
def test_classify_destination_vectors(tmp_path):
    checks = "\n".join(
        f'check({expr}, "{expected}")' for expr, expected in _vectors())
    script = tmp_path / "classify_check.lua"
    script.write_text(f"""
local nu = dofile({str(NUMBER_UTILS)!r})
local failures = 0
local function check(input, expected)
    local got = nu.classify_destination(input)
    if got ~= expected then
        failures = failures + 1
        io.stderr:write(string.format("FAIL: classify_destination(%s) = %s, expected %s\\n",
            tostring(input), tostring(got), tostring(expected)))
    end
end
{checks}
if failures > 0 then os.exit(1) end
print("OK")
""")
    result = subprocess.run(
        [LUA, str(script)], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, f"stderr:\n{result.stderr}"
    assert "OK" in result.stdout


@pytest.mark.skipif(LUA is None, reason="no lua interpreter on PATH")
def test_classifier_is_pure_and_deterministic(tmp_path):
    """Same input, same answer, no state: 1000 mixed calls in one VM."""
    script = tmp_path / "classify_pure.lua"
    script.write_text(f"""
local nu = dofile({str(NUMBER_UTILS)!r})
for i = 1, 1000 do
    assert(nu.classify_destination("+18885551234") == "tollfree")
    assert(nu.classify_destination("+17744045256") == "ld")
end
print("OK")
""")
    result = subprocess.run(
        [LUA, str(script)], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, f"stderr:\n{result.stderr}"


# ---------------------------------------------------------------------------
# Cross-component coupling (strict-TF 2026-10): the Kamailio SBC's toll-free
# INGRESS classifier (kamailio.cfg route[TF_CLASSIFY], TF_INGRESS_ENFORCE)
# and the FreeSWITCH EGRESS classifier must agree on the 8YY NPA set — a
# mismatch admits a TF call on one side that the other misroutes/rejects.
# ---------------------------------------------------------------------------
import re  # noqa: E402

# The FreeSWITCH egress fallback NPA set lives in the shared termination lib
# (used by inbound_router.lua, trunk_outbound.lua and api_outbound.lua).
TERM_TRUNKS_LIB = REPO / "docker" / "freeswitch" / "scripts" / "lib" / "term_trunks.lua"
KAMAILIO_CFG = REPO / "docker" / "kamailio" / "kamailio.cfg"


def _lua_npa_table(text, name):
    m = re.search(name + r"\s*=\s*\{(.*?)\}", text, re.S)
    assert m, f"{name} table not found"
    return set(re.findall(r'\["(\d{3})"\]\s*=\s*true', m.group(1)))


def _kamailio_tf_regex():
    text = KAMAILIO_CFG.read_text()
    m = re.search(r"route\[TF_CLASSIFY\]\s*\{(.*?)\n\}", text, re.S)
    assert m, "route[TF_CLASSIFY] not found in kamailio.cfg"
    body = m.group(1)
    r = re.search(r'=~\s*"([^"]+)"', body)
    assert r, "TF_CLASSIFY regex not found"
    return r.group(1)


def test_tollfree_npa_sets_in_sync():
    want = set(TOLLFREE_NPAS)
    assert _lua_npa_table(NUMBER_UTILS.read_text(), "TOLLFREE_NPAS") == want
    assert _lua_npa_table(TERM_TRUNKS_LIB.read_text(), "TOLLFREE_NPAS_FALLBACK") == want
    rx = _kamailio_tf_regex()
    alt = re.search(r"8\(([0-9|]+)\)", rx)
    assert alt, rx
    assert {"8" + x for x in alt.group(1).split("|")} == want


def _kamailio_classify(ruser):
    """Python emulation of route[TF_CLASSIFY]: the POSIX ERE applied to the
    raw R-URI user (the pattern uses only ERE constructs Python `re` shares)."""
    return "tollfree" if re.search(_kamailio_tf_regex(), ruser) else "ld"


def test_kamailio_tf_regex_matches_lua_vectors():
    # Every unformatted string vector (an R-URI user is never formatted;
    # the Lua side's digit-collapse of '(800) 555-1234' is strictly wider).
    for expr, expected in _vectors():
        if not (expr.startswith('"') and expr.endswith('"')):
            continue  # numeric scalar / nil — not R-URI user shapes
        s = expr[1:-1]
        if not re.fullmatch(r"\+?\d*", s):
            continue  # formatted input
        assert _kamailio_classify(s) == expected, (s, expected)
    # user-part parameters (tel-style ;npdi / ;rn=) are tolerated
    assert _kamailio_classify("+18005551234;npdi") == "tollfree"
    assert _kamailio_classify("8885551234;rn=+18885550000") == "tollfree"
    assert _kamailio_classify("+17744045256;npdi") == "ld"
