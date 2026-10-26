"""Flow assistant API (routers/ivr_assist.py + the routers/ivr.py extensions) on PostgreSQL 16.

The Visual IVR harness (tests/test_ivr_api.py: real init scripts, 54/56,
59/60/61, the api pool as the runtime ``api`` role, the REAL JWT middleware)
with both IVR routers mounted, and a fake TED behind ``ted_client.TRANSPORT``
(tests/ivr_assist_fake_ted.py — no network). Contract
docs/IVR_ASSIST_INTERFACES.md §5 / §5.1 / §8:

  * availability: platform flag, customer opt-in, TED configured, IVR
    entitlement -> ``summary.assist.available`` and 403 on POST;
  * the job end to end (202 -> poll -> proposal), state in ivr_assist_jobs,
    no phone number of the customer in any TED request;
  * tenancy / IDOR (another tenant's flow or job -> 404), readonly 403, admin
    without customer -> 400, support 403;
  * one running job per flow (409), staleness (300 s -> failed), the daily
    cap, the per-user rate limit, the 90-day retention batch;
  * TED errors -> the §5.3 job codes and customer text, repair loop bounds;
  * conversations (history, stable [N] aliases, 24 h), refine, outcome
    (once; a different later outcome -> 409), simulate with assist_job_id;
  * the admin opt-in and its backward compatibility (a pre-61 schema:
    tests/test_ivr_assist_pre61.py).
"""
from __future__ import annotations

import asyncio
import json
import re
import sys
import uuid
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ivr_assist_fake_ted as fake  # noqa: E402
from test_ivr_api import A_IVR, A_RCF, A_VM, CUST_OFF, IvrHarness  # noqa: E402
from voicemail_api_harness import CUST_A, CUST_B  # noqa: E402

PORT = 55523            # IVR range 55520-55529

AT = "2026-11-04T15:00:00Z"


class AssistHarness(IvrHarness):
    async def _setup(self) -> None:
        await super()._setup()
        conn = await self.owner()
        try:
            await conn.execute(
                f"UPDATE customers SET ivr_enabled = true, ivr_assist_enabled = true "
                f"WHERE id IN ({CUST_A}, {CUST_B})")
        finally:
            await conn.close()

    @staticmethod
    def build_app():
        app = IvrHarness.build_app()
        from routers import ivr_assist
        app.include_router(ivr_assist.router, prefix="/v1/ivr")
        app.include_router(ivr_assist.router, prefix="/ivr")
        return app


TED = fake.FakeTed()


@pytest.fixture(scope="module")
def h():
    harness = AssistHarness(PORT).start()
    try:
        yield harness
    finally:
        harness.stop()


@pytest.fixture(autouse=True)
def assist_env(monkeypatch):
    from services.ivr.assist import jobs, ted_client
    fake.configure_env(monkeypatch)
    monkeypatch.setenv("IVR_ASSIST_DAILY_PER_CUSTOMER", "1000")
    monkeypatch.setattr(ted_client, "TRANSPORT", TED.transport())
    TED.reset()
    jobs.rate_limiter.reset()
    yield
    jobs.rate_limiter.reset()


def run(h, coro):
    return h.run(coro)


def api(h, method, path, who="user_a", **kw):
    headers = h.auth(who) if who else {}
    return run(h, h.client.request(method, path, headers=headers, **kw))


def idle(h):
    from services.ivr.assist import jobs
    run(h, jobs.wait_idle())


def new_flow(h, who="user_a", name=None):
    r = api(h, "POST", "/v1/ivr/flows", who, json={"name": name or f"Flow {uuid.uuid4().hex[:6]}"})
    assert r.status_code == 201, r.text
    return r.json()


def ask(h, flow_id, message="Press 1 for the front desk.", who="user_a", **body):
    return api(h, "POST", f"/v1/ivr/flows/{flow_id}/assist", who,
               json={"message": message, **body})


