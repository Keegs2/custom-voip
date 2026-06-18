"""
trace_model.py -- Phase 0 TwiML execution-trace model.

WHAT THIS IS (and the honest gap it documents)
-----------------------------------------------
The TwiML *parser* in docker/freeswitch/scripts/voice_webhook.lua is executed
for real in this test suite (see lua_parser_harness.lua -- it slices the actual
parse_xml out of the production file and runs it under Lua). That gives us a
byte-exact characterization of how the engine turns XML into a verb tree.

The TwiML *executor* (execute_verbs / execute_say / execute_dial / ...) cannot
be run here: it requires a live FreeSWITCH `session` object, mod_lua, ESL, the
curl API, and a B-leg carrier. So this module is a faithful PYTHON RE-STATEMENT
of the documented execution semantics -- derived by reading execute_verbs and
each execute_* function in voice_webhook.lua. It answers, for a given parsed
verb tree, the question Phase 3+ care about: "what does the engine DO, and what
does it fetch / POST back, in what order?"

It is an APPROXIMATION of the executor, not the executor itself. Its value is as
a committed, deterministic baseline: regenerate it before a refactor, regenerate
after, and diff. If the model and the real engine ever disagree, that is itself a
finding to record.

Engine-level I/O that is identical for every call and therefore NOT repeated in
each per-verb trace:
  * Before the verb list runs, main() POSTs to the customer voice_url with
    CallStatus=ringing (the initial instruction fetch).
  * After the verb list runs, send_status_callback() POSTs to status_callback
    (if configured) with the final CallStatus/Duration/HangupCause.
These are asserted once in test_conformance.py rather than in every fixture.
"""
import json
import re
import subprocess
from pathlib import Path

ENGINE_PATH = (
    Path(__file__).resolve().parents[2]
    / "docker" / "freeswitch" / "scripts" / "handlers" / "api_voice.lua"
)
HARNESS_PATH = Path(__file__).resolve().parent / "lua_parser_harness.lua"

# Placeholder tokens for runtime-dynamic webhook params. The KEYS, method, url,
# and constant values are what matter for before/after diffing; the live values
# (caller number, call sid, ...) are not knowable without a real call.
_BASE_PARAMS = {
    "CallSid": "<call_sid>",
    "AccountSid": "<customer_id>",
    "From": "<from>",
    "To": "<to>",
    "CallStatus": "in-progress",
    "Direction": "<direction>",
}


def lua_available() -> bool:
    from shutil import which
    return which("lua") is not None


def run_parser(xml: str, engine_path: Path = ENGINE_PATH) -> dict:
    """Run the REAL voice_webhook.lua parse_xml over `xml`. Returns the decoded
    JSON dict: {"ok": True, "verbs": [...]} or {"ok": False, "error": "..."}."""
    proc = subprocess.run(
        ["lua", str(HARNESS_PATH), str(engine_path)],
        input=xml.encode("utf-8"),
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"lua harness exited {proc.returncode}: {proc.stderr.decode('utf-8', 'replace')}"
        )
    return json.loads(proc.stdout.decode("utf-8"))


# ---------------------------------------------------------------------------
# URL resolution -- mirrors get_base_url() / resolve_url() in voice_webhook.lua
# ---------------------------------------------------------------------------
def get_base_url(url: str) -> str:
    m = re.match(r"^(https?://[^/]+)", url or "")
    return m.group(1) if m else ""


def resolve_url(url: str, base_url: str) -> str:
    if not url:
        return base_url
    if re.match(r"^https?://", url):
        return url
    base = get_base_url(base_url)
    if base == "":
        return url
    if not url.startswith("/"):
        url = "/" + url
    return base + url


def _int(attrs: dict, key: str, default: int) -> int:
    """Mirror Lua `tonumber(attrs.key) or default`."""
    raw = attrs.get(key)
    if raw is None:
        return default
    try:
        # Lua tonumber accepts ints/floats; engine then uses as-is. We mirror the
        # integer attributes the engine reads (numDigits/timeout/length/loop).
        return int(float(raw))
    except (TypeError, ValueError):
        return default


_HANGUP_REASON_MAP = {
    "completed": "NORMAL_CLEARING",
    "busy": "USER_BUSY",
    "rejected": "CALL_REJECTED",
    "no-answer": "NO_ANSWER",
}
_REJECT_CODE_MAP = {
    "rejected": "403 Forbidden",
    "busy": "486 Busy Here",
}


