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

    ("redirect_method_get", "correct", "",
     "Redirect with method=GET: the engine now HONORS the method attribute and "
     "issues an HTTP GET (params in the query string) instead of always POSTing.",
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

    # ---- Previously-fragile inputs, now FIXED in Phase 3 -----------------
    ("frag_entity_amp", "correct", "",
     "Named XML entity &amp; in Say text is now decoded to '&' "
     "(the real parser decodes entities). Engine speaks 'Tom & Jerry'.",
     "<Response><Say>Tom &amp; Jerry</Say></Response>"),

    ("frag_entity_numeric", "correct", "",
     "Numeric character references are now decoded: &#123; -> '{' "
     "(decimal and &#x7B; hex both supported). Engine speaks 'Press { now'.",
     "<Response><Say>Press &#123; now</Say></Response>"),

    ("frag_play_url_entity", "correct", "",
     "&amp; in a Play URL is now decoded, so the playback URL is the correct "
     "'...?a=1&b=2' with a valid query string.",
     "<Response><Play>https://cdn.example.com/a.wav?a=1&amp;b=2</Play></Response>"),

    ("frag_singlequote_attr", "correct", "",
     "Single-quoted attribute value is supported by the parser.",
     "<Response><Play loop='2'>https://cdn.example.com/x.wav</Play></Response>"),

    ("frag_dquote_in_squote_attr", "correct", "",
     "FRAGILE: embedded double-quote inside a single-quoted attribute is "
     "preserved correctly (the double-quote attr pass does not falsely match).",
     "<Response><Say voice='a\"b'>Hi</Say></Response>"),

    ("frag_grandchild_in_say", "correct", "",
     "Arbitrary nesting: a <Pause/> grandchild inside <Gather><Say>...</Say> is "
     "now STRIPPED from the Say's text (the surrounding text is preserved: "
     "'Menu  end'). The inline element no longer leaks as literal markup.",
     "<Response><Gather numDigits=\"1\" action=\"/k\">"
     "<Say>Menu <Pause/> end</Say></Gather></Response>"),

    ("frag_missing_close_tag", "correct", "",
     "Unclosed <Say> (no </Say>) is now rejected LOUDLY by the real parser "
     "(mismatched closing tag), so the engine takes the fallback path instead of "
     "silently dropping text. Malformed XML must never execute partial behavior.",
     "<Response><Say>Hello<Hangup/></Response>"),

    ("frag_hyphenated_attrs", "correct", "",
     "Hyphenated attribute names are now parsed CLEANLY as their real names "
     "(num-digits / finish-on-key). They are simply not TwiML-recognized "
     "(camelCase numDigits/finishOnKey), so the engine ignores them and uses "
     "defaults — no more silent mis-capture into bogus attr names.",
     '<Response><Gather num-digits="4" finish-on-key="#"/></Response>'),

    ("frag_unquoted_attr", "correct", "",
     "An unquoted attribute value (length=3) is now REJECTED explicitly (XML "
     "requires quoted values) -> loud parse error + fallback path, rather than a "
     "silent default. Decision: reject malformed rather than guess.",
     "<Response><Pause length=3/></Response>"),

    ("frag_lowercase_response", "correct", "",
     "DECISION: TwiML is case-sensitive on the root element, so a lowercase "
     "<response> root is rejected LOUDLY (parse error + fallback path) rather "
     "than silently mis-handled. Lowercase verb elements still parse fine and are "
     "skipped gracefully by the executor; only the root is enforced.",
     "<response><Say>hi</Say></response>"),

    # ---- Phase 6: media plane — Record + Stream now IMPLEMENTED -----------
    ("frag_record_verb", "correct", "",
     "Phase 6: standalone <Record> is now implemented via the core FreeSWITCH "
     "`record` app. It writes a WAV to the tenant-scoped shared spool "
     "(/media/spool/recordings/customer_<id>/<uuid>.wav) and POSTs metadata to "
     "the API recordings-ingest. With no action/callback it records then falls "
     "through to the next verb. (playBeep defaults true; maxLength=20 here.)",
     '<Response><Record maxLength="20"/></Response>'),

    ("record_with_action", "correct", "",
     "Phase 6: <Record> with an action URL POSTs RecordingUrl/RecordingDuration/"
     "Digits to the action after recording, executes the returned TwiML, and "
     "stops the current list. recordingStatusCallback fires first (fire-and-forget).",
     '<Response><Record maxLength="30" finishOnKey="#" playBeep="true" '
     'action="/rec-done" recordingStatusCallback="/rec-status"/></Response>'),

    ("stream_start", "correct", "",
     "Phase 6: a top-level <Stream> is a one-way audio fork (Twilio "
     "<Start><Stream> semantics) to a ws/wss URL via mod_audio_stream. It does "
     "NOT block — execution continues to the following verb.",
     '<Response><Stream url="wss://stream.example.com/audio"/>'
     '<Say>streaming started</Say></Response>'),

    ("connect_stream", "correct", "",
     "Phase 6: <Connect><Stream url=.../></Connect> is a bidirectional media "
     "fork that OWNS the call for the streaming lifetime (blocks until hangup), "
     "so execution stops there.",
     '<Response><Connect><Stream url="wss://ai.example.com/ws"/></Connect></Response>'),

    # ---- Phase 7: net-new verbs — Conference / Dial Sip+Client / Enqueue ---
    ("dial_sip_child", "correct", "",
     "Phase 7: <Dial><Sip> now bridges to the SIP URI via the external profile "
     "(sofia/external/sip:...). Previously a known-bug no-op.",
     '<Response><Dial><Sip>sip:alice@example.com</Sip></Dial></Response>'),

    ("dial_sip_auth", "correct", "",
     "Phase 7: <Sip> with username/password attributes adds digest-auth channel "
     "vars (sip_auth_username/sip_auth_password) to the bridge.",
     '<Response><Dial><Sip username="u1" password="p1">sip:pbx@10.0.0.9</Sip>'
     '</Dial></Response>'),

    ("dial_client_child", "correct", "",
     "Phase 7: <Dial><Client> bridges to a registered Verto/WebRTC client "
     "(verto.rtc/<id>@customer_<cid>... with user/ SIP fallback), mirroring the "
     "UCaaS extension bridge.",
     '<Response><Dial><Client>agent7</Client></Dial></Response>'),

    ("dial_sip_and_number", "correct", "",
     "Phase 7: a <Dial> with both a <Number> and a <Sip> child rings them "
     "SEQUENTIALLY (FreeSWITCH '|' failover order: numbers first, then Sip/Client).",
     '<Response><Dial timeout="25"><Number>+15551234567</Number>'
     '<Sip>sip:bob@example.com</Sip></Dial></Response>'),

    ("dial_conference", "correct", "",
     "Phase 7: <Dial><Conference>room</Conference></Dial> joins the customer-scoped "
     "mod_conference room conf_<cid>_room (the SHARED CONTRACT the API controls). "
     "Blocks until the member leaves, then continues.",
     '<Response><Dial><Conference>SalesTeam</Conference></Dial></Response>'),

    ("conference_toplevel", "correct", "",
     "Phase 7: a top-level <Conference> is also accepted (lenient). Name is "
     "sanitized (lowercase, non-alnum -> _) into conf_<cid>_<name>.",
     '<Response><Conference>Test Room 1</Conference></Response>'),

    ("conference_attributes", "correct", "",
     "Phase 7: <Conference> attributes map to mod_conference: muted->+flags{mute}, "
     "startConferenceOnEnter=false->wait-mod, endConferenceOnExit=true->endconf+"
     "moderator, beep/waitUrl/maxParticipants/record all honored.",
     '<Response><Dial><Conference muted="true" beep="false" '
     'startConferenceOnEnter="false" endConferenceOnExit="true" '
     'maxParticipants="10" waitUrl="https://cdn.example.com/hold.wav" '
     'record="record-from-start">support</Conference></Dial></Response>'),

    ("enqueue_basic", "correct", "",
     "Phase 7: <Enqueue>name joins the tenant-scoped mod_fifo queue "
     "fifo_<cid>_<name> (caller side, blocks until dequeued). waitUrl is hold "
     "music. With no action it falls through after dequeue.",
     '<Response><Enqueue waitUrl="https://cdn.example.com/wait.wav">support</Enqueue>'
     '</Response>'),

    ("enqueue_with_action", "correct", "",
     "Phase 7: <Enqueue> with an action URL POSTs QueueResult/QueueSid/QueueTime "
     "after dequeue, executes the returned TwiML, then stops.",
     '<Response><Enqueue action="/queue-done">support</Enqueue></Response>'),

    ("dial_queue", "correct", "",
     "Phase 7: <Dial><Queue>name (agent side) dequeues the longest-waiting caller "
     "from fifo_<cid>_<name> via `fifo <q> out nowait`.",
     '<Response><Dial><Queue>support</Queue></Dial></Response>'),

    # ---- Remaining documented gap (characterization) ---------------------
    ("leave_in_queue_model", "known-bug",
     "<Leave> is accepted as a top-level verb and ends the current document, but "
     "it CANNOT interrupt an in-progress <Enqueue> wait: mod_fifo's `in` app blocks "
     "the caller until an agent dequeues them. Twilio's waitUrl-driven <Leave> "
     "(running TwiML mid-wait) is not supported in the FIFO model.",
     "FUTURE: mid-wait <Leave>/waitUrl TwiML would need a non-blocking queue (e.g. "
     "mod_callcenter with a wait-loop) or a DTMF abort key mapped to fifo exit.",
     '<Response><Leave/></Response>'),
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