def job(h, flow_id, job_id, who="user_a"):
    r = api(h, "GET", f"/v1/ivr/flows/{flow_id}/assist/{job_id}", who)
    assert r.status_code == 200, r.text
    return r.json()


def ask_done(h, flow_id, message="Press 1 for the front desk.", **body):
    r = ask(h, flow_id, message, **body)
    assert r.status_code == 202, r.text
    idle(h)
    return r.json(), job(h, flow_id, r.json()["job_id"])


def db_job(h, job_id):
    rows = run(h, h.fetch("SELECT * FROM ivr_assist_jobs WHERE id = $1::uuid", job_id))
    return rows[0] if rows else None


def summary_available(h, who="user_a", query=""):
    r = api(h, "GET", f"/v1/ivr/summary{query}", who)
    assert r.status_code == 200, r.text
    return r.json()["assist"]["available"]


# ---------------------------------------------------------------------------
# Availability (§5 summary, §8)
# ---------------------------------------------------------------------------
def test_available_only_with_flag_opt_in_ted_and_ivr(h, monkeypatch):
    flow = new_flow(h)
    assert summary_available(h) is True
    monkeypatch.setenv("IVR_ASSIST_ENABLED", "false")
    assert summary_available(h) is False
    r = ask(h, flow["id"])
    assert r.status_code == 403 and r.json()["detail"] == "ivr_assist_not_enabled"
    monkeypatch.setenv("IVR_ASSIST_ENABLED", "true")
    monkeypatch.delenv("TED_IVR_ASSIST_TOKEN")
    assert summary_available(h) is False
    assert ask(h, flow["id"]).json()["detail"] == "ivr_assist_not_enabled"
    fake.configure_env(monkeypatch)
    monkeypatch.setenv("TED_BASE_URL", "http://ted.example.com")    # plain http, public host
    assert summary_available(h) is False
    fake.configure_env(monkeypatch)
    run(h, h.fetchval(f"UPDATE customers SET ivr_assist_enabled = false WHERE id = {CUST_A} "
                      "RETURNING id"))
    try:
        assert summary_available(h) is False
        assert ask(h, flow["id"]).status_code == 403
    finally:
        run(h, h.fetchval(f"UPDATE customers SET ivr_assist_enabled = true WHERE id = {CUST_A} "
                          "RETURNING id"))
    # never entitled to IVR: summary says unavailable, every route is ivr_not_enabled
    assert summary_available(h, "user_off") is False
    r = api(h, "POST", f"/v1/ivr/flows/{flow['id']}/assist", "user_off", json={"message": "x"})
    assert r.status_code == 403 and r.json()["detail"] == "ivr_not_enabled"
    assert TED.requests == []


def test_ivr_off_keeps_the_opt_in_but_makes_it_unavailable(h):
    r = api(h, "PUT", f"/v1/ivr/admin/customers/{CUST_B}/entitlement", "admin",
            json={"enabled": False})
    assert r.json() == {"ivr_enabled": False, "ivr_assist_enabled": True}
    assert summary_available(h, "user_b") is False
    r = api(h, "PUT", f"/v1/ivr/admin/customers/{CUST_B}/entitlement", "admin",
            json={"enabled": True})
    assert r.json() == {"ivr_enabled": True, "ivr_assist_enabled": True}
    assert summary_available(h, "user_b") is True


