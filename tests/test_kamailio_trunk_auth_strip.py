"""route[TRUNK_AUTH] spoof-strips the trunk identity headers it appends.

mod_sofia keeps the FIRST instance of a repeated X- header as sip_h_<name>
(sofia.c sofia_handle_sip_i_invite, pinned FreeSWITCH 0a54a48), and Kamailio's
append_hf lumps land after the PBX's own headers — so a PBX-sent X-Trunk-ID /
X-Customer-ID / X-Max-Channels / X-SBC-ID would override ours unless the
received copies are removed first. Static check of docker/kamailio/kamailio.cfg
(no Kamailio needed): every one of the four is remove_hf()'d inside
route[TRUNK_AUTH] BEFORE its append_hf().
"""
import re
from pathlib import Path

CFG = Path(__file__).resolve().parents[1] / "docker" / "kamailio" / "kamailio.cfg"
HEADERS = ("X-Trunk-ID", "X-Customer-ID", "X-Max-Channels", "X-SBC-ID")


def _route_body(name: str) -> str:
    text = CFG.read_text()
    start = text.index(f"route[{name}] {{")
    depth, i = 0, text.index("{", start)
    for j in range(i, len(text)):
        if text[j] == "{":
            depth += 1
        elif text[j] == "}":
            depth -= 1
            if depth == 0:
                return text[i:j]
    raise AssertionError(f"route[{name}] not closed")


def _code(body: str) -> str:
    return "\n".join(line.split("#", 1)[0] for line in body.splitlines())


def test_trunk_auth_strips_before_append():
    code = _code(_route_body("TRUNK_AUTH"))
    for h in HEADERS:
        strip = code.find(f'remove_hf("{h}");')
        append = code.find(f'append_hf("{h}: ')
        assert strip != -1, f"{h} is not spoof-stripped in route[TRUNK_AUTH]"
        assert append != -1, f"{h} is no longer appended in route[TRUNK_AUTH]"
        assert strip < append, f"{h}: remove_hf must come before append_hf"
        assert len(re.findall(rf'append_hf\("{re.escape(h)}: ', code)) == 1, h
