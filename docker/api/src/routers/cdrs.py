"""CDR (Call Detail Record) query and ingestion endpoints."""
from fastapi import APIRouter, HTTPException, Query, Request
from typing import Optional
from datetime import datetime, timedelta, timezone
from db import database as db
import logging
import re

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# CDR Ingestion from FreeSWITCH mod_json_cdr
# ---------------------------------------------------------------------------

def _safe_int(value, default=None):
    """Convert a string value to int, returning default on failure."""
    if value is None:
        return default
    try:
        return int(value)
    except (ValueError, TypeError):
        return default


def _safe_float(value, default=None):
    """Convert a string value to float, returning default on failure."""
    if value is None:
        return default
    try:
        return float(value)
    except (ValueError, TypeError):
        return default


def _safe_bigint(value, default=None):
    """Convert a string value to a big int, returning default on failure."""
    if value is None:
        return default
    try:
        return int(value)
    except (ValueError, TypeError):
        return default


def _compute_r_factor(mos: float | None) -> float | None:
    """Compute R-factor from MOS using piecewise linear approximation.

    - MOS >= 4.5 -> R = 93
    - MOS >= 4.0 -> R = 80 + (MOS - 4.0) * 26
    - MOS >= 3.0 -> R = 60 + (MOS - 3.0) * 20
    - MOS <  3.0 -> R = MOS * 20
    """
    if mos is None:
        return None
    if mos >= 4.5:
        return 93.0
    if mos >= 4.0:
        return 80.0 + (mos - 4.0) * 26.0
    if mos >= 3.0:
        return 60.0 + (mos - 3.0) * 20.0
    return mos * 20.0


def _epoch_to_timestamp(epoch_str):
    """Convert a Unix epoch string to a timezone-aware datetime.

    Returns None if the epoch is 0, empty, or unparseable (e.g. unanswered
    calls report answer_epoch as "0").
    """
    if not epoch_str:
        return None
    try:
        epoch = int(epoch_str)
        if epoch == 0:
            return None
        return datetime.fromtimestamp(epoch, tz=timezone.utc)
    except (ValueError, TypeError):
        return None


def _get_callflow_caller_profile(body: dict) -> dict:
    """Extract the first caller_profile from the callflow array.

    FreeSWITCH's JSON CDR places caller_profile data under
    callflow[0].caller_profile. Some fields (destination_number,
    caller_id_number) are reliably present there but may be absent or
    malformed in the top-level variables dict.

    Handles both list and single-dict callflow structures.
    """
    callflow = body.get("callflow", [])
    if isinstance(callflow, list) and callflow:
        return callflow[0].get("caller_profile", {})
    elif isinstance(callflow, dict):
        return callflow.get("caller_profile", {})
    return {}


def _clean_caller_id_number(raw: str | None) -> str | None:
    """Extract a clean phone number from a possibly SIP-formatted caller ID.

    FreeSWITCH variables.caller_id_number may contain the full SIP
    display format: '"DISPLAY NAME" <+15087282017>' or just the number.
    The callflow.caller_profile.caller_id_number is usually clean, but
    we normalize in either case.

    Returns the bare number (e.g. '+15087282017') or None.
    """
    if not raw:
        return None
    # Already a clean number (starts with + or digit)
    raw = raw.strip()
    if re.match(r'^\+?\d+$', raw):
        return raw
    # Try extracting from SIP angle-bracket format: "Name" <+1234>
    m = re.search(r'<([^>]+)>', raw)
    if m:
        return m.group(1).strip()
    # Try extracting any E.164-ish number from the string
    m = re.search(r'(\+?\d{7,15})', raw)
    if m:
        return m.group(1)
    # Return as-is if nothing matched; let downstream handle it
    return raw