# ---------------------------------------------------------------------------
# Admin opt-in (§8) + backward compatibility
# ---------------------------------------------------------------------------
def test_admin_opt_in_and_backward_compatible_entitlement(h):
    path = f"/v1/ivr/admin/customers/{CUST_OFF}/entitlement"
    assert api(h, "GET", f"/v1/ivr/admin/customers/{CUST_OFF}", "admin").json()[
        "ivr_assist_enabled"] is False
    # an old caller (TED before the switch) sends only enabled
    r = api(h, "PUT", path, "admin", json={"enabled": True})
    assert r.status_code == 200 and r.json() == {"ivr_enabled": True, "ivr_assist_enabled": False}
    r = api(h, "PUT", path, "admin", json={"assist_enabled": True})
    assert r.json() == {"ivr_enabled": True, "ivr_assist_enabled": True}
    assert api(h, "GET", f"/v1/ivr/admin/customers/{CUST_OFF}", "admin").json()[
        "ivr_assist_enabled"] is True
    r = api(h, "PUT", path, "admin", json={"enabled": False, "assist_enabled": False})
    assert r.json() == {"ivr_enabled": False, "ivr_assist_enabled": False}
    for body in ({}, {"enabled": None}, {"assist_enabled": None}, {"assist_enabled": [1]}):
        assert api(h, "PUT", path, "admin", json=body).status_code == 422, body
    assert api(h, "PUT", path, "user_a", json={"assist_enabled": True}).status_code == 403
    assert api(h, "PUT", "/v1/ivr/admin/customers/999999/entitlement", "admin",
               json={"assist_enabled": True}).status_code == 404


# ---------------------------------------------------------------------------
# The job end to end
# ---------------------------------------------------------------------------
def test_job_end_to_end_and_no_phone_number_reaches_ted(h):
    # an IVR number bound to this flow -> this_flow in the request
    r = api(h, "POST", f"/v1/numbers/{A_IVR}/assign", "admin",
            json={"customer_id": CUST_A, "product_type": "ivr", "name": "Main line"})
    assert r.status_code == 200, r.text
    flow = new_flow(h)
    nid = run(h, h.fetchval("SELECT id FROM ivr_numbers WHERE did = $1", A_IVR))
    assert api(h, "PUT", f"/v1/ivr/numbers/{nid}", json={"flow_id": flow["id"]}).status_code == 200
    started, out = ask_done(h, flow["id"], f"Press 1 for {A_RCF[2:]} and 2 for (508) 555-2199.")
    assert set(started) == {"job_id", "conversation_id"}
    assert uuid.UUID(started["job_id"]).version == 4
    assert out["status"] == "done" and out["conversation_id"] == started["conversation_id"]
    assert out["elapsed_ms"] >= 0 and "error" not in out
    result = out["result"]
    assert result["kind"] == "proposal" and result["issues"] == []
    assert [np["placeholder_id"] for np in result["new_prompts"]] == [-1, -2]
    assert all(n["position"] == {"x": 0, "y": 0} for n in result["draft_graph"]["nodes"])
    # the scripted provider rang every usable destination: own numbers only, never this flow
    targets = [n["data"]["config"].get("target", {}).get("did")
               or n["data"]["config"].get("did") for n in result["draft_graph"]["nodes"]
               if n["type"] in ("dial", "voicemail")]
    assert set(targets) == {A_RCF, A_VM}
    req = TED.requests[0]
    assert req["message"] == "Press 1 for [D1] and 2 for [N1]."
    assert [(d["alias"], d["product"], d["this_flow"]) for d in req["destinations"]] == [
        ("D1", "rcf", False), ("D2", "voicemail", False), ("D3", "ivr", True)]
    blob = json.dumps({k: v for k, v in req.items() if k not in ("request_id",
                                                                 "conversation_id")})
    for number in (A_RCF, A_VM, A_IVR, "+15085552199"):
        assert number[2:] not in blob and number[-7:] not in blob
    assert not re.search(r"\d{7,}", blob)
    row = db_job(h, started["job_id"])
    assert (row["status"], row["rounds"], len(row["ted_request_ids"])) == ("done", 1, 1)
    assert row["ted_request_ids"][0] == req["request_id"]
    assert row["message"] == f"Press 1 for {A_RCF[2:]} and 2 for (508) 555-2199."
    stored = json.loads(row["result"])
    assert stored["public"] == result
    assert stored["state"]["external_numbers"] == ["+15085552199"]
    assert row["user_id"] == 50 and row["finished_at"] is not None