def approximate_trace(verbs: list, base_url: str) -> list:
    """Re-state execute_verbs() over a parsed verb tree. Returns an ordered list
    of step dicts. Two step shapes:
        {"action": <name>, ...}                      -- a session action
        {"http": {"method","url","params"}}          -- a verb-triggered fetch/POST
    Execution stops (engine `return`) after Hangup, Reject, Redirect, and after
    Gather/Dial when they own an action URL (modeled via "stops_here": True)."""
    trace = []
    for verb in verbs:
        name = verb.get("verb")
        attrs = verb.get("attrs", {})
        text = verb.get("text", "")
        children = verb.get("children", [])

        if name == "Say":
            trace.append({
                "action": "say",
                "text": text,
                "voice": attrs.get("voice", "kal"),
                "language": attrs.get("language", "en"),
                "loop": _int(attrs, "loop", 1),
            })
            # Engine skips Say with empty text (logs warning, no TTS).
            if text == "":
                trace[-1]["skipped_empty"] = True

        elif name == "Play":
            trace.append({
                "action": "play",
                "url": text,
                "loop": _int(attrs, "loop", 1),
            })
            if text == "":
                trace[-1]["skipped_empty"] = True

        elif name == "Pause":
            trace.append({"action": "pause", "length": _int(attrs, "length", 1)})

        elif name == "Hangup":
            reason = attrs.get("reason", "NORMAL_CLEARING")
            trace.append({
                "action": "hangup",
                "reason": reason,
                "fs_cause": _HANGUP_REASON_MAP.get(reason, reason),
                "stops_here": True,
            })
            break

        elif name == "Reject":
            reason = attrs.get("reason", "rejected")
            trace.append({
                "action": "reject",
                "reason": reason,
                "sip": _REJECT_CODE_MAP.get(reason, "403 Forbidden"),
                "stops_here": True,
            })
            break

        elif name == "Redirect":
            if text == "":
                trace.append({"action": "redirect", "skipped_empty": True})
                continue
            url = resolve_url(text, base_url)
            trace.append({"action": "redirect", "url": url, "method": attrs.get("method", "POST")})
            # Engine ALWAYS POSTs (http_post), regardless of the method attr.
            trace.append({"http": {"method": "POST", "url": url, "params": dict(_BASE_PARAMS)}})
            trace[-1]["stops_here"] = True
            break

        elif name == "Gather":
            # Children are played as prompts (Say/Play/Pause); other child verbs
            # are ignored by the engine's prompt loop.
            prompts = []
            for c in children:
                cv = c.get("verb")
                if cv == "Say":
                    prompts.append({"prompt": "say", "text": c.get("text", "")})
                elif cv == "Play":
                    prompts.append({"prompt": "play", "url": c.get("text", "")})
                elif cv == "Pause":
                    prompts.append({"prompt": "pause", "length": _int(c.get("attrs", {}), "length", 1)})
            action_url = attrs.get("action")
            resolved_action = resolve_url(action_url, base_url) if action_url else None
            step = {
                "action": "gather",
                "numDigits": _int(attrs, "numDigits", 128),
                "timeout": _int(attrs, "timeout", 5),
                "finishOnKey": attrs.get("finishOnKey", "#"),
                "method": attrs.get("method", "POST"),
                "prompts": prompts,
                "action_url": resolved_action,
            }
            # Runtime-conditional behavior, captured as metadata (digit input is
            # not knowable offline). Deterministic baseline path = no input ->
            # engine falls through to the next verb.
            if resolved_action:
                step["on_digits"] = {
                    "http": {
                        "method": "POST",
                        "url": resolved_action,
                        "params": {**_BASE_PARAMS, "Digits": "<digits>"},
                    },
                    "then": "execute returned instructions, stop current list",
                }
            else:
                step["on_digits"] = {"store_channel_var": "gathered_digits"}
            trace.append(step)

        elif name == "Dial":
            targets = []
            for c in children:
                if c.get("verb") == "Number" and c.get("text"):
                    targets.append(c.get("text"))
            if text:
                targets.append(text)
            action_url = attrs.get("action")
            resolved_action = resolve_url(action_url, base_url) if action_url else None
            step = {
                "action": "dial",
                "targets": targets,
                "callerId": attrs.get("callerId"),
                "timeout": _int(attrs, "timeout", 30),
                "record": attrs.get("record"),
                "action_url": resolved_action,
            }
            if not targets:
                step["skipped_no_targets"] = True
            trace.append(step)
            if resolved_action:
                # Dial with an action URL POSTs the dial result, then stops.
                trace.append({
                    "http": {
                        "method": "POST",
                        "url": resolved_action,
                        "params": {
                            **_BASE_PARAMS,
                            "DialCallStatus": "<dial_status>",
                            "DialCallDuration": "<dial_duration>",
                        },
                    },
                    "stops_here": True,
                })
                break

        else:
            trace.append({"action": "unknown_verb_skipped", "verb": name})

    return trace