async def _process_cdr_body(body: dict) -> dict:
    """Extract fields from a parsed FreeSWITCH JSON CDR and insert into the database.

    Field resolution order for key fields:
      - destination_number: variables -> callflow[0].caller_profile
      - caller_id_number:   callflow[0].caller_profile -> variables (cleaned)
      - uuid:               variables -> core-uuid -> callflow caller_profile

    Returns a dict with 'status' ('ok', 'duplicate', or 'error') and details.
    Never raises -- errors are caught, logged, and returned.
    """
    try:
        variables = body.get("variables", {})
        caller_profile = _get_callflow_caller_profile(body)

        if not variables and not caller_profile:
            logger.warning("CDR ingest: missing both 'variables' and 'callflow' in payload")
            return {"status": "error", "detail": "missing variables"}

        # ---- Extract and validate required fields -------------------------
        call_uuid = variables.get("uuid")
        if not call_uuid:
            # uuid is sometimes at the top level of the CDR as well
            call_uuid = body.get("core-uuid") or caller_profile.get("uuid")
        if not call_uuid:
            logger.warning("CDR ingest: missing uuid in variables and callflow")
            return {"status": "error", "detail": "missing uuid"}

        direction = str(variables.get("direction", "inbound"))
        product_type = str(variables.get("product_type", "trunk"))

        # destination_number: prefer variables, fall back to callflow caller_profile
        destination = variables.get("destination_number")
        if not destination:
            destination = caller_profile.get("destination_number")
            if destination:
                logger.debug(
                    "CDR ingest: destination_number resolved from callflow "
                    "caller_profile for uuid=%s", call_uuid,
                )
        if not destination:
            logger.warning("CDR ingest: missing destination_number for uuid=%s", call_uuid)
            return {"status": "error", "detail": "missing destination"}

        start_time = _epoch_to_timestamp(variables.get("start_epoch"))
        end_time = _epoch_to_timestamp(variables.get("end_epoch"))
        if not start_time or not end_time:
            logger.warning(
                "CDR ingest: invalid start/end epoch for uuid=%s "
                "(start_epoch=%s, end_epoch=%s)",
                call_uuid,
                variables.get("start_epoch"),
                variables.get("end_epoch"),
            )
            return {"status": "error", "detail": "invalid timestamps"}

        # customer_id is NOT NULL in the schema; default to 0 for unmatched
        customer_id = _safe_int(variables.get("customer_id"), default=0)

        # ---- Optional fields ----------------------------------------------
        trunk_id = _safe_int(variables.get("trunk_id"))

        # caller_id_number: prefer callflow (clean number), fall back to
        # variables (may contain SIP display name format), then clean it
        caller_id = caller_profile.get("caller_id_number")
        if not caller_id:
            caller_id = variables.get("caller_id_number")
        caller_id = _clean_caller_id_number(caller_id)

        answer_time = _epoch_to_timestamp(variables.get("answer_epoch"))

        duration_sec = _safe_int(variables.get("duration"), default=0)
        duration_ms = int(duration_sec * 1000)

        billsec = _safe_int(variables.get("billsec"), default=0)
        billable_ms = int(billsec * 1000)

        hangup_cause = variables.get("hangup_cause")
        if hangup_cause is not None:
            hangup_cause = str(hangup_cause)
        sip_code = _safe_int(variables.get("sip_term_status"))
        carrier_used = variables.get("carrier_used")
        if carrier_used is not None:
            carrier_used = str(carrier_used)
        traffic_grade = variables.get("traffic_grade")
        if traffic_grade is not None:
            traffic_grade = str(traffic_grade)
        freeswitch_node = variables.get("FreeSWITCH-Hostname")
        if freeswitch_node is not None:
            freeswitch_node = str(freeswitch_node)

        # Extract a destination prefix (up to first 6 digits after +) for
        # rate-lookup caching.  e.g. "+17743260301" -> "+17743"
        destination_prefix = str(destination[:6]) if destination else None

        # ---- RTP quality metrics ------------------------------------------
        mos = _safe_float(variables.get("rtp_audio_in_mos"))
        quality_pct = _safe_float(variables.get("rtp_audio_in_quality_percentage"))
        jitter_min_ms = _safe_float(variables.get("rtp_audio_in_jitter_min_variance"))
        jitter_max_ms = _safe_float(variables.get("rtp_audio_in_jitter_max_variance"))
        rtp_mean_interval = _safe_float(variables.get("rtp_audio_in_mean_interval"))
        jitter_avg_ms = rtp_mean_interval  # mean interval as avg jitter proxy
        packet_loss_count = _safe_int(variables.get("rtp_audio_in_skip_packet_count"))
        packet_total_count = _safe_int(variables.get("rtp_audio_in_media_packet_count"))

        # Compute packet loss percentage
        packet_loss_pct = None
        if packet_loss_count is not None and packet_total_count and packet_total_count > 0:
            packet_loss_pct = round((packet_loss_count / packet_total_count) * 100, 2)

        flaw_total = _safe_int(variables.get("rtp_audio_in_flaw_total"))
        r_factor = _compute_r_factor(mos)

        rtp_audio_in_raw_bytes = _safe_bigint(variables.get("rtp_audio_in_raw_bytes"))
        rtp_audio_in_media_bytes = _safe_bigint(variables.get("rtp_audio_in_media_bytes"))
        rtp_audio_out_raw_bytes = _safe_bigint(variables.get("rtp_audio_out_raw_bytes"))
        rtp_audio_out_media_bytes = _safe_bigint(variables.get("rtp_audio_out_media_bytes"))
        rtp_audio_in_packet_count = _safe_int(variables.get("rtp_audio_in_packet_count"))
        rtp_audio_out_packet_count = _safe_int(variables.get("rtp_audio_out_packet_count"))
        rtp_jitter_burst_rate = _safe_float(variables.get("rtp_audio_in_jitter_burst_rate"))
        rtp_jitter_loss_rate = _safe_float(variables.get("rtp_audio_in_jitter_loss_rate"))
        read_codec = variables.get("read_codec")
        if read_codec is not None:
            read_codec = str(read_codec)
        write_codec = variables.get("write_codec")
        if write_codec is not None:
            write_codec = str(write_codec)

        # ---- Additional SIP detail fields ---------------------------------
        read_rate = _safe_int(variables.get("read_rate"))
        write_rate = _safe_int(variables.get("write_rate"))
        sip_from_user = variables.get("sip_from_user")
        if sip_from_user is not None:
            sip_from_user = str(sip_from_user)[:64]
        sip_to_user = variables.get("sip_to_user")
        if sip_to_user is not None:
            sip_to_user = str(sip_to_user)[:64]
        hangup_cause_q850 = _safe_int(variables.get("hangup_cause_q850"))
        sip_hangup_disposition = variables.get("sip_hangup_disposition")
        if sip_hangup_disposition is not None:
            sip_hangup_disposition = str(sip_hangup_disposition)[:30]
        sip_user_agent = variables.get("sip_user_agent")
        if sip_user_agent is not None:
            sip_user_agent = str(sip_user_agent)[:128]
        # network_addr: prefer callflow caller_profile, fall back to variables
        network_addr = caller_profile.get("network_addr") or variables.get("network_addr")
        if network_addr is not None:
            network_addr = str(network_addr)[:45]
        bridge_uuid = variables.get("bridge_uuid") or variables.get("call_uuid")
        if bridge_uuid is not None:
            bridge_uuid = str(bridge_uuid)[:64]

        # ---- Logging: summarize what we extracted -------------------------
        extracted = []
        dropped = []
        field_checks = {
            "mos": mos, "quality_pct": quality_pct,
            "jitter_min_ms": jitter_min_ms, "jitter_max_ms": jitter_max_ms,
            "jitter_avg_ms": jitter_avg_ms, "rtp_mean_interval": rtp_mean_interval,
            "packet_loss_count": packet_loss_count, "packet_total_count": packet_total_count,
            "packet_loss_pct": packet_loss_pct, "flaw_total": flaw_total,
            "r_factor": r_factor,
            "rtp_in_raw_bytes": rtp_audio_in_raw_bytes,
            "rtp_in_media_bytes": rtp_audio_in_media_bytes,
            "rtp_out_raw_bytes": rtp_audio_out_raw_bytes,
            "rtp_out_media_bytes": rtp_audio_out_media_bytes,
            "rtp_in_pkt_count": rtp_audio_in_packet_count,
            "rtp_out_pkt_count": rtp_audio_out_packet_count,
            "burst_rate": rtp_jitter_burst_rate, "loss_rate": rtp_jitter_loss_rate,
            "read_codec": read_codec, "write_codec": write_codec,
            "read_rate": read_rate, "write_rate": write_rate,
            "sip_from_user": sip_from_user, "sip_to_user": sip_to_user,
            "hangup_cause_q850": hangup_cause_q850,
            "sip_hangup_disposition": sip_hangup_disposition,
            "sip_user_agent": sip_user_agent,
            "network_addr": network_addr, "bridge_uuid": bridge_uuid,
            "trunk_id": trunk_id, "carrier_used": carrier_used,
            "answer_time": answer_time, "sip_code": sip_code,
        }
        for fname, fval in field_checks.items():
            if fval is not None:
                extracted.append(fname)
            else:
                dropped.append(fname)

        logger.info(
            "CDR ingest: uuid=%s extracted %d fields (%s), "
            "%d fields null (%s)",
            call_uuid,
            len(extracted), ",".join(extracted) if extracted else "none",
            len(dropped), ",".join(dropped) if dropped else "none",
        )

        # ---- Insert with duplicate guard ----------------------------------
        # The cdrs table uses a composite PK (id, start_time) for TimescaleDB
        # hypertable partitioning, so ON CONFLICT on uuid is not available.
        # Instead we use a NOT EXISTS subquery to skip duplicates.
        #
        # IMPORTANT: every parameter gets an explicit ::type cast so asyncpg
        # never needs to infer PostgreSQL types.  This prevents
        # AmbiguousParameterError when values are None.
        result = await db.execute(
            """
            INSERT INTO cdrs (
                uuid, customer_id, product_type, trunk_id, direction,
                caller_id, destination, destination_prefix,
                start_time, answer_time, end_time,
                duration_ms, billable_ms,
                hangup_cause, sip_code, carrier_used, traffic_grade,
                freeswitch_node,
                mos, quality_pct, jitter_min_ms, jitter_max_ms, jitter_avg_ms,
                packet_loss_count, packet_total_count, packet_loss_pct,
                flaw_total, r_factor,
                rtp_audio_in_raw_bytes, rtp_audio_in_media_bytes,
                rtp_audio_out_raw_bytes, rtp_audio_out_media_bytes,
                rtp_audio_in_packet_count, rtp_audio_out_packet_count,
                rtp_audio_in_jitter_burst_rate, rtp_audio_in_jitter_loss_rate,
                rtp_audio_in_mean_interval,
                read_codec, write_codec,
                read_rate, write_rate,
                sip_from_user, sip_to_user,
                hangup_cause_q850, sip_hangup_disposition,
                sip_user_agent, network_addr, bridge_uuid
            )
            SELECT
                $1::varchar,  $2::int,       $3::varchar,  $4::int,       $5::varchar,
                $6::varchar,  $7::varchar,   $8::varchar,
                $9::timestamptz, $10::timestamptz, $11::timestamptz,
                $12::int,     $13::int,
                $14::varchar, $15::int,      $16::varchar,  $17::varchar,
                $18::varchar,
                $19::numeric, $20::numeric,  $21::numeric,  $22::numeric, $23::numeric,
                $24::int,     $25::int,      $26::numeric,
                $27::int,     $28::numeric,
                $29::bigint,  $30::bigint,
                $31::bigint,  $32::bigint,
                $33::int,     $34::int,
                $35::numeric, $36::numeric,
                $37::numeric,
                $38::varchar, $39::varchar,
                $40::int,     $41::int,
                $42::varchar, $43::varchar,
                $44::smallint, $45::varchar,
                $46::varchar, $47::varchar, $48::varchar
            WHERE NOT EXISTS (
                SELECT 1 FROM cdrs WHERE uuid = $1::varchar
            )
            """,
            str(call_uuid),         # $1  uuid
            int(customer_id),       # $2  customer_id
            str(product_type),      # $3  product_type
            trunk_id,               # $4  trunk_id (int | None)
            str(direction),         # $5  direction
            caller_id,              # $6  caller_id (str | None)
            str(destination),       # $7  destination
            destination_prefix,     # $8  destination_prefix (str | None)
            start_time,             # $9  start_time (datetime)
            answer_time,            # $10 answer_time (datetime | None)
            end_time,               # $11 end_time (datetime)
            int(duration_ms),       # $12 duration_ms
            int(billable_ms),       # $13 billable_ms
            hangup_cause,           # $14 hangup_cause (str | None)
            sip_code,               # $15 sip_code (int | None)
            carrier_used,           # $16 carrier_used (str | None)
            traffic_grade,          # $17 traffic_grade (str | None)
            freeswitch_node,        # $18 freeswitch_node (str | None)
            mos,                    # $19 mos (float | None)
            quality_pct,            # $20 quality_pct (float | None)
            jitter_min_ms,          # $21 jitter_min_ms (float | None)
            jitter_max_ms,          # $22 jitter_max_ms (float | None)
            jitter_avg_ms,          # $23 jitter_avg_ms (float | None)
            packet_loss_count,      # $24 packet_loss_count (int | None)
            packet_total_count,     # $25 packet_total_count (int | None)
            packet_loss_pct,        # $26 packet_loss_pct (float | None)
            flaw_total,             # $27 flaw_total (int | None)
            r_factor,               # $28 r_factor (float | None)
            rtp_audio_in_raw_bytes,     # $29 (int | None)
            rtp_audio_in_media_bytes,   # $30 (int | None)
            rtp_audio_out_raw_bytes,    # $31 (int | None)
            rtp_audio_out_media_bytes,  # $32 (int | None)
            rtp_audio_in_packet_count,  # $33 (int | None)
            rtp_audio_out_packet_count, # $34 (int | None)
            rtp_jitter_burst_rate,      # $35 (float | None)
            rtp_jitter_loss_rate,       # $36 (float | None)
            rtp_mean_interval,          # $37 (float | None)
            read_codec,             # $38 read_codec (str | None)
            write_codec,            # $39 write_codec (str | None)
            read_rate,              # $40 read_rate (int | None)
            write_rate,             # $41 write_rate (int | None)
            sip_from_user,          # $42 sip_from_user (str | None)
            sip_to_user,            # $43 sip_to_user (str | None)
            hangup_cause_q850,      # $44 hangup_cause_q850 (int | None)
            sip_hangup_disposition,  # $45 sip_hangup_disposition (str | None)
            sip_user_agent,         # $46 sip_user_agent (str | None)
            network_addr,           # $47 network_addr (str | None)
            bridge_uuid,            # $48 bridge_uuid (str | None)
        )

        if result and "INSERT 0 0" in result:
            logger.info("CDR ingest: duplicate skipped uuid=%s", call_uuid)
            return {"status": "duplicate", "uuid": call_uuid}

        logger.info(
            "CDR ingest: inserted uuid=%s customer=%s dest=%s duration=%ds "
            "hangup=%s sip_code=%s carrier=%s mos=%s",
            call_uuid, customer_id, destination, duration_sec,
            hangup_cause, sip_code, carrier_used, mos,
        )
        return {"status": "ok", "uuid": call_uuid}

    except Exception:
        logger.exception("CDR ingest: unexpected error processing CDR")
        return {"status": "error", "detail": "internal processing error"}