def test_tenancy_idor_and_roles(h):
    flow_a, flow_b = new_flow(h), new_flow(h, "user_b")
    started, _ = ask_done(h, flow_a["id"])
    jid = started["job_id"]
    # another tenant's flow -> 404 (POST, GET, outcome); their own flow + A's job -> 404
    assert ask(h, flow_a["id"], who="user_b").status_code == 404
    assert api(h, "GET", f"/v1/ivr/flows/{flow_a['id']}/assist/{jid}", "user_b").status_code \
        == 404
    assert api(h, "GET", f"/v1/ivr/flows/{flow_b['id']}/assist/{jid}", "user_b").status_code \
        == 404
    assert api(h, "POST", f"/v1/ivr/flows/{flow_b['id']}/assist/{jid}/outcome", "user_b",
               json={"outcome": "discarded"}).status_code == 404
    # another of A's flows + this job -> 404 too (a job belongs to one flow)
    other = new_flow(h)
    assert api(h, "GET", f"/v1/ivr/flows/{other['id']}/assist/{jid}").status_code == 404
    assert api(h, "GET", f"/v1/ivr/flows/{flow_a['id']}/assist/not-a-uuid").status_code == 404
    assert api(h, "GET", f"/v1/ivr/flows/{flow_a['id']}/assist/{uuid.uuid4()}").status_code \
        == 404
    # readonly: may read and simulate, never ask or record an outcome
    assert ask(h, flow_a["id"], who="ro_a").status_code == 403
    assert api(h, "GET", f"/v1/ivr/flows/{flow_a['id']}/assist/{jid}", "ro_a").status_code == 200
    assert api(h, "POST", f"/v1/ivr/flows/{flow_a['id']}/assist/{jid}/outcome", "ro_a",
               json={"outcome": "accepted"}).status_code == 403
    r = api(h, "POST", f"/v1/ivr/flows/{flow_a['id']}/simulate", "ro_a",
            json={"assist_job_id": jid, "caller": "+15085551212", "at": AT, "digits": ["1"]})
    assert r.status_code == 200, r.text
    # admin without a customer -> 400; with ?customer_id= -> acts for that customer
    assert ask(h, flow_a["id"], who="admin").status_code == 400
    r = api(h, "GET", f"/v1/ivr/flows/{flow_a['id']}/assist/{jid}?customer_id={CUST_A}", "admin")
    assert r.status_code == 200
    assert api(h, "GET", f"/v1/ivr/flows/{flow_a['id']}/assist/{jid}?customer_id={CUST_B}",
               "admin").status_code == 404
    assert ask(h, flow_a["id"], who="support").status_code == 403
    assert ask(h, flow_a["id"], who=None).status_code == 401
    r = api(h, "POST", f"/v1/ivr/flows/{flow_a['id']}/assist?customer_id={CUST_A}", "admin",
            json={"message": "Press 1 for billing."})
    assert r.status_code == 202, r.text
    idle(h)
    assert db_job(h, r.json()["job_id"])["user_id"] == 1


def test_message_and_draft_validation(h):
    flow = new_flow(h)
    for message in ("", "   ", "x" * 2001):
        assert ask(h, flow["id"], message).status_code == 422
    assert ask(h, flow["id"], "x" * 2000).status_code == 202
    idle(h)
    r = ask(h, flow["id"], draft_graph={"schemaVersion": 1, "nodes": [], "edges": []})
    assert r.status_code == 422 and r.json()["detail"] == "invalid_graph"
    big = {"schemaVersion": 1, "nodes": [{"id": "n_start", "type": "entry",
                                          "data": {"config": {}}}] +
           [{"id": f"n{i}", "type": "hangup", "data": {"config": {}}} for i in range(60)],
           "edges": []}
    r = ask(h, flow["id"], draft_graph=big)
    assert r.status_code == 422 and "60 blocks" in r.json()["detail"]
    assert TED.requests and len(TED.requests) == 1       # only the 2000-char one went out


