"""IVR flow management and hosted webhook endpoints.

Stores customer-built IVR configurations as JSON trees and serves them
as TwiML-compatible XML when calls arrive, so customers can build IVRs
in the UI without running their own webhook server.
"""
import json
import logging
from xml.etree.ElementTree import Element, SubElement, tostring
from xml.dom.minidom import parseString

from fastapi import APIRouter, HTTPException, Request, Form
from fastapi.responses import Response
from pydantic import BaseModel
from typing import Optional, Any

from db import database as db

logger = logging.getLogger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# Table bootstrap
# ---------------------------------------------------------------------------

_table_created = False


async def _ensure_table():
    """Create the ivr_flows table if it does not already exist."""
    global _table_created
    if _table_created:
        return
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
# XML generation
# ---------------------------------------------------------------------------

def _node_to_xml(parent: Element, node: dict, flow_id: int) -> None:
    """Convert a single IVR node dict into XML elements under *parent*.

    Supported node types: say, play, dial, gather, hangup, pause, redirect,
    record, reject.
    """
    ntype = node.get("type", "").lower()
    config = node.get("config", {})

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
            _node_to_xml(el, prompt_node, flow_id)

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

    else:
        logger.warning(f"Unknown IVR node type: {ntype}")


def generate_xml(flow_config: dict, flow_id: int) -> str:
    """Walk the node tree in *flow_config* and produce TwiML-compatible XML."""
    root = Element("Response")
    for node in flow_config.get("nodes", []):
        _node_to_xml(root, node, flow_id)
    raw = tostring(root, encoding="unicode")
    try:
        pretty = parseString(raw).toprettyxml(indent="  ")
        # Remove the <?xml ...?> declaration line added by minidom
        lines = pretty.split("\n")
        body = "\n".join(lines[1:]).strip()
        return '<?xml version="1.0" encoding="UTF-8"?>\n' + body + "\n"
    except Exception:
        return '<?xml version="1.0" encoding="UTF-8"?>\n' + raw + "\n"


def generate_branch_xml(branch_nodes: list, flow_id: int) -> str:
    """Generate XML for a list of nodes belonging to a Gather branch."""
    root = Element("Response")
    for node in branch_nodes:
        _node_to_xml(root, node, flow_id)
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
):
    """List all IVR flows with optional filters."""
    await _ensure_table()

    query = """
        SELECT id, customer_id, did, name, flow_config,
               is_active, created_at, updated_at
        FROM ivr_flows
        WHERE 1=1
    """
    values: list[Any] = []
    idx = 1

    if customer_id is not None:
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
async def create_ivr_flow(flow: IVRFlowCreate):
    """Create a new IVR flow."""
    await _ensure_table()

    # Verify customer exists
    customer = await db.fetch_one(
        "SELECT id, status FROM customers WHERE id = $1",
        flow.customer_id,
    )
    if not customer:
        raise HTTPException(status_code=404, detail="Customer not found")
    if customer["status"] != "active":
        raise HTTPException(status_code=400, detail="Customer is not active")

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
async def get_ivr_flow(flow_id: int):
    """Get a single IVR flow by ID."""
    await _ensure_table()

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
async def update_ivr_flow(flow_id: int, flow: IVRFlowUpdate):
    """Update an IVR flow (name, did, flow_config, is_active)."""
    await _ensure_table()

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
async def delete_ivr_flow(flow_id: int):
    """Delete an IVR flow."""
    await _ensure_table()

    # Fetch to check existence and clear DID linkage
    existing = await db.fetch_one(
        "SELECT id, did FROM ivr_flows WHERE id = $1",
        flow_id,
    )
    if not existing:
        raise HTTPException(status_code=404, detail="IVR flow not found")

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
async def get_ivr_xml(flow_id: int):
    """Generate and return the TwiML XML for the root flow."""
    await _ensure_table()

    result = await db.fetch_one(
        "SELECT id, flow_config FROM ivr_flows WHERE id = $1",
        flow_id,
    )
    if not result:
        raise HTTPException(status_code=404, detail="IVR flow not found")

    flow_config = result["flow_config"]
    if isinstance(flow_config, str):
        flow_config = json.loads(flow_config)

    xml_str = generate_xml(flow_config, flow_id)
    return Response(content=xml_str, media_type="application/xml")


@router.get("/{flow_id}/xml/{digit}")
async def get_ivr_branch_xml(flow_id: int, digit: str):
    """Return XML for a specific Gather branch (digit or 'timeout')."""
    await _ensure_table()

    result = await db.fetch_one(
        "SELECT id, flow_config FROM ivr_flows WHERE id = $1",
        flow_id,
    )
    if not result:
        raise HTTPException(status_code=404, detail="IVR flow not found")

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

    xml_str = generate_branch_xml(branch_nodes, flow_id)
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
    """
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

    # Parse form body (Twilio-style POST) or query params
    digits = None
    try:
        form = await request.form()
        digits = form.get("Digits")
        # Also pick up gather_id from form if not in query string
        if not gather_id:
            gather_id = form.get("gather_id")
    except Exception:
        pass

    if digits is None:
        # No digits — return the root flow XML
        xml_str = generate_xml(flow_config, flow_id)
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
        xml_str = generate_xml(flow_config, flow_id)
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
        xml_str = generate_xml(flow_config, flow_id)
        return Response(content=xml_str, media_type="application/xml")

    xml_str = generate_branch_xml(branch_nodes, flow_id)
    return Response(content=xml_str, media_type="application/xml")


# Also accept GET for the webhook (some platforms use GET)
@router.get("/webhook/{flow_id}")
async def ivr_webhook_get(
    flow_id: int,
    request: Request,
    gather_id: Optional[str] = None,
    Digits: Optional[str] = None,
):
    """GET variant of the webhook for platforms that use GET requests."""
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

    if Digits is None:
        xml_str = generate_xml(flow_config, flow_id)
        return Response(content=xml_str, media_type="application/xml")

    nodes = flow_config.get("nodes", [])
    if gather_id:
        gather_node = _find_gather_node(nodes, gather_id)
    else:
        gather_node = _find_first_gather(nodes)

    if not gather_node:
        xml_str = generate_xml(flow_config, flow_id)
        return Response(content=xml_str, media_type="application/xml")

    branches = gather_node.get("branches", {})
    branch_nodes = branches.get(str(Digits))
    if branch_nodes is None:
        branch_nodes = branches.get("default") or branches.get("timeout")

    if branch_nodes is None:
        xml_str = generate_xml(flow_config, flow_id)
        return Response(content=xml_str, media_type="application/xml")

    xml_str = generate_branch_xml(branch_nodes, flow_id)
    return Response(content=xml_str, media_type="application/xml")