@router.post("/ingest")
async def ingest_cdr(request: Request):
    """Receive a raw JSON CDR from FreeSWITCH mod_json_cdr and insert it.

    This endpoint is called directly by FreeSWITCH after each call ends.
    It must always return 200 -- returning an error causes FS to retry and
    can flood the endpoint with duplicate data.

    No authentication is required; FreeSWITCH calls this over the internal
    Docker network.
    """
    try:
        content_type = request.headers.get("content-type", "")
        if "application/json" in content_type:
            body = await request.json()
        elif "x-www-form-urlencoded" in content_type:
            # mod_json_cdr with encode-values sends URL-encoded form with a 'cdr' field
            import json
            from urllib.parse import unquote
            form = await request.form()
            cdr_raw = form.get("cdr", "")
            if not cdr_raw:
                # Some versions send the JSON as the entire body without a field name
                raw_body = await request.body()
                cdr_raw = unquote(raw_body.decode("utf-8", errors="replace"))
            else:
                cdr_raw = str(cdr_raw)
            body = json.loads(cdr_raw)
        else:
            # Try raw body as JSON (mod_json_cdr may send without content-type)
            import json
            raw_body = await request.body()
            body = json.loads(raw_body.decode("utf-8", errors="replace"))
    except Exception as e:
        logger.warning("CDR ingest: failed to parse body: %s", e)
        return {"status": "error", "detail": "invalid JSON"}

    return await _process_cdr_body(body)