def test_draft_graph_becomes_base_and_seeded_start_is_null(h):
    flow = new_flow(h)
    ask_done(h, flow["id"])
    assert TED.requests[-1]["base"] is None          # the stored draft is just Start
    draft = {"schemaVersion": 1,
             "nodes": [{"id": "n_start", "type": "entry", "position": {"x": 5, "y": 5},
                        "data": {"config": {}}},
                       {"id": "n_x", "type": "dial", "position": {"x": 5, "y": 90},
                        "data": {"label": "Desk", "config": {
                            "target": {"kind": "own", "did": A_RCF}}}}],
             "edges": [{"id": "e1", "source": "n_start", "sourceHandle": "next",
                        "target": "n_x"}]}
    ask_done(h, flow["id"], "Add voicemail if nobody answers.", draft_graph=draft)
    assert TED.requests[-1]["base"] == {
        "nodes": [{"id": "n_start", "type": "entry", "config": {}},
                  {"id": "n_x", "type": "dial", "label": "Desk",
                   "config": {"target": {"kind": "own", "ref": "D1"}}}],
        "edges": [{"source": "n_start", "sourceHandle": "next", "target": "n_x"}]}


# ---------------------------------------------------------------------------
# Busy, stale, caps, retention
# ---------------------------------------------------------------------------
async def _insert_job(h, flow_id, *, customer_id=CUST_A, status="running", age_s=0,
                      conversation_id=None, message="older message", result=None):
    conn = await h.owner()
    try:
        jid = str(uuid.uuid4())
        await conn.execute(
            "INSERT INTO ivr_assist_jobs (id, customer_id, flow_id, conversation_id, status, "
            "message, result, error_code, finished_at, created_at) VALUES ($1::uuid, $2::int, "
            "$3::bigint, $4::uuid, $5::varchar, $6::text, $7::jsonb, $8::varchar, "
            "CASE WHEN $5::varchar = 'running' THEN NULL ELSE now() END, "
            "now() - make_interval(secs => $9::int))",
            jid, customer_id, flow_id, conversation_id or str(uuid.uuid4()), status, message,
            json.dumps(result) if result is not None else None,
            "assistant_failed" if status == "failed" else None, age_s)
        return jid
    finally:
        await conn.close()


def test_one_running_job_per_flow_and_staleness(h):
    flow = new_flow(h)
    running = run(h, _insert_job(h, flow["id"]))
    r = ask(h, flow["id"])
    assert r.status_code == 409 and r.json()["detail"] == "assist_busy"
    out = job(h, flow["id"], running)
    assert out["status"] == "running" and "result" not in out and "error" not in out
    # another flow of the same customer is not blocked
    assert ask(h, new_flow(h)["id"]).status_code == 202
    idle(h)
    # 301 s later the worker is presumed dead: reads as failed, a new job may start
    run(h, h.fetchval("UPDATE ivr_assist_jobs SET created_at = now() - interval '301 seconds' "
                      "WHERE id = $1::uuid RETURNING 1", running))
    out = job(h, flow["id"], running)
    assert out["status"] == "failed"
    assert out["error"] == {"code": "assistant_failed", "message": (
        "The flow assistant couldn't finish that request. Try rewording it, or build it by "
        "hand.")}
    assert ask(h, flow["id"]).status_code == 202
    idle(h)
    assert db_job(h, running)["status"] == "failed"       # swept when the new job started


def test_a_worker_that_finishes_after_going_stale_cannot_overwrite(h):
    from db import database as db
    from services.ivr.assist import jobs, pipeline
    flow = new_flow(h)
    jid = run(h, _insert_job(h, flow["id"], age_s=400))
    spec = jobs.JobSpec(jid, CUST_A, flow["id"], 50, str(uuid.uuid4()), "m", None)
    run(h, jobs._store(db.pool, spec,
                       pipeline.AssistOutcome(status="done", public={"kind": "clarify",
                                                                     "question": "?"},
                                              rounds=1, request_ids=[str(uuid.uuid4())])))
    row = db_job(h, jid)
    assert row["status"] == "failed" and row["error_code"] == "assistant_failed"


def _today(h, customer_id):
    return run(h, h.fetchval(
        f"SELECT count(*) FROM ivr_assist_jobs WHERE customer_id = {customer_id} AND "
        "created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')"))


