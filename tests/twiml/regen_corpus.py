"""
regen_corpus.py -- (re)generate the committed TwiML conformance corpus.

Each corpus case is a JSON fixture under tests/twiml/corpus/ that pins:
  * input_xml        -- the TwiML document the customer webhook returned
  * base_url         -- the URL it was fetched from (for relative-URL resolution)
  * expected_parse   -- the verb tree the REAL parser (voice_webhook.lua) produces
                        (filled by running lua_parser_harness.lua -- never hand-typed)
  * expected_trace   -- the execution trace trace_model.approximate_trace predicts
  * classification   -- "correct"  : engine behavior matches TwiML intent
                        "known-bug" : current behavior is wrong; Phase 3 should fix.
                        These are CHARACTERIZATION fixtures: expected_parse is set to
                        whatever the engine does TODAY, even when wrong. The
                        classification + ideal field document the divergence so a
                        later phase can flip the fixture and prove the fix.
  * ideal            -- prose: what a correct engine SHOULD do (only meaningful for
                        known-bug cases; "" for correct cases)

Run:  python3 tests/twiml/regen_corpus.py
This OVERWRITES corpus/*.json from the CASES list below. Requires `lua`.
"""
import json
from pathlib import Path

import trace_model as tm

CORPUS_DIR = Path(__file__).resolve().parent / "corpus"
BASE = "https://voice.example.com/ivr/voice"