@router.post("/ingest/bulk")
async def ingest_cdr_bulk(request: Request):
    """Bulk-ingest CDR JSON files that were saved to disk by mod_json_cdr fallback.

    Accepts a JSON array of CDR objects (each one a full FreeSWITCH JSON CDR).
    Processes each CDR independently -- individual failures do not block others.
    Always returns 200 with a summary of results.

    Usage from the VM to re-ingest fallback files:

        # One file at a time:
        curl -X POST http://127.0.0.1:8088/v1/cdrs/ingest \\
             -H 'Content-Type: application/json' \\
             -d @/var/log/freeswitch/json_cdr/a_]]<uuid>.cdr.json

        # Bulk (all files at once):
        jq -s '.' /var/log/freeswitch/json_cdr/a_*.cdr.json | \\
        curl -X POST http://127.0.0.1:8088/v1/cdrs/ingest/bulk \\
             -H 'Content-Type: application/json' -d @-
    """
    try:
        body = await request.json()
    except Exception as e:
        logger.warning("CDR bulk ingest: failed to parse body: %s", e)
        return {"status": "error", "detail": "invalid JSON"}

    if not isinstance(body, list):
        return {"status": "error", "detail": "expected a JSON array of CDR objects"}

    results = {"ok": 0, "duplicate": 0, "error": 0, "total": len(body), "errors": []}

    for i, cdr_body in enumerate(body):
        if not isinstance(cdr_body, dict):
            logger.warning("CDR bulk ingest: item %d is not a dict, skipping", i)
            results["error"] += 1
            results["errors"].append({"index": i, "detail": "not a JSON object"})
            continue

        result = await _process_cdr_body(cdr_body)
        status = result.get("status", "error")
        if status in results:
            results[status] += 1
        else:
            results["error"] += 1

        if status == "error":
            results["errors"].append({
                "index": i,
                "uuid": result.get("uuid"),
                "detail": result.get("detail"),
            })

    # Truncate error details to avoid massive responses
    if len(results["errors"]) > 50:
        results["errors"] = results["errors"][:50]
        results["errors_truncated"] = True

    logger.info(
        "CDR bulk ingest: processed %d CDRs (ok=%d, duplicate=%d, error=%d)",
        results["total"], results["ok"], results["duplicate"], results["error"],
    )
    return results