def test_daily_cap_per_customer_per_utc_day(h, monkeypatch):
    flow_b, flow_a = new_flow(h, "user_b"), new_flow(h)
    done = {"public": {"kind": "clarify", "question": "?"}}
    cap = max(_today(h, CUST_A), _today(h, CUST_B)) + 2
    monkeypatch.setenv("IVR_ASSIST_DAILY_PER_CUSTOMER", str(cap))
    # B is one job below the cap; older jobs (yesterday and before) never count
    for _ in range(cap - 1 - _today(h, CUST_B)):
        run(h, _insert_job(h, flow_b["id"], customer_id=CUST_B, status="done", result=done))
    run(h, _insert_job(h, flow_b["id"], customer_id=CUST_B, status="done", age_s=2 * 86400,
                       result=done))
    assert ask(h, flow_b["id"], who="user_b").status_code == 202
    idle(h)
    assert _today(h, CUST_B) == cap
    r = ask(h, flow_b["id"], who="user_b")
    assert r.status_code == 429 and r.json()["detail"] == "assist_daily_limit"
    # the cap is per customer: A is still below it
    assert ask(h, flow_a["id"]).status_code == 202
    idle(h)


def test_rate_limit_six_a_minute_per_user(h):
    flows = [new_flow(h) for _ in range(7)]
    for f in flows[:6]:
        assert ask(h, f["id"]).status_code == 202
        idle(h)
    r = ask(h, flows[6]["id"])
    assert r.status_code == 429 and r.json()["detail"] == "assist_rate_limited"
    assert 1 <= r.json()["retry_after_s"] <= 61 and r.headers["Retry-After"]
    # per user: the readonly / other users are separate keys; user_b is fine
    assert ask(h, new_flow(h, "user_b")["id"], who="user_b").status_code == 202
    idle(h)


def test_retention_deletes_jobs_older_than_90_days(h):
    flow = new_flow(h)
    old = run(h, _insert_job(h, flow["id"], status="done", age_s=91 * 86400,
                             result={"public": {"kind": "clarify", "question": "?"}}))
    keep = run(h, _insert_job(h, flow["id"], status="done", age_s=89 * 86400,
                              result={"public": {"kind": "clarify", "question": "?"}}))
    ask_done(h, flow["id"])
    assert db_job(h, old) is None and db_job(h, keep) is not None


# ---------------------------------------------------------------------------
# TED failures and the repair loop through the API
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("answer,code,text", [
    ((401, {"error": "unauthorized", "message": "ted-internal-detail"}), "assistant_unavailable",
     "The flow assistant is unavailable right now. You can keep building by hand."),
    ((503, {"error": "disabled", "message": "ted-internal-detail"}), "assistant_unavailable", None),
    ((429, {"error": "budget_exhausted", "message": "ted-internal-detail", "retry_after_s": 3600}),
     "assistant_busy", "The flow assistant is busy. Try again in a minute."),
    ((502, {"error": "model_no_result", "message": "ted-internal-detail"}), "assistant_failed", None),
    ((400, {"error": "bad_request", "message": "ted-internal-detail"}), "assistant_failed", None),
])
def test_ted_errors_map_to_job_codes_with_crag_text(h, answer, code, text):
    TED.reset(lambda p: answer)
    flow = new_flow(h)
    _, out = ask_done(h, flow["id"])
    assert out["status"] == "failed" and out["error"]["code"] == code
    if text:
        assert out["error"]["message"] == text
    assert answer[1]["message"] not in json.dumps(out)        # TED's text never shown
    if code == "assistant_busy":
        assert out["error"]["retry_after_s"] == 3600
    else:
        assert "retry_after_s" not in out["error"]


