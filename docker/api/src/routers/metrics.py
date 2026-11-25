"""Fleet metrics read from VictoriaMetrics (admin only, read-only).

One endpoint (contract: docs/CALLS_ACTIVE_API.md):

  GET /v1/metrics/calls-active?hours=24&step_seconds=300

Returns the fleet-wide number of connected calls at each ``step_seconds`` mark
of the last ``hours`` hours, plus the latest value. It is a platform-wide
number (never tenant data), so it is ``require_admin`` like the other fleet
reads (``/v1/sbc/stats``, ``/v1/live-trunk-stats``).

Source: the gauge ``freeswitch_calls_active{freeswitch_node, zone}`` that each
FreeSWITCH node's carrier-monitor sidecar exports (ESL ``show calls count``,
read every ~10 s, scraped every 15 s — docker/carrier-monitor/ops_metrics.py)
and every zone's vmagent ships to the central VictoriaMetrics on the services
VM. It is the same series the NOC panel "Concurrent calls — live" sums.

The caller never supplies PromQL. The query text below is a constant; the only
values sent with it are integers this module computed (``start`` / ``end`` /
``step`` / ``time``) from the two validated query parameters.
"""
from __future__ import annotations

import asyncio
import logging
import math
import os
import time
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse

from auth.dependencies import require_admin

logger = logging.getLogger(__name__)

router = APIRouter()

#: Default works on the production compose network: the API and the
#: ``victoriametrics`` service share ``services-network``
#: (docker-compose.services.yml), the same way Grafana and vmalert reach it.
DEFAULT_VICTORIAMETRICS_URL = "http://victoriametrics:8428"

#: Upper bound on the whole upstream read (both queries together).
UPSTREAM_TIMEOUT_S = 5.0

#: How old a node's reading may be and still count, in seconds. Four scrape
#: intervals (15 s): a node that misses a scrape or two keeps its last reading
#: instead of dropping out of the total, and a node silent for longer than
#: this stops counting instead of being carried forward for minutes. It is
#: written into the query explicitly so the result does not depend on
#: VictoriaMetrics' own lookback heuristics. Never longer than the smallest
#: step (60 s), so two neighbouring points never reuse one sample window.
FRESH_S = 60

#: A step counts as completed once it is this many seconds old. Samples from
#: the other zones arrive by remote-write a few seconds after they are taken;
#: waiting keeps a published point from changing afterwards. Same figure as
#: VictoriaMetrics' own ``-search.latencyOffset`` default.
SETTLE_S = 30

# One series per FreeSWITCH node, summed HERE (not in the query) so the answer
# also says how many nodes it is made of.
#
#   last_over_time(...[60s])   the node's newest reading at the step mark, at
#                              most FRESH_S old: "calls in progress at that
#                              mark", a snapshot like the NOC live panel. NOT
#                              an average or a maximum over the step: an
#                              average blurs a 5-minute mark into the 5
#                              minutes before it, and a maximum is a peak
#                              (the fleet peak has its own recorded series,
#                              fleet:freeswitch_calls_active_peak:sum, and a
#                              sum of per-node peaks overstates the total).
#   max by (freeswitch_node, zone)
#                              one value per node whatever extra labels the
#                              series carries, so a node that is ever scraped
#                              twice is not counted twice (the reduction the
#                              recording rules in docker/vmalert/rules/
#                              traffic.yml use).
#   and on (...) (max_over_time(freeswitch_esl_scrape_ok[60s]) == 1)
#                              the exporter keeps serving its LAST-GOOD call
#                              count while it cannot read FreeSWITCH, and
#                              flips freeswitch_esl_scrape_ok to 0. Without
#                              this, a FreeSWITCH that has died keeps adding
#                              the calls it had when it died. A node counts
#                              only if FreeSWITCH answered the exporter at
#                              least once in the last FRESH_S seconds.
#
# A standby FreeSWITCH node is a separate node with its own series; it counts
# only the calls it is itself carrying (normally 0), so summing nodes never
# counts a call twice.
CALLS_BY_NODE_QUERY = (
    "max by (freeswitch_node, zone) "
    f"(last_over_time(freeswitch_calls_active[{FRESH_S}s])) "
    "and on (freeswitch_node, zone) "
    "(max by (freeswitch_node, zone) "
    f"(max_over_time(freeswitch_esl_scrape_ok[{FRESH_S}s])) == 1)"
)

ERROR_CODE = "metrics_unavailable"

#: Clock, a module attribute so tests can pin "now".
_now = time.time


class _Upstream(Exception):
    """VictoriaMetrics could not be read, or its answer could not be trusted."""


def _base_url() -> str:
    """VICTORIAMETRICS_URL, read live (a restart with a new .env is enough)."""
    return (os.getenv("VICTORIAMETRICS_URL", "").strip()
            or DEFAULT_VICTORIAMETRICS_URL).rstrip("/")


def _iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _unavailable(reason: str) -> JSONResponse:
    """503 {detail, code}: the metrics store did not give a usable answer."""
    return JSONResponse(status_code=503, content={
        "detail": f"Call metrics are unavailable: {reason}",
        "code": ERROR_CODE,
    })