@router.get("")
async def query_cdrs(
    customer_id: Optional[int] = None,
    trunk_id: Optional[int] = None,
    product_type: Optional[str] = None,
    direction: Optional[str] = None,
    destination: Optional[str] = None,
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
    rated_only: bool = False,
    limit: int = Query(default=100, le=1000),
    offset: int = 0
):
    """Query CDRs with filters."""
    # Default to last 24 hours if no date range
    if not start_date:
        start_date = datetime.utcnow() - timedelta(hours=24)
    if not end_date:
        end_date = datetime.utcnow()

    query = """
        SELECT uuid, customer_id, product_type, trunk_id, direction,
               caller_id, destination, start_time, answer_time, end_time,
               duration_ms, billable_ms, rate_per_min, total_cost,
               hangup_cause, sip_code, carrier_used, traffic_grade, rated_at,
               mos, quality_pct, jitter_min_ms, jitter_max_ms, jitter_avg_ms,
               packet_loss_count, packet_total_count, packet_loss_pct,
               flaw_total, r_factor, read_codec, write_codec,
               read_rate, write_rate,
               rtp_audio_in_raw_bytes, rtp_audio_in_media_bytes,
               rtp_audio_out_raw_bytes, rtp_audio_out_media_bytes,
               rtp_audio_in_packet_count, rtp_audio_out_packet_count,
               rtp_audio_in_jitter_burst_rate, rtp_audio_in_jitter_loss_rate,
               rtp_audio_in_mean_interval,
               sip_from_user, sip_to_user, hangup_cause_q850,
               sip_hangup_disposition, sip_user_agent,
               network_addr, bridge_uuid
        FROM cdrs
        WHERE start_time >= $1 AND start_time <= $2
    """
    values = [start_date, end_date]
    idx = 3

    if customer_id:
        query += f" AND customer_id = ${idx}"
        values.append(customer_id)
        idx += 1

    if trunk_id:
        query += f" AND trunk_id = ${idx}"
        values.append(trunk_id)
        idx += 1

    if product_type:
        query += f" AND product_type = ${idx}"
        values.append(product_type)
        idx += 1

    if direction:
        query += f" AND direction = ${idx}"
        values.append(direction)
        idx += 1

    if destination:
        query += f" AND destination LIKE ${idx}"
        values.append(f"{destination}%")
        idx += 1

    if rated_only:
        query += " AND rated_at IS NOT NULL"

    query += f" ORDER BY start_time DESC LIMIT ${idx} OFFSET ${idx + 1}"
    values.extend([limit, offset])

    results = await db.fetch_all(query, *values)

    # Convert to dicts and format times
    cdrs = []
    for r in results:
        cdr = dict(r)
        cdr["duration_seconds"] = (cdr.pop("duration_ms") or 0) / 1000
        cdr["billable_seconds"] = (cdr.pop("billable_ms") or 0) / 1000
        cdrs.append(cdr)

    return {"cdrs": cdrs, "count": len(cdrs), "offset": offset, "limit": limit}