def test_repair_loop_through_the_api_stops_at_two(h):
    def broken(payload):
        result = fake.scripted_result(payload)
        for node in result["graph"]["nodes"]:
            if node["type"] == "dial":
                node["config"]["target"]["ref"] = "D99"        # not a destination
        return result

    TED.reset(broken)
    flow = new_flow(h)
    started, out = ask_done(h, flow["id"])
    assert out["status"] == "done" and out["result"]["issues"]
    assert {i["code"] for i in out["result"]["issues"]} == {"transfer_target_required"}
    assert [r["round"] for r in TED.requests] == ["propose", "repair", "repair"]
    row = db_job(h, started["job_id"])
    assert row["rounds"] == 3 and len(row["ted_request_ids"]) == 3


def test_a_crashing_job_is_failed_not_stuck(h, monkeypatch):
    from services.ivr.assist import pipeline

    async def boom(*a, **k):
        raise RuntimeError("bug")

    monkeypatch.setattr(pipeline, "run", boom)
    _, out = ask_done(h, new_flow(h)["id"])
    assert out["status"] == "failed" and out["error"]["code"] == "assistant_failed"


def test_shutdown_cancels_in_flight_jobs_and_marks_them_failed(h, monkeypatch):
    import httpx
    from services.ivr.assist import jobs, ted_client
    gate = asyncio.Event()

    async def slow(request):
        await gate.wait()
        return httpx.Response(503, json={"error": "model_unavailable", "message": "x"})

    monkeypatch.setattr(ted_client, "TRANSPORT", httpx.MockTransport(slow))
    flow = new_flow(h)
    r = ask(h, flow["id"])
    assert r.status_code == 202
    run(h, asyncio.sleep(0.05))
    assert job(h, flow["id"], r.json()["job_id"])["status"] == "running"
    run(h, jobs.shutdown())
    out = job(h, flow["id"], r.json()["job_id"])
    assert out["status"] == "failed" and out["error"]["code"] == "assistant_failed"


# ---------------------------------------------------------------------------
# Conversations, refine, outcome, simulate
# ---------------------------------------------------------------------------
def test_conversation_history_and_stable_outside_aliases(h):
    flow = new_flow(h)
    first, _ = ask_done(h, flow["id"], "Send 2 to (508) 555-2199.")
    convo = first["conversation_id"]
    second, _ = ask_done(h, flow["id"], "And 3 to 774-404-5256, keep (508) 555-2199 on 2.",
                         conversation_id=convo)
    assert second["conversation_id"] == convo
    req = TED.requests[-1]
    assert req["conversation_id"] == convo
    assert req["message"] == "And 3 to [N2], keep [N1] on 2."
    assert req["external_numbers"] == ["N1", "N2"]
    assert [t["role"] for t in req["history"]] == ["customer", "assistant"]
    assert req["history"][0]["text"] == "Send 2 to [N1]."
    # an unknown, foreign or expired conversation starts a new one
    third, _ = ask_done(h, flow["id"], conversation_id=str(uuid.uuid4()))
    assert third["conversation_id"] not in (convo, None)
    assert TED.requests[-1]["history"] == []
    run(h, h.fetchval("UPDATE ivr_assist_jobs SET created_at = created_at - interval '25 hours' "
                      "WHERE conversation_id = $1::uuid RETURNING 1", convo))
    fourth, _ = ask_done(h, flow["id"], conversation_id=convo)
    assert fourth["conversation_id"] != convo
    flow_b = new_flow(h, "user_b")
    r = ask(h, flow_b["id"], who="user_b", conversation_id=third["conversation_id"])
    assert r.status_code == 202 and r.json()["conversation_id"] != third["conversation_id"]
    idle(h)
    assert TED.requests[-1]["history"] == []


def test_history_is_the_last_ten_turns(h):
    flow = new_flow(h)
    first, _ = ask_done(h, flow["id"], "turn 0")
    for i in range(1, 7):
        ask_done(h, flow["id"], f"turn {i}", conversation_id=first["conversation_id"])
        from services.ivr.assist import jobs
        jobs.rate_limiter.reset()
    history = TED.requests[-1]["history"]
    assert len(history) == 10
    assert history[0] == {"role": "customer", "text": "turn 1"}
    assert history[-1]["role"] == "assistant"


