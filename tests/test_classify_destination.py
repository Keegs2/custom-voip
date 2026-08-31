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