@router.get("/summary")
async def cdr_summary(
    customer_id: int,
    start_date: Optional[datetime] = None,
    end_date: Optional[datetime] = None,
    group_by: str = "day"  # day, hour, destination
):
    """Get CDR summary statistics."""
    if not start_date:
        start_date = datetime.utcnow() - timedelta(days=7)
    if not end_date:
        end_date = datetime.utcnow()

    if group_by == "day":
        query = """
            SELECT
                DATE(start_time) as date,
                product_type,
                direction,
                COUNT(*) as total_calls,
                COUNT(*) FILTER (WHERE answer_time IS NOT NULL) as answered_calls,
                SUM(duration_ms) / 1000 as total_duration_sec,
                SUM(total_cost) as total_cost
            FROM cdrs
            WHERE customer_id = $1 AND start_time >= $2 AND start_time <= $3
            GROUP BY DATE(start_time), product_type, direction
            ORDER BY date DESC
        """
    elif group_by == "destination":
        query = """
            SELECT
                SUBSTRING(destination, 1, 4) as prefix,
                COUNT(*) as total_calls,
                COUNT(*) FILTER (WHERE answer_time IS NOT NULL) as answered_calls,
                SUM(duration_ms) / 1000 as total_duration_sec,
                SUM(total_cost) as total_cost,
                AVG(duration_ms) FILTER (WHERE answer_time IS NOT NULL) / 1000 as avg_duration_sec
            FROM cdrs
            WHERE customer_id = $1 AND start_time >= $2 AND start_time <= $3
            GROUP BY prefix
            ORDER BY total_calls DESC
            LIMIT 50
        """
    else:  # hour
        query = """
            SELECT
                DATE_TRUNC('hour', start_time) as hour,
                COUNT(*) as total_calls,
                COUNT(*) FILTER (WHERE answer_time IS NOT NULL) as answered_calls,
                SUM(total_cost) as total_cost
            FROM cdrs
            WHERE customer_id = $1 AND start_time >= $2 AND start_time <= $3
            GROUP BY hour
            ORDER BY hour DESC
            LIMIT 168
        """

    results = await db.fetch_all(query, customer_id, start_date, end_date)
    return {"summary": [dict(r) for r in results], "group_by": group_by}


