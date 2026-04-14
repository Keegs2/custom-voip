"""Number inventory endpoints.

Queries the Bandwidth TN inventory and cross-references internal product
tables to show which numbers are assigned and which are available.
"""
import logging
from fastapi import APIRouter, Depends, HTTPException
from db import database as db
from auth.dependencies import require_admin
from services.bandwidth_client import get_all_tns, _credentials_configured

logger = logging.getLogger(__name__)

router = APIRouter()

# SQL that unions all four product tables to build the assignment map.
# Each row: (did, product, customer_name).
ASSIGNMENT_QUERY = """
    SELECT did, 'rcf' AS product, c.name AS customer_name
      FROM rcf_numbers r JOIN customers c ON r.customer_id = c.id
    UNION ALL
    SELECT did, 'api' AS product, c.name AS customer_name
      FROM api_dids a JOIN customers c ON a.customer_id = c.id
    UNION ALL
    SELECT did, 'trunk' AS product, c.name AS customer_name
      FROM trunk_dids t
      JOIN sip_trunks s ON t.trunk_id = s.id
      JOIN customers c ON s.customer_id = c.id
    UNION ALL
    SELECT assigned_did AS did, 'ucaas' AS product, c.name AS customer_name
      FROM extensions e
      JOIN customers c ON e.customer_id = c.id
     WHERE e.assigned_did IS NOT NULL
"""


async def _build_assignment_map() -> dict[str, dict]:
    """Return a dict keyed by DID with assignment info.

    Example: { "+15087282017": {"product": "rcf", "customer_name": "Acme"} }
    """
    rows = await db.fetch_all(ASSIGNMENT_QUERY)
    mapping: dict[str, dict] = {}
    for r in rows:
        did = r["did"]
        # Normalize: strip leading + for comparison, store original
        mapping[did] = {
            "product": r["product"],
            "customer_name": r["customer_name"],
        }
    return mapping


def _normalize(tn: str) -> str:
    """Normalize a TN to a consistent format for comparison.

    Bandwidth may return '5087282017', '15087282017', or '+15087282017'.
    Internal tables store E.164 (+15087282017).  We compare all as plain
    digits (no '+') so both sides match.
    """
    return tn.lstrip("+")


def _tn_to_e164(tn: str) -> str:
    """Best-effort conversion of a Bandwidth TN to E.164."""
    digits = tn.lstrip("+")
    if len(digits) == 10:
        return f"+1{digits}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    return f"+{digits}"


def _extract_tn_number(tn) -> str:
    """Extract the telephone number string from a TN record.

    Bandwidth may return the TN as a plain string or as a dict with a key
    like 'telephoneNumber', 'tn', 'fullNumber', etc.
    """
    if isinstance(tn, str):
        return tn
    if isinstance(tn, dict):
        return (
            tn.get("telephoneNumber")
            or tn.get("tn")
            or tn.get("fullNumber")
            or tn.get("number")
            or str(tn)
        )
    return str(tn)


def _extract_tn_metadata(tn) -> dict:
    """Pull city/state/status fields out of a Bandwidth TN record."""
    if not isinstance(tn, dict):
        return {}
    return {
        "city": tn.get("city", ""),
        "state": tn.get("state", ""),
        "lata": tn.get("lata", ""),
        "rate_center": tn.get("rateCenter", tn.get("rate_center", "")),
        "tier": tn.get("tier", ""),
        "bw_status": tn.get("status", ""),
    }


@router.get("/inventory")
async def get_inventory(admin: dict = Depends(require_admin)):
    """Return the full Bandwidth TN inventory with assignment status."""
    if not _credentials_configured():
        raise HTTPException(
            status_code=503,
            detail="Bandwidth API credentials not configured. "
                   "Set BANDWIDTH_API_CLIENT_ID and BANDWIDTH_API_CLIENT_SECRET.",
        )

    try:
        tns = await get_all_tns()
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    assignment_map = await _build_assignment_map()

    # Build a normalized lookup: plain digits -> assignment info
    normalized_map: dict[str, dict] = {}
    for did, info in assignment_map.items():
        normalized_map[_normalize(did)] = info

    results = []
    for tn in tns:
        number = _extract_tn_number(tn)
        meta = _extract_tn_metadata(tn)
        e164 = _tn_to_e164(number)
        norm = _normalize(number)
        assignment = normalized_map.get(norm)

        results.append({
            "tn": e164,
            **meta,
            "assigned_to": assignment,
        })

    return results


@router.get("/available")
async def get_available(admin: dict = Depends(require_admin)):
    """Return only unassigned Bandwidth TNs."""
    if not _credentials_configured():
        raise HTTPException(
            status_code=503,
            detail="Bandwidth API credentials not configured. "
                   "Set BANDWIDTH_API_CLIENT_ID and BANDWIDTH_API_CLIENT_SECRET.",
        )

    try:
        tns = await get_all_tns()
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    assignment_map = await _build_assignment_map()

    normalized_map: dict[str, dict] = {}
    for did, info in assignment_map.items():
        normalized_map[_normalize(did)] = info

    results = []
    for tn in tns:
        number = _extract_tn_number(tn)
        meta = _extract_tn_metadata(tn)
        e164 = _tn_to_e164(number)
        norm = _normalize(number)

        if norm not in normalized_map:
            results.append({"tn": e164, **meta})

    return results


@router.get("/stats")
async def get_stats(admin: dict = Depends(require_admin)):
    """Summary statistics for the TN inventory."""
    if not _credentials_configured():
        raise HTTPException(
            status_code=503,
            detail="Bandwidth API credentials not configured. "
                   "Set BANDWIDTH_API_CLIENT_ID and BANDWIDTH_API_CLIENT_SECRET.",
        )

    try:
        tns = await get_all_tns()
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    assignment_map = await _build_assignment_map()

    normalized_map: dict[str, dict] = {}
    for did, info in assignment_map.items():
        normalized_map[_normalize(did)] = info

    # Count assignments by product
    counts = {"rcf": 0, "api": 0, "trunk": 0, "ucaas": 0}
    assigned = 0

    for tn in tns:
        number = _extract_tn_number(tn)
        norm = _normalize(number)
        info = normalized_map.get(norm)
        if info:
            assigned += 1
            product = info["product"]
            if product in counts:
                counts[product] += 1

    total = len(tns)
    available = total - assigned

    return {
        "total": total,
        "assigned": assigned,
        "available": available,
        "by_product": counts,
    }
