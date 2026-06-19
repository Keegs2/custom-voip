"""IVR flow management and hosted webhook endpoints.

Stores customer-built IVR configurations as JSON trees and serves them
as TwiML-compatible XML when calls arrive, so customers can build IVRs
in the UI without running their own webhook server.
"""
import json
import logging
import os
import re
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
from xml.etree.ElementTree import Element, SubElement, tostring
from xml.dom.minidom import parseString

from fastapi import APIRouter, HTTPException, Request, Form, Depends
from fastapi.responses import Response
from pydantic import BaseModel
from typing import Optional, Any

from db import database as db
from auth.dependencies import get_current_user, get_customer_filter
from auth.ingest import ingest_secret_ok, ingest_auth_error
from config_guard import is_production

logger = logging.getLogger(__name__)

router = APIRouter()


async def _get_owned_flow(flow_id: int, customer_filter: int | None) -> dict:
    """Fetch an IVR flow enforcing tenant isolation. 404 if it does not exist
    OR belongs to another customer (no cross-tenant existence leak)."""
    row = await db.fetch_one(
        "SELECT id, customer_id, did, flow_config, is_active FROM ivr_flows WHERE id = $1",
        flow_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="IVR flow not found")
    if customer_filter is not None and row["customer_id"] != customer_filter:
        raise HTTPException(status_code=404, detail="IVR flow not found")
    return dict(row)

# ---------------------------------------------------------------------------
# Table bootstrap
# ---------------------------------------------------------------------------

_table_created = False