@router.get("/{cdr_uuid}")
async def get_cdr(cdr_uuid: str):
    """Get a single CDR by UUID including all RTP quality metrics."""
    result = await db.fetch_one(
        """
        SELECT uuid, customer_id, product_type, trunk_id, direction,
               caller_id, destination, destination_prefix,
               start_time, answer_time, end_time,
               duration_ms, billable_ms, rate_per_min, total_cost,
               carrier_cost, margin,
               hangup_cause, sip_code, carrier_used, traffic_grade,
               fraud_score, fraud_flags, rated_at, freeswitch_node,
               mos, quality_pct, jitter_min_ms, jitter_max_ms, jitter_avg_ms,
               packet_loss_count, packet_total_count, packet_loss_pct,
               flaw_total, r_factor,
               rtp_audio_in_raw_bytes, rtp_audio_in_media_bytes,
               rtp_audio_out_raw_bytes, rtp_audio_out_media_bytes,
               rtp_audio_in_packet_count, rtp_audio_out_packet_count,
               rtp_audio_in_jitter_burst_rate, rtp_audio_in_jitter_loss_rate,
               rtp_audio_in_mean_interval,
               read_codec, write_codec,
               read_rate, write_rate,
               sip_from_user, sip_to_user, hangup_cause_q850,
               sip_hangup_disposition, sip_user_agent,
               network_addr, bridge_uuid
        FROM cdrs WHERE uuid = $1
        """,
        cdr_uuid
    )
    if not result:
        raise HTTPException(status_code=404, detail="CDR not found")

    cdr = dict(result)
    cdr["duration_seconds"] = (cdr.pop("duration_ms") or 0) / 1000
    cdr["billable_seconds"] = (cdr.pop("billable_ms") or 0) / 1000
    # Convert Decimal types to float for JSON serialization
    for key in ("mos", "quality_pct", "jitter_min_ms", "jitter_max_ms",
                "jitter_avg_ms", "packet_loss_pct", "r_factor",
                "rtp_audio_in_jitter_burst_rate", "rtp_audio_in_jitter_loss_rate",
                "rtp_audio_in_mean_interval", "rate_per_min", "total_cost",
                "carrier_cost", "margin"):
        if cdr.get(key) is not None:
            cdr[key] = float(cdr[key])
    return cdr


@router.post("/{cdr_uuid}/rate")
async def rate_cdr(cdr_uuid: str):
    """Manually trigger rating for a CDR."""
    # Call the PostgreSQL rating function
    result = await db.fetch_one("SELECT rate_cdr($1) as cost", cdr_uuid)

    if result["cost"] is None:
        raise HTTPException(status_code=404, detail="CDR not found or already rated")

    return {"cdr_uuid": cdr_uuid, "cost": float(result["cost"]), "status": "rated"}