# (name, classification, ideal, description, input_xml)
CASES = [
    # ---- Verb / attribute coverage (all 8 verbs) -------------------------
    ("say_basic", "correct", "",
     "Say with default voice(kal)/language(en)/loop(1).",
     "<Response><Say>Hello world</Say></Response>"),

    ("say_attributes", "correct", "",
     "Say with explicit voice, language, loop attributes.",
     '<Response><Say voice="slt" language="es" loop="2">Hola mundo</Say></Response>'),

    ("play_basic", "correct", "",
     "Play an audio URL, default loop=1.",
     "<Response><Play>https://cdn.example.com/welcome.wav</Play></Response>"),

    ("play_loop", "correct", "",
     "Play with loop=3.",
     '<Response><Play loop="3">https://cdn.example.com/beep.wav</Play></Response>'),

    ("pause_basic", "correct", "",
     "Pause with explicit length=3.",
     '<Response><Pause length="3"/></Response>'),

    ("pause_default", "correct", "",
     "Pause with no length -> defaults to 1 second.",
     "<Response><Pause/></Response>"),

    ("hangup_basic", "correct", "",
     "Bare Hangup -> NORMAL_CLEARING, stops execution.",
     "<Response><Hangup/></Response>"),

    ("hangup_reason_busy", "correct", "",
     "Hangup reason=busy maps to USER_BUSY.",
     '<Response><Hangup reason="busy"/></Response>'),

    ("reject_default", "correct", "",
     "Bare Reject -> 403 Forbidden.",
     "<Response><Reject/></Response>"),

    ("reject_busy", "correct", "",
     "Reject reason=busy -> 486 Busy Here.",
     '<Response><Reject reason="busy"/></Response>'),

    ("redirect_relative", "correct", "",
     "Redirect to a relative URL -> resolved against base.",
     "<Response><Redirect>/menu</Redirect></Response>"),

    ("redirect_absolute", "correct", "",
     "Redirect to an absolute URL -> used verbatim.",
     "<Response><Redirect>https://other.example.com/flow</Redirect></Response>"),

    ("redirect_method_get", "known-bug",
     "method=GET is parsed but the engine ALWAYS POSTs (http_post is hardcoded). "
     "A correct engine would issue an HTTP GET when method='GET'.",
     "Redirect with method=GET attribute (parsed, but engine still POSTs).",
     '<Response><Redirect method="GET">/menu</Redirect></Response>'),

    ("gather_with_say_prompt", "correct", "",
     "Gather with a nested Say prompt and an action URL (the canonical IVR case).",
     '<Response><Gather numDigits="1" action="/handle-key" timeout="5">'
     '<Say>Press 1 for sales</Say></Gather></Response>'),

    ("gather_no_children", "correct", "",
     "Gather with no prompt children; collects digits with finishOnKey=*.",
     '<Response><Gather numDigits="4" finishOnKey="*" timeout="8"/></Response>'),

    ("gather_no_action", "correct", "",
     "Gather without action URL -> digits stored in channel var, falls through.",
     '<Response><Gather numDigits="2"/><Say>done</Say></Response>'),

    ("gather_multi_prompt", "correct", "",
     "Gather with Play + Pause + Say prompt children (all three prompt kinds).",
     '<Response><Gather numDigits="1" action="/k">'
     '<Play>https://cdn.example.com/menu.wav</Play>'
     '<Pause length="2"/>'
     '<Say>or stay on the line</Say>'
     '</Gather></Response>'),

    ("dial_text_number", "correct", "",
     "Dial a single number from text content.",
     "<Response><Dial>+15551234567</Dial></Response>"),

    ("dial_number_children", "correct", "",
     "Dial with <Number> children and a callerId attribute.",
     '<Response><Dial callerId="+15550001111">'
     '<Number>+15551112222</Number><Number>+15553334444</Number>'
     '</Dial></Response>'),

    ("dial_with_action", "correct", "",
     "Dial with action URL -> posts DialCallStatus/DialCallDuration after bridge.",
     '<Response><Dial action="/dialed" timeout="20">+15551234567</Dial></Response>'),

    ("sequence_say_pause_say_hangup", "correct", "",
     "Multi-verb ordered sequence; Hangup terminates the list.",
     "<Response><Say>One</Say><Pause length=\"1\"/><Say>Two</Say><Hangup/></Response>"),

    ("empty_response", "correct", "",
     "<Response></Response> -> zero verbs, engine hangs up gracefully.",
     "<Response></Response>"),

    ("self_closing_response", "correct", "",
     "<Response/> self-closing -> zero verbs.",
     "<Response/>"),

    # ---- KNOWN-FRAGILE inputs (characterization for Phase 3) -------------
    ("frag_entity_amp", "known-bug",
     "XML entity &amp; is NOT decoded; the engine speaks the literal text "
     "'Tom &amp; Jerry' (flite says 'amp'). A correct engine would decode to "
     "'Tom & Jerry'.",
     "FRAGILE: named XML entity in Say text is left undecoded.",
     "<Response><Say>Tom &amp; Jerry</Say></Response>"),

    ("frag_entity_numeric", "known-bug",
     "Numeric entity &#123; ('{') is NOT decoded; speaks literal '&#123;'. "
     "A correct engine would decode numeric character references.",
     "FRAGILE: numeric XML entity in Say text is left undecoded.",
     "<Response><Say>Press &#123; now</Say></Response>"),

    ("frag_play_url_entity", "known-bug",
     "&amp; in a Play URL stays literal, so the playback URL becomes "
     "'...?a=1&amp;b=2' instead of '...?a=1&b=2' -> broken query string.",
     "FRAGILE: &amp; in a Play URL is not decoded -> malformed fetch URL.",
     "<Response><Play>https://cdn.example.com/a.wav?a=1&amp;b=2</Play></Response>"),

    ("frag_singlequote_attr", "correct", "",
     "Single-quoted attribute value is supported by the parser.",
     "<Response><Play loop='2'>https://cdn.example.com/x.wav</Play></Response>"),

    ("frag_dquote_in_squote_attr", "correct", "",
     "FRAGILE: embedded double-quote inside a single-quoted attribute is "
     "preserved correctly (the double-quote attr pass does not falsely match).",
     "<Response><Say voice='a\"b'>Hi</Say></Response>"),

    ("frag_grandchild_in_say", "known-bug",
     "2-level nesting only: a <Pause/> grandchild inside <Gather><Say>...</Say> "
     "leaks into the Say's TEXT as literal markup ('Menu <Pause/> end'). The "
     "Pause is neither executed nor stripped; flite would speak the angle "
     "brackets. A correct engine would treat Pause as its own action or strip it.",
     "FRAGILE: grandchild element inside a Gather>Say prompt leaks into text.",
     "<Response><Gather numDigits=\"1\" action=\"/k\">"
     "<Say>Menu <Pause/> end</Say></Gather></Response>"),

    ("frag_missing_close_tag", "known-bug",
     "Unclosed <Say> (no </Say>): parser logs 'missing closing tag, treating "
     "as self-closing', so the Say loses its 'Hello' text entirely, but the "
     "following <Hangup/> is still recognized. A correct engine would either "
     "error or recover the text.",
     "FRAGILE: missing close tag -> Say text dropped, Hangup survives.",
     "<Response><Say>Hello<Hangup/></Response>"),

    ("frag_hyphenated_attrs", "known-bug",
     "Hyphenated attribute names are mis-parsed: 'num-digits' is captured as a "
     "bogus attr 'digits' (suffix after the hyphen) and 'finish-on-key' as 'key'. "
     "numDigits/finishOnKey never get set, so the engine uses defaults "
     "(numDigits=128, finishOnKey='#'). TwiML uses camelCase, but this documents "
     "the silent mis-capture. A correct engine would ignore unknown attrs cleanly.",
     "FRAGILE: hyphenated attribute names captured as wrong attrs.",
     '<Response><Gather num-digits="4" finish-on-key="#"/></Response>'),

    ("frag_unquoted_attr", "known-bug",
     "An unquoted attribute value (length=3) is NOT captured (regex requires "
     "quotes), so Pause falls back to length=1. A correct engine would parse "
     "unquoted values or reject them explicitly.",
     "FRAGILE: unquoted attribute value silently ignored -> default used.",
     "<Response><Pause length=3/></Response>"),

    ("frag_lowercase_response", "known-bug",
     "A lowercase <response> root is not recognized (parser is case-sensitive "
     "on the root only) and the whole document fails to parse ('No <Response> "
     "root element found'). Documented so Phase 3 can decide whether to accept "
     "case-insensitive roots.",
     "FRAGILE: lowercase <response> root -> total parse failure.",
     "<response><Say>hi</Say></response>"),
]


def main():
    CORPUS_DIR.mkdir(parents=True, exist_ok=True)
    if not tm.lua_available():
        raise SystemExit("ERROR: `lua` not found on PATH; cannot fill expected_parse.")

    written = []
    for name, classification, ideal, description, xml in CASES:
        parsed = tm.run_parser(xml)
        if parsed.get("ok"):
            expected_parse = {"ok": True, "verbs": parsed["verbs"]}
            expected_trace = tm.approximate_trace(parsed["verbs"], BASE)
        else:
            # Parse failure is itself the characterized behavior (e.g. frag_lowercase_response).
            expected_parse = {"ok": False, "error": parsed.get("error", "")}
            expected_trace = []

        fixture = {
            "name": name,
            "classification": classification,
            "description": description,
            "ideal": ideal,
            "base_url": BASE,
            "input_xml": xml,
            "expected_parse": expected_parse,
            "expected_trace": expected_trace,
        }
        out = CORPUS_DIR / f"{name}.json"
        out.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n")
        written.append(name)

    print(f"Wrote {len(written)} corpus fixtures to {CORPUS_DIR}")
    for n in written:
        print(f"  - {n}")


if __name__ == "__main__":
    main()