def _window(now: float, hours: int, step: int) -> tuple[int, int]:
    """(start, end) in Unix seconds, both exact multiples of ``step``.

    ``end`` is the newest step mark that is at least SETTLE_S old; ``start``
    is the first step mark at or after ``end - hours``.
    """
    end = int((now - SETTLE_S) // step) * step
    start = -(-(end - hours * 3600) // step) * step
    return start, end


def _result_series(payload: Any, result_type: str) -> list[dict]:
    """The ``data.result`` list of a Prometheus-API answer, or _Upstream."""
    if not isinstance(payload, dict) or payload.get("status") != "success":
        raise _Upstream("the metrics store did not report success")
    data = payload.get("data")
    if not isinstance(data, dict) or data.get("resultType") != result_type:
        raise _Upstream("the metrics store returned an unexpected result type")
    result = data.get("result")
    if not isinstance(result, list) or not all(isinstance(s, dict) for s in result):
        raise _Upstream("the metrics store returned an unexpected result")
    return result


def _sample(pair: Any) -> tuple[float, float]:
    """One ``[timestamp, "value"]`` pair as (timestamp, calls), or _Upstream."""
    if not isinstance(pair, (list, tuple)) or len(pair) != 2:
        raise _Upstream("the metrics store returned a malformed sample")
    ts, raw = pair
    if isinstance(ts, bool) or not isinstance(ts, (int, float)) or not isinstance(raw, str):
        raise _Upstream("the metrics store returned a malformed sample")
    try:
        value = float(raw)
    except ValueError:
        raise _Upstream("the metrics store returned a non-numeric value") from None
    if not math.isfinite(ts) or not math.isfinite(value) or value < 0:
        raise _Upstream("the metrics store returned an impossible value")
    return float(ts), value


def _fold_range(series: list[dict], start: int, end: int, step: int) -> dict[int, list[float]]:
    """Per step mark: the readings of every node that reported at that mark."""
    marks: dict[int, list[float]] = {}
    for one in series:
        values = one.get("values")
        if not isinstance(values, list):
            raise _Upstream("the metrics store returned a series without values")
        for pair in values:
            ts, value = _sample(pair)
            # A point off our grid would silently turn into "no data".
            if ts != int(ts) or not start <= ts <= end or (int(ts) - start) % step:
                raise _Upstream("the metrics store answered on a different time grid")
            marks.setdefault(int(ts), []).append(value)
    return marks


def _fold_instant(series: list[dict]) -> dict | None:
    """The latest fleet total, or None when no node has a fresh reading."""
    readings = []
    for one in series:
        readings.append(_sample(one.get("value")))
    if not readings:
        return None
    return {
        "t": _iso(int(max(ts for ts, _ in readings))),
        "calls": round(sum(value for _, value in readings)),
        "nodes": len(readings),
    }


async def _get_json(client: httpx.AsyncClient, path: str, params: dict[str, str]) -> Any:
    resp = await client.get(f"{_base_url()}{path}", params=params)
    if resp.status_code != 200:
        raise _Upstream(f"the metrics store returned HTTP {resp.status_code}")
    try:
        return resp.json()
    except ValueError:
        raise _Upstream("the metrics store returned a non-JSON response") from None


def _client() -> httpx.AsyncClient:
    """The upstream HTTP client (a function so tests can swap the transport)."""
    return httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_S)


async def _read(start: int, end: int, step: int, now: int) -> tuple[Any, Any]:
    async with _client() as client:
        return await asyncio.gather(
            _get_json(client, "/api/v1/query_range", {
                "query": CALLS_BY_NODE_QUERY,
                "start": str(start), "end": str(end), "step": str(step),
            }),
            _get_json(client, "/api/v1/query", {
                "query": CALLS_BY_NODE_QUERY, "time": str(now),
            }),
        )


@router.get("/calls-active")
async def calls_active(
    hours: int = Query(default=24, ge=1, le=168,
                       description="How far back the series goes, in hours"),
    step_seconds: int = Query(default=300, ge=60, le=3600,
                              description="Seconds between points"),
    admin: dict = Depends(require_admin),
):
    """Fleet-wide connected calls at each step mark, plus the latest value.

    Every ``t`` is an exact multiple of ``step_seconds`` since the Unix epoch
    (UTC). A mark with no fresh reading from any node is ``calls: null``,
    never 0. See docs/CALLS_ACTIVE_API.md.
    """
    now = _now()
    start, end = _window(now, hours, step_seconds)
    try:
        range_payload, instant_payload = await asyncio.wait_for(
            _read(start, end, step_seconds, int(now)), timeout=UPSTREAM_TIMEOUT_S)
        marks = _fold_range(_result_series(range_payload, "matrix"),
                            start, end, step_seconds)
        current = _fold_instant(_result_series(instant_payload, "vector"))
    except (asyncio.TimeoutError, httpx.TimeoutException) as exc:
        logger.error("VictoriaMetrics read timed out at %s: %r", _base_url(), exc)
        return _unavailable("the metrics store did not answer in time")
    except httpx.HTTPError as exc:
        logger.error("VictoriaMetrics unreachable at %s: %r", _base_url(), exc)
        return _unavailable("the metrics store could not be reached")
    except _Upstream as exc:
        logger.error("VictoriaMetrics answer rejected (%s): %s", _base_url(), exc)
        return _unavailable(str(exc))

    points = []
    for ts in range(start, end + 1, step_seconds):
        readings = marks.get(ts)
        points.append({
            "t": _iso(ts),
            "calls": round(sum(readings)) if readings else None,
            "nodes": len(readings) if readings else 0,
        })
    return {
        "step_seconds": step_seconds,
        "start": _iso(start),
        "end": _iso(end),
        "points": points,
        "current": current,
    }