def test_refine_outcome_and_simulate(h):
    flow = new_flow(h)
    first, out = ask_done(h, flow["id"], "Press 1 for the front desk.")
    jid = first["job_id"]
    # simulate the proposal (its new messages stand in as prompts)
    r = api(h, "POST", f"/v1/ivr/flows/{flow['id']}/simulate",
            json={"assist_job_id": jid, "caller": "+15085551212", "at": AT, "digits": ["1"],
                  "draft_graph": {"ignored": True}})
    assert r.status_code == 200, r.text
    sim = r.json()
    assert sim["outcome"] == "transfer"
    assert sim["steps"][0]["says"] == ["Greeting"] and sim["steps"][1]["says"] == ["Main menu"]
    # refine: the proposal becomes base, with its new messages
    second, out2 = ask_done(h, flow["id"], "Make the greeting warmer.", refine_job_id=jid)
    assert second["conversation_id"] == first["conversation_id"]
    req = TED.requests[-1]
    assert [n["id"] for n in req["base"]["nodes"]][:2] == ["n_start", "n_hello"]
    hello = next(n for n in req["base"]["nodes"] if n["id"] == "n_hello")
    assert hello["config"]["prompts"] == ["NP1"]
    assert [np["key"] for np in req["base_new_prompts"]] == ["NP1", "NP2"]
    assert len(req["history"]) == 2
    # outcome: once; the same again is fine; a different one is 409
    path = f"/v1/ivr/flows/{flow['id']}/assist/{jid}/outcome"
    assert api(h, "POST", path, json={"outcome": "accepted"}).status_code == 204
    assert api(h, "POST", path, json={"outcome": "accepted"}).status_code == 204
    r = api(h, "POST", path, json={"outcome": "discarded"})
    assert r.status_code == 409 and r.json()["detail"] == "assist_outcome_recorded"
    assert api(h, "POST", path, json={"outcome": "kept"}).status_code == 422
    row = db_job(h, jid)
    assert row["outcome"] == "accepted" and row["outcome_at"] is not None
    # an accepted proposal can no longer be refined
    r = ask(h, flow["id"], refine_job_id=jid)
    assert r.status_code == 409 and r.json()["detail"] == "assist_not_refinable"
    assert ask(h, flow["id"], refine_job_id=str(uuid.uuid4())).status_code == 404
    other = new_flow(h)
    assert ask(h, other["id"], refine_job_id=second["job_id"]).status_code == 404
    assert api(h, "POST", f"/v1/ivr/flows/{other['id']}/simulate",
               json={"assist_job_id": second["job_id"], "caller": "anonymous",
                     "at": AT}).status_code == 404


def test_outcome_and_simulate_need_a_done_proposal(h):
    TED.reset(lambda p: {"kind": "clarify", "question": "Which number should 1 ring?"})
    flow = new_flow(h)
    started, out = ask_done(h, flow["id"], "Press 1 for billing")
    assert out["result"] == {"kind": "clarify", "question": "Which number should 1 ring?"}
    jid = started["job_id"]
    r = api(h, "POST", f"/v1/ivr/flows/{flow['id']}/assist/{jid}/outcome",
            json={"outcome": "accepted"})
    assert r.status_code == 409 and r.json()["detail"] == "assist_not_a_proposal"
    r = api(h, "POST", f"/v1/ivr/flows/{flow['id']}/simulate",
            json={"assist_job_id": jid, "caller": "anonymous", "at": AT})
    assert r.status_code == 409
    assert ask(h, flow["id"], refine_job_id=jid).json()["detail"] == "assist_not_refinable"


def test_simulate_without_assist_job_is_unchanged(h):
    flow = new_flow(h)
    r = api(h, "POST", f"/v1/ivr/flows/{flow['id']}/simulate",
            json={"caller": "+15085551212", "at": AT})
    assert r.status_code == 422 and r.json()["detail"] == "invalid_flow"   # just Start