async def _ensure_table():
    """Ensure the ivr_flows table exists.

    The runtime DB role (``api``) has no CREATE privilege on schema ``public``
    (least privilege), and Postgres checks CREATE privilege BEFORE the
    ``IF NOT EXISTS`` existence shortcut — so an unconditional CREATE TABLE 500s
    even when the table already exists (provisioned by a schema migration).

    We therefore probe with ``to_regclass`` first and only attempt the CREATE
    when the table is genuinely absent, swallowing a privilege error with a
    clear log instead of failing the request.
    """
    global _table_created
    if _table_created:
        return
    exists = await db.fetch_one("SELECT to_regclass('public.ivr_flows') AS t")
    if exists and exists["t"] is not None:
        _table_created = True
        return
    try:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS ivr_flows (
                id SERIAL PRIMARY KEY,
                customer_id INT NOT NULL REFERENCES customers(id),
                did VARCHAR(20),
                name VARCHAR(100) NOT NULL,
                flow_config JSONB NOT NULL,
                is_active BOOLEAN DEFAULT true,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        _table_created = True
    except Exception:
        logger.exception(
            "ivr_flows table is missing and could not be auto-created "
            "(runtime role lacks CREATE on schema public). Provision it via a "
            "schema migration."
        )


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class IVRFlowCreate(BaseModel):
    customer_id: int
    did: Optional[str] = None
    name: str
    flow_config: dict


class IVRFlowUpdate(BaseModel):
    name: Optional[str] = None
    did: Optional[str] = None
    flow_config: Optional[dict] = None
    is_active: Optional[bool] = None


# ---------------------------------------------------------------------------
# Server-side branch resolution (schedule + condition nodes)
# ---------------------------------------------------------------------------
#
# The IVR runtime (docker/freeswitch/scripts/handlers/api_voice.lua) executes
# TwiML and has NO native time-of-day or variable branch verb. So `schedule` and
# `condition` nodes are NOT rendered as XML elements — they are resolved here, at
# render time, and ONLY the chosen branch's child nodes are inlined into the
# output. FreeSWITCH never sees a <Schedule>/<Condition> element.
#
# The schedule matcher below mirrors the semantics of the Lua matcher in
# docker/freeswitch/scripts/lib/schedule.lua (day-of-week filter, [start, end)
# exclusive window, overnight wrap, all-day) but resolves the timezone with
# stdlib `zoneinfo` for DST-accurate wall-clock conversion instead of the Lua
# offset table.

# weekday() index (0=Mon .. 6=Sun) -> 3-letter abbreviation.
_DAY_ABBRS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
_VALID_DAYS = set(_DAY_ABBRS)

# "HH" or "HH:MM" (minutes optional). Hour 0..24, minute 0..59 validated below.
_HM_RE = re.compile(r"^\s*(\d{1,2})(?::(\d{1,2}))?\s*$")

# Fixed numeric UTC offset: "-05:00", "+0530", "-8", "+5".
_OFFSET_RE = re.compile(r"^([+-])(\d{1,2}):?(\d{2})?$")

_warned_tz: set = set()  # warn once per unknown tz name (per process)

# Test seam guard. An `X-Eval-Now` header or `?now=` ISO param can pin the
# schedule-evaluation instant (see _eval_now()) — a TEST/SIMULATE convenience
# that must be INERT in production, where a caller could otherwise force which
# schedule branch renders. Default ON outside production, OFF in production
# (matching config_guard's ENV/ENVIRONMENT convention). An explicit
# IVR_ALLOW_EVAL_NOW always wins (escape hatch for prod debugging).
_eval_now_override = os.getenv("IVR_ALLOW_EVAL_NOW")
if _eval_now_override is not None:
    _ALLOW_EVAL_NOW = _eval_now_override.strip().lower() in ("1", "true", "yes", "on")
else:
    _ALLOW_EVAL_NOW = not is_production()


def _resolve_tz(tz: Any):
    """Resolve a tz descriptor to a tzinfo. IANA name via zoneinfo, or a fixed
    numeric offset string ("±HH:MM"/"±HHMM"/"±H"). Missing/empty/"UTC" -> UTC.
    An unknown IANA name degrades to UTC with a one-time warning (a typo yields
    server/UTC time rather than crashing the render), matching schedule.lua."""
    if tz is None or tz == "" or tz == "UTC":
        return timezone.utc
    if isinstance(tz, str):
        m = _OFFSET_RE.match(tz)
        if m:
            sign, hh, mm = m.group(1), int(m.group(2)), int(m.group(3) or 0)
            delta = timedelta(hours=hh, minutes=mm)
            return timezone(-delta if sign == "-" else delta)
        try:
            return ZoneInfo(tz)
        except Exception:
            if tz not in _warned_tz:
                _warned_tz.add(tz)
                logger.warning("IVR schedule: unknown tz %r — falling back to UTC", tz)
            return timezone.utc
    return timezone.utc


def _parse_hm(s: Any) -> Optional[int]:
    """Parse "HH:MM" (or a bare "HH") into minutes since midnight, else None."""
    if not isinstance(s, str):
        return None
    m = _HM_RE.match(s)
    if not m:
        return None
    h = int(m.group(1))
    mm = int(m.group(2)) if m.group(2) is not None else 0
    if h < 0 or h > 24 or mm < 0 or mm > 59:
        return None
    return h * 60 + mm


def _day_set_of(days: Any) -> Optional[set]:
    """Build the allowed-weekday set from a schedule's `days`, or None for "every
    day" (omitted/empty, or nothing parseable — lenient, like schedule.lua)."""
    if not isinstance(days, (list, tuple)) or len(days) == 0:
        return None
    out = set()
    for d in days:
        key = str(d).strip().lower()[:3]
        if key in _VALID_DAYS:
            out.add(key)
    return out or None


def _day_allowed(day_set: Optional[set], wday: int) -> bool:
    if day_set is None:
        return True
    return _DAY_ABBRS[wday] in day_set


def _schedule_matches(cfg: Any, now: datetime) -> bool:
    """Return True when *now* falls inside the recurring weekly window in *cfg*
    (a schedule node's ``config``). Mirrors docker/freeswitch/scripts/lib/
    schedule.lua:matches().

    cfg fields (all optional):
      days  : list of weekday abbreviations ("mon".."sun"); omitted/empty = every day
      start : "HH:MM" window open  (local wall-clock in tz)
      end   : "HH:MM" window close (local wall-clock, EXCLUSIVE)
      tz    : IANA name ("America/New_York") or "±HH:MM" offset; omitted = UTC

    Overnight windows (start > end) wrap midnight: the evening portion
    (cur >= start) belongs to the start day's weekday; the early-morning portion
    (cur < end) belongs to the PREVIOUS weekday. start == end (or both omitted)
    is all-day; only the day-of-week filter applies. A non-dict cfg means "no
    restriction" -> always True.
    """
    if not isinstance(cfg, dict):
        return True

    tz = _resolve_tz(cfg.get("tz"))
    if now.tzinfo is None:                      # be defensive: treat naive as UTC
        now = now.replace(tzinfo=timezone.utc)
    lt = now.astimezone(tz)                      # local wall-clock breakdown

    day_set = _day_set_of(cfg.get("days"))
    cur = lt.hour * 60 + lt.minute
    wday = lt.weekday()                          # 0=Mon .. 6=Sun

    smin = _parse_hm(cfg.get("start"))
    emin = _parse_hm(cfg.get("end"))

    # No usable time bounds -> all-day; only the day filter applies.
    if smin is None and emin is None:
        return _day_allowed(day_set, wday)

    if smin is None:
        smin = 0                                 # only `end` given -> from midnight
    if emin is None:
        emin = 24 * 60                           # only `start` given -> to end of day

    if smin == emin:
        # Degenerate / explicit all-day window.
        return _day_allowed(day_set, wday)

    if emin > smin:
        # Same-day window: [start, end) — end is exclusive.
        if cur < smin or cur >= emin:
            return False
        return _day_allowed(day_set, wday)

    # Overnight window (start > end): wraps midnight.
    if cur >= smin:
        # Evening portion belongs to today's weekday.
        return _day_allowed(day_set, wday)
    if cur < emin:
        # Early-morning portion belongs to the PREVIOUS weekday.
        return _day_allowed(day_set, (wday - 1) % 7)
    return False


def _caller_matches(cfg: Any, caller: Optional[str]) -> bool:
    """Match the caller number against a condition node's caller_id constraints.

    cfg["caller_id"] may carry "prefix" (startswith) and/or "equals" (exact).
    Every constraint that is present must hold (AND). When NO caller number is
    available (e.g. the unauthenticated `/ivr/{id}/xml` preview endpoint), a
    condition can never match -> returns False so the flow takes `nomatch`.
    An empty/absent caller_id block matches any present caller (a bare
    "any caller" branch).
    """
    if caller is None:
        return False
    num = caller.strip()
    cid = cfg.get("caller_id") if isinstance(cfg, dict) else None
    if not isinstance(cid, dict):
        return True
    equals = cid.get("equals")
    if equals is not None and num != str(equals).strip():
        return False
    prefix = cid.get("prefix")
    if prefix is not None and not num.startswith(str(prefix).strip()):
        return False
    return True


def _eval_now(request: Request) -> datetime:
    """Resolve the tz-aware instant used to evaluate `schedule` nodes.

    Defaults to the server's current UTC time. TEST SEAM (gated by
    _ALLOW_EVAL_NOW — ON outside production, OFF in production unless
    IVR_ALLOW_EVAL_NOW is set explicitly): an `X-Eval-Now` header or `?now=`
    ISO-8601 query param overrides it so schedule branches are deterministically
    testable. The override is read-only — it only selects which already-authored
    branch renders, never mutates state — and FreeSWITCH never sends it. In
    production the override is ignored entirely and real `now` is always used.
    A naive ISO value is assumed UTC."""
    if _ALLOW_EVAL_NOW:
        raw = request.headers.get("X-Eval-Now") or request.query_params.get("now")
        if raw:
            try:
                dt = datetime.fromisoformat(raw)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt
            except ValueError:
                logger.warning(
                    "IVR: invalid X-Eval-Now/now value %r — using server time", raw
                )
    return datetime.now(timezone.utc)


def _caller_from_form(form) -> Optional[str]:
    """Pull the caller number from a FreeSWITCH/Twilio-style POST body.

    api_voice.lua posts Twilio-style params (From = caller_id_number); accept the
    raw FreeSWITCH channel-var name and a couple of fallbacks too."""
    for key in ("From", "Caller-Caller-ID-Number", "caller_id_number"):
        v = form.get(key)
        if v:
            return str(v)
    return None


# ---------------------------------------------------------------------------
# XML generation
# ---------------------------------------------------------------------------

def _node_to_xml(
    parent: Element,
    node: dict,
    flow_id: int,
    caller: Optional[str] = None,
    now: Optional[datetime] = None,
) -> None:
    """Convert a single IVR node dict into XML elements under *parent*.

    Supported node types: say, play, dial, gather, hangup, pause, redirect,
    record, reject, conference.

    Additive branch node types resolved SERVER-SIDE (no element reaches the
    runtime — the chosen branch's children are inlined into *parent* exactly as
    a normal node sequence):
      schedule  -> evaluate config against *now* (caller's tz); recurse
                   branches["in"] (in-window) or branches["out"].
      condition -> match *caller* against config.caller_id; recurse
                   branches["match"] or branches["nomatch"].
    *caller* is the caller number (None on the no-caller preview endpoint, which
    forces `nomatch`). *now* is the tz-aware evaluation instant (defaults to the
    server's current UTC time when None).
    """
    ntype = node.get("type", "").lower()
    config = node.get("config", {})

    if ntype == "schedule":
        branches = node.get("branches", {}) or {}
        eval_now = now if now is not None else datetime.now(timezone.utc)
        chosen = "in" if _schedule_matches(config, eval_now) else "out"
        for child in (branches.get(chosen) or []):
            _node_to_xml(parent, child, flow_id, caller, now)
        return

    if ntype == "condition":
        branches = node.get("branches", {}) or {}
        chosen = "match" if _caller_matches(config, caller) else "nomatch"
        for child in (branches.get(chosen) or []):
            _node_to_xml(parent, child, flow_id, caller, now)
        return

    if ntype == "say":
        el = SubElement(parent, "Say")
        if config.get("voice"):
            el.set("voice", str(config["voice"]))
        if config.get("language"):
            el.set("language", str(config["language"]))
        if config.get("loop"):
            el.set("loop", str(config["loop"]))
        el.text = config.get("text", "")

    elif ntype == "play":
        el = SubElement(parent, "Play")
        if config.get("loop"):
            el.set("loop", str(config["loop"]))
        el.text = config.get("url", "")

    elif ntype == "dial":
        el = SubElement(parent, "Dial")
        for attr in ("timeout", "callerId", "record", "action", "method",
                      "timeLimit", "hangupOnStar"):
            if config.get(attr):
                el.set(attr, str(config[attr]))
        # The number to dial can be a simple string or nested nouns
        if config.get("number"):
            num_el = SubElement(el, "Number")
            num_el.text = config["number"]
        if config.get("sip"):
            sip_el = SubElement(el, "Sip")
            sip_el.text = config["sip"]

    elif ntype == "gather":
        el = SubElement(parent, "Gather")
        gather_id = node.get("id", "")
        # Action URL points back to our webhook with gather context
        el.set("action", f"/ivr/webhook/{flow_id}?gather_id={gather_id}")
        el.set("method", "POST")
        for attr in ("numDigits", "timeout", "finishOnKey", "input"):
            if config.get(attr) is not None:
                el.set(attr, str(config[attr]))
        # Nested prompt verbs inside the Gather
        for prompt_node in node.get("prompt", []):
            _node_to_xml(el, prompt_node, flow_id, caller, now)

    elif ntype == "pause":
        el = SubElement(parent, "Pause")
        if config.get("length"):
            el.set("length", str(config["length"]))

    elif ntype == "hangup":
        SubElement(parent, "Hangup")

    elif ntype == "redirect":
        el = SubElement(parent, "Redirect")
        if config.get("method"):
            el.set("method", config["method"])
        el.text = config.get("url", "")

    elif ntype == "record":
        el = SubElement(parent, "Record")
        for attr in ("maxLength", "action", "method", "timeout",
                      "transcribe", "playBeep", "finishOnKey"):
            if config.get(attr) is not None:
                el.set(attr, str(config[attr]))

    elif ntype == "reject":
        el = SubElement(parent, "Reject")
        if config.get("reason"):
            el.set("reason", config["reason"])

    elif ntype == "conference":
        # Joins the existing mod_conference room conf_<customer_id>_<sanitized
        # name>. api_voice.lua:execute_conference parses ONLY these attributes
        # (see ~:1052-1100): muted, startConferenceOnEnter, endConferenceOnExit,
        # beep, waitUrl, maxParticipants, record, video. The room name is the
        # element text. We pass through only what the runtime reads.
        el = SubElement(parent, "Conference")

        def _twiml_val(v):
            # JSON booleans from the builder must render lowercase: api_voice.lua
            # checks `== "true"`, and str(True) would be "True".
            if isinstance(v, bool):
                return "true" if v else "false"
            return str(v)

        for attr in ("muted", "startConferenceOnEnter", "endConferenceOnExit",
                      "beep", "waitUrl", "maxParticipants", "record", "video"):
            if config.get(attr) is not None:
                el.set(attr, _twiml_val(config[attr]))
        # The builder's friendly `waitForModerator` maps to the TwiML attr the
        # runtime actually reads: startConferenceOnEnter="false" (wait-mod flag).
        if str(config.get("waitForModerator", "")).lower() in ("true", "1"):
            el.set("startConferenceOnEnter", "false")
        # Room name = element text. The builder emits it under `room`; keep the
        # name/roomName/text fallbacks for hand-authored flows.
        el.text = str(
            config.get("room")
            or config.get("name")
            or config.get("roomName")
            or config.get("text")
            or ""
        )

    else:
        logger.warning(f"Unknown IVR node type: {ntype}")


def generate_xml(
    flow_config: dict,
    flow_id: int,
    caller: Optional[str] = None,
    now: Optional[datetime] = None,
) -> str:
    """Walk the node tree in *flow_config* and produce TwiML-compatible XML.

    *caller* / *now* are threaded into the render so schedule/condition nodes
    resolve to a single branch (see _node_to_xml)."""
    root = Element("Response")
    for node in flow_config.get("nodes", []):
        _node_to_xml(root, node, flow_id, caller, now)
    raw = tostring(root, encoding="unicode")
    try:
        pretty = parseString(raw).toprettyxml(indent="  ")
        # Remove the <?xml ...?> declaration line added by minidom
        lines = pretty.split("\n")
        body = "\n".join(lines[1:]).strip()
        return '<?xml version="1.0" encoding="UTF-8"?>\n' + body + "\n"
    except Exception:
        return '<?xml version="1.0" encoding="UTF-8"?>\n' + raw + "\n"


def generate_branch_xml(
    branch_nodes: list,
    flow_id: int,
    caller: Optional[str] = None,
    now: Optional[datetime] = None,
) -> str:
    """Generate XML for a list of nodes belonging to a Gather branch.

    *caller* / *now* are threaded so any schedule/condition nodes nested inside
    the branch resolve correctly (see _node_to_xml)."""
    root = Element("Response")
    for node in branch_nodes:
        _node_to_xml(root, node, flow_id, caller, now)
    raw = tostring(root, encoding="unicode")
    try:
        pretty = parseString(raw).toprettyxml(indent="  ")
        lines = pretty.split("\n")
        body = "\n".join(lines[1:]).strip()
        return '<?xml version="1.0" encoding="UTF-8"?>\n' + body + "\n"
    except Exception:
        return '<?xml version="1.0" encoding="UTF-8"?>\n' + raw + "\n"


def _find_gather_node(nodes: list, gather_id: str) -> Optional[dict]:
    """Recursively search for a Gather node by id."""
    for node in nodes:
        if node.get("id") == gather_id and node.get("type", "").lower() == "gather":
            return node
        # Check nested prompt nodes (unlikely to have nested gathers, but be thorough)
        for prompt_node in node.get("prompt", []):
            found = _find_gather_node([prompt_node], gather_id)
            if found:
                return found
        # Check branch children
        for _key, branch_nodes in node.get("branches", {}).items():
            if isinstance(branch_nodes, list):
                found = _find_gather_node(branch_nodes, gather_id)
                if found:
                    return found
    return None


def _find_first_gather(nodes: list) -> Optional[dict]:
    """Return the first Gather node in the tree (depth-first)."""
    for node in nodes:
        if node.get("type", "").lower() == "gather":
            return node
        for prompt_node in node.get("prompt", []):
            found = _find_first_gather([prompt_node])
            if found:
                return found
    return None


# ---------------------------------------------------------------------------
# Helper to update DID voice_url
# ---------------------------------------------------------------------------

async def _update_did_voice_url(did: str, flow_id: int) -> None:
    """Point an API DID's voice_url to the internal IVR webhook."""
    webhook_url = f"http://api:8000/ivr/webhook/{flow_id}"
    result = await db.execute(
        "UPDATE api_dids SET voice_url = $1 WHERE did = $2",
        webhook_url, did,
    )
    if result and result != "UPDATE 0":
        logger.info(f"Updated DID {did} voice_url -> {webhook_url}")


async def _clear_did_voice_url(did: str) -> None:
    """Remove the internal IVR webhook URL from a DID (best-effort)."""
    await db.execute(
        "UPDATE api_dids SET voice_url = '' WHERE did = $1 AND voice_url LIKE 'http://api:8000/ivr/webhook/%'",
        did,
    )


# ---------------------------------------------------------------------------
# CRUD endpoints
# ---------------------------------------------------------------------------

@router.get("")
async def list_ivr_flows(
    customer_id: Optional[int] = None,
    did: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """List IVR flows. Non-admins are scoped to their own customer."""
    await _ensure_table()

    query = """
        SELECT id, customer_id, did, name, flow_config,
               is_active, created_at, updated_at
        FROM ivr_flows
        WHERE 1=1
    """
    values: list[Any] = []
    idx = 1

    # Enforce tenant scoping for non-admins; admins may filter by customer_id.
    if customer_filter is not None:
        query += f" AND customer_id = ${idx}"
        values.append(customer_filter)
        idx += 1
    elif customer_id is not None:
        query += f" AND customer_id = ${idx}"
        values.append(customer_id)
        idx += 1

    if did is not None:
        query += f" AND did = ${idx}"
        values.append(did)
        idx += 1

    query += f" ORDER BY created_at DESC LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([limit, offset])

    results = await db.fetch_all(query, *values)
    rows = []
    for r in results:
        row = dict(r)
        # asyncpg returns JSONB as a string or dict depending on version
        if isinstance(row.get("flow_config"), str):
            row["flow_config"] = json.loads(row["flow_config"])
        rows.append(row)
    return rows


@router.post("")
async def create_ivr_flow(
    flow: IVRFlowCreate,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Create a new IVR flow. Non-admins may only create within their own
    customer; the payload's customer_id is forced to the caller's."""
    await _ensure_table()

    customer_id = flow.customer_id
    if customer_filter is not None:
        customer_id = customer_filter
        flow.customer_id = customer_filter

    # Verify customer exists
    customer = await db.fetch_one(
        "SELECT id, status FROM customers WHERE id = $1",
        customer_id,
    )
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    if customer["status"] != "active":
        raise HTTPException(status_code=400, detail="Customer is not active")

    # SEC-3 (DID-claim IDOR): if this flow is linked to a DID, that DID must be
    # an API DID owned by this customer — creating the flow repoints the DID's
    # voice_url at our hosted webhook (_update_did_voice_url below), so without
    # this gate a tenant could hijack another tenant's DID into its own IVR.
    if flow.did:
        owned_did = await db.fetch_one(
            "SELECT 1 FROM api_dids WHERE did = $1 AND customer_id = $2",
            flow.did, customer_id,
        )
        if not owned_did:
            raise HTTPException(
                status_code=403, detail="DID is not assigned to this customer"
            )

    flow_json = json.dumps(flow.flow_config)

    result = await db.fetch_one(
        """
        INSERT INTO ivr_flows (customer_id, did, name, flow_config)
        VALUES ($1, $2, $3, $4::jsonb)
        RETURNING id, customer_id, did, name, flow_config, is_active, created_at, updated_at
        """,
        flow.customer_id, flow.did, flow.name, flow_json,
    )
    row = dict(result)
    if isinstance(row.get("flow_config"), str):
        row["flow_config"] = json.loads(row["flow_config"])

    # Auto-link DID to this webhook
    if flow.did:
        await _update_did_voice_url(flow.did, row["id"])

    return row


@router.get("/{flow_id}")
async def get_ivr_flow(
    flow_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Get a single IVR flow by ID (tenant-scoped)."""
    await _ensure_table()
    await _get_owned_flow(flow_id, customer_filter)

    result = await db.fetch_one(
        """
        SELECT id, customer_id, did, name, flow_config,
               is_active, created_at, updated_at
        FROM ivr_flows WHERE id = $1
        """,
        flow_id,
    )
    if not result:
        raise HTTPException(status_code=404, detail="IVR flow not found")
    row = dict(result)
    if isinstance(row.get("flow_config"), str):
        row["flow_config"] = json.loads(row["flow_config"])
    return row


@router.put("/{flow_id}")
async def update_ivr_flow(
    flow_id: int,
    flow: IVRFlowUpdate,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Update an IVR flow (name, did, flow_config, is_active) — tenant-scoped."""
    await _ensure_table()
    await _get_owned_flow(flow_id, customer_filter)

    updates = []
    values: list[Any] = []
    idx = 1

    data = flow.model_dump(exclude_none=True)
    if not data:
        raise HTTPException(status_code=400, detail="No fields to update")

    for field, value in data.items():
        if field == "flow_config":
            updates.append(f"flow_config = ${idx}::jsonb")
            values.append(json.dumps(value))
        else:
            updates.append(f"{field} = ${idx}")
            values.append(value)
        idx += 1

    updates.append("updated_at = NOW()")
    values.append(flow_id)

    query = f"""
        UPDATE ivr_flows SET {', '.join(updates)}
        WHERE id = ${idx}
        RETURNING id, customer_id, did, name, flow_config, is_active, created_at, updated_at
    """

    result = await db.fetch_one(query, *values)
    if not result:
        raise HTTPException(status_code=404, detail="IVR flow not found")

    row = dict(result)
    if isinstance(row.get("flow_config"), str):
        row["flow_config"] = json.loads(row["flow_config"])

    # If DID was updated, re-point it to the webhook
    if flow.did is not None and flow.did:
        await _update_did_voice_url(flow.did, flow_id)

    return row


@router.delete("/{flow_id}")
async def delete_ivr_flow(
    flow_id: int,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Delete an IVR flow (tenant-scoped)."""
    await _ensure_table()

    # Tenant-scoped fetch to check existence and clear DID linkage
    existing = await _get_owned_flow(flow_id, customer_filter)

    # Clear voice_url on the linked DID
    if existing["did"]:
        await _clear_did_voice_url(existing["did"])

    result = await db.execute(
        "DELETE FROM ivr_flows WHERE id = $1",
        flow_id,
    )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="IVR flow not found")

    return {"status": "deleted", "id": flow_id}


# ---------------------------------------------------------------------------
# XML preview endpoints
# ---------------------------------------------------------------------------

@router.get("/{flow_id}/xml")
async def get_ivr_xml(
    flow_id: int,
    request: Request,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Generate and return the TwiML XML for the root flow (tenant-scoped).

    This is a PREVIEW endpoint with no live caller, so `condition` nodes always
    resolve to their `nomatch` branch. `schedule` nodes evaluate against the
    current server time, or against the `X-Eval-Now` header / `?now=` ISO param
    test seam (see _eval_now) for deterministic previews."""
    await _ensure_table()
    result = await _get_owned_flow(flow_id, customer_filter)

    flow_config = result["flow_config"]
    if isinstance(flow_config, str):
        flow_config = json.loads(flow_config)

    xml_str = generate_xml(flow_config, flow_id, caller=None, now=_eval_now(request))
    return Response(content=xml_str, media_type="application/xml")


@router.get("/{flow_id}/xml/{digit}")
async def get_ivr_branch_xml(
    flow_id: int,
    digit: str,
    request: Request,
    customer_filter: int | None = Depends(get_customer_filter),
):
    """Return XML for a specific Gather branch (digit or 'timeout') — scoped.

    Preview endpoint: no live caller, so nested `condition` nodes resolve to
    `nomatch`; `schedule` nodes use server time or the _eval_now test seam."""
    await _ensure_table()
    result = await _get_owned_flow(flow_id, customer_filter)

    flow_config = result["flow_config"]
    if isinstance(flow_config, str):
        flow_config = json.loads(flow_config)

    # Find the first Gather node
    gather_node = _find_first_gather(flow_config.get("nodes", []))
    if not gather_node:
        raise HTTPException(status_code=404, detail="No Gather node found in flow")

    branches = gather_node.get("branches", {})
    branch_nodes = branches.get(digit)
    if branch_nodes is None:
        raise HTTPException(
            status_code=404,
            detail=f"No branch found for digit '{digit}'"
        )

    xml_str = generate_branch_xml(
        branch_nodes, flow_id, caller=None, now=_eval_now(request)
    )
    return Response(content=xml_str, media_type="application/xml")


# ---------------------------------------------------------------------------
# Webhook endpoint (called by FreeSWITCH / voice platform)
# ---------------------------------------------------------------------------

@router.post("/webhook/{flow_id}")
async def ivr_webhook(
    flow_id: int,
    request: Request,
    gather_id: Optional[str] = None,
):
    """Hosted webhook endpoint that the platform calls when a call arrives.

    - No ``Digits`` param: returns XML for the root flow.
    - ``Digits`` param present: finds the matching Gather branch and returns that XML.
    - ``gather_id`` query param identifies which Gather node the digits came from.

    SEC-2: JWT-exempt (FreeSWITCH calls it without a user token), so it requires
    the shared ``X-Ingest-Secret`` header (constant-time compared to env
    ``INGEST_SHARED_SECRET``); an unset secret allows in dev with a loud warning,
    same pattern as the CDR/voicemail/recording ingest endpoints.
    """
    if not ingest_secret_ok(request):
        return ingest_auth_error()

    await _ensure_table()

    result = await db.fetch_one(
        "SELECT id, flow_config, is_active FROM ivr_flows WHERE id = $1",
        flow_id,
    )
    if not result:
        raise HTTPException(status_code=404, detail="IVR flow not found")
    if not result["is_active"]:
        raise HTTPException(status_code=404, detail="IVR flow is inactive")

    flow_config = result["flow_config"]
    if isinstance(flow_config, str):
        flow_config = json.loads(flow_config)

    # Evaluation context threaded into the render so schedule/condition nodes
    # resolve server-side: the live caller number (From) and "now".
    now = _eval_now(request)
    caller = None

    # Parse form body (Twilio-style POST) or query params
    digits = None
    try:
        form = await request.form()
        digits = form.get("Digits")
        caller = _caller_from_form(form)
        # Also pick up gather_id from form if not in query string
        if not gather_id:
            gather_id = form.get("gather_id")
    except Exception:
        pass

    # Fall back to query params (e.g. From in the action URL) when absent.
    if caller is None:
        caller = request.query_params.get("From")

    if digits is None:
        # No digits — return the root flow XML
        xml_str = generate_xml(flow_config, flow_id, caller=caller, now=now)
        return Response(content=xml_str, media_type="application/xml")

    # Digits present — find the matching Gather branch
    nodes = flow_config.get("nodes", [])

    if gather_id:
        gather_node = _find_gather_node(nodes, gather_id)
    else:
        gather_node = _find_first_gather(nodes)

    if not gather_node:
        logger.warning(
            f"IVR {flow_id}: Gather node not found (gather_id={gather_id})"
        )
        # Fallback: replay the root flow
        xml_str = generate_xml(flow_config, flow_id, caller=caller, now=now)
        return Response(content=xml_str, media_type="application/xml")

    branches = gather_node.get("branches", {})
    branch_nodes = branches.get(str(digits))

    if branch_nodes is None:
        # Try timeout / default branch
        branch_nodes = branches.get("default") or branches.get("timeout")

    if branch_nodes is None:
        logger.warning(
            f"IVR {flow_id}: No branch for digit '{digits}' in gather {gather_id}"
        )
        # Replay the root flow as fallback
        xml_str = generate_xml(flow_config, flow_id, caller=caller, now=now)
        return Response(content=xml_str, media_type="application/xml")

    xml_str = generate_branch_xml(branch_nodes, flow_id, caller=caller, now=now)
    return Response(content=xml_str, media_type="application/xml")


# Also accept GET for the webhook (some platforms use GET)
@router.get("/webhook/{flow_id}")
async def ivr_webhook_get(
    flow_id: int,
    request: Request,
    gather_id: Optional[str] = None,
    Digits: Optional[str] = None,
    From: Optional[str] = None,
):
    """GET variant of the webhook for platforms that use GET requests.

    `From` (caller number) and the _eval_now seam are threaded so schedule/
    condition nodes resolve server-side, same as the POST variant.

    SEC-2: JWT-exempt like the POST variant, so it requires the shared
    ``X-Ingest-Secret`` header (see the POST handler)."""
    if not ingest_secret_ok(request):
        return ingest_auth_error()

    await _ensure_table()

    result = await db.fetch_one(
        "SELECT id, flow_config, is_active FROM ivr_flows WHERE id = $1",
        flow_id,
    )
    if not result:
        raise HTTPException(status_code=404, detail="IVR flow not found")
    if not result["is_active"]:
        raise HTTPException(status_code=404, detail="IVR flow is inactive")

    flow_config = result["flow_config"]
    if isinstance(flow_config, str):
        flow_config = json.loads(flow_config)

    now = _eval_now(request)
    caller = From

    if Digits is None:
        xml_str = generate_xml(flow_config, flow_id, caller=caller, now=now)
        return Response(content=xml_str, media_type="application/xml")

    nodes = flow_config.get("nodes", [])
    if gather_id:
        gather_node = _find_gather_node(nodes, gather_id)
    else:
        gather_node = _find_first_gather(nodes)

    if not gather_node:
        xml_str = generate_xml(flow_config, flow_id, caller=caller, now=now)
        return Response(content=xml_str, media_type="application/xml")

    branches = gather_node.get("branches", {})
    branch_nodes = branches.get(str(Digits))
    if branch_nodes is None:
        branch_nodes = branches.get("default") or branches.get("timeout")

    if branch_nodes is None:
        xml_str = generate_xml(flow_config, flow_id, caller=caller, now=now)
        return Response(content=xml_str, media_type="application/xml")

    xml_str = generate_branch_xml(branch_nodes, flow_id, caller=caller, now=now)
    return Response(content=xml_str, media_type="application/xml")
