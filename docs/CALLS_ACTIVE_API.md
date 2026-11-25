# Calls in progress over time — `GET /v1/metrics/calls-active`

A read-only endpoint that returns how many calls were connected on the whole
platform at each step mark of a recent window, plus the latest value. TED
charts it beside MetaSwitch's "calls in progress". Code:
`docker/api/src/routers/metrics.py`. Tests: `tests/test_metrics_calls_active.py`.

It is a platform-wide number. It carries no customer data and takes no
customer filter.

## Request

```
GET /v1/metrics/calls-active?hours=24&step_seconds=300
Authorization: Bearer <session JWT of an admin user>
```

Also mounted without the version prefix (`/metrics/calls-active`), like every
other router.

| Parameter | Type | Default | Limits | Meaning |
|---|---|---|---|---|
| `hours` | integer | `24` | 1 to 168 inclusive | How far back the series goes |
| `step_seconds` | integer | `300` | 60 to 3600 inclusive | Seconds between points |

Both are optional. Anything that is not an integer inside the limits is a 422.
Any other query parameter is ignored. The caller never sends a query
expression: the PromQL is a constant in the code.

**Auth.** Admin role only (`require_admin`), the same gate as `/v1/sbc/stats`
and `GET /v1/live-trunk-stats`. A `support`, `user` or `readonly` session gets
403.

## Response — 200

```json
{
  "step_seconds": 300,
  "start": "2026-11-24T12:00:00Z",
  "end": "2026-11-25T12:00:00Z",
  "points": [
    { "t": "2026-11-24T12:00:00Z", "calls": 412, "nodes": 6 },
    { "t": "2026-11-24T12:05:00Z", "calls": null, "nodes": 0 }
  ],
  "current": { "t": "2026-11-25T12:03:10Z", "calls": 398, "nodes": 6 }
}
```

| Field | Type | Null? | Meaning |
|---|---|---|---|
| `step_seconds` | integer | no | The step used (echo of the parameter) |
| `start` | string | no | Time of the first point |
| `end` | string | no | Time of the last point: the newest completed step |
| `points` | array | no (never empty) | One entry per step mark from `start` to `end`, both included, oldest first, no mark left out |
| `points[].t` | string | no | The step mark |
| `points[].calls` | integer | **yes** | Connected calls on the whole fleet at `t`. `null` = no FreeSWITCH node had a usable reading at `t`. `0` = nodes reported and no call was up |
| `points[].nodes` | integer | no | How many FreeSWITCH nodes `calls` is the sum of (`0` when `calls` is `null`) |
| `current` | object | **yes** | The latest value. `null` = no node has a usable reading right now |
| `current.t` | string | no | The moment `current.calls` is for: when the API asked the metrics store, to the second. Each node's reading behind it can be up to about a minute older |
| `current.calls` | integer | no | Connected calls on the whole fleet at `current.t` |
| `current.nodes` | integer | no | How many nodes `current.calls` is the sum of (at least 1) |

Every time is ISO-8601 in UTC, to the second, always in the form
`YYYY-MM-DDTHH:MM:SSZ`.

### Alignment

- Every `points[].t` is an exact multiple of `step_seconds` since the Unix
  epoch (1970-01-01T00:00:00Z). With the default 300 the marks are :00, :05,
  :10 … of every UTC hour — MetaSwitch's 5-minute marks.
- `end` is the newest step mark that is at least **30 seconds** old. A mark is
  published only after that delay so samples from the other zones have
  arrived; a published point does not change afterwards.
- `start` is the first step mark at or after `end − hours`. The number of
  points is `floor(hours × 3600 / step_seconds) + 1` (289 for the defaults).
- `current.t` is not aligned to the step.

### What `calls` is

`calls` is a snapshot: the calls connected at the mark, the same figure as the
NOC panel "Concurrent calls — live". It is not an average and not a peak over
the step.

Each FreeSWITCH node reports its own count (`freeswitch_calls_active`, from
`show calls count`, read every ~10 s and collected every 15 s). For each mark
the API takes every node's newest reading, at most **60 seconds** old, and adds
them up.

- **Standby nodes.** A standby FreeSWITCH is a separate node that counts only
  the calls it carries itself (normally 0). Adding the nodes never counts a
  call twice.
- **A node that misses a collection or two** keeps its last reading for up to
  60 seconds, so the total does not dip.
- **A node silent for more than 60 seconds** stops counting. The total is then
  the sum of the nodes that did report, and `nodes` is lower than usual. That
  is how a caller can tell a real drop in traffic from a node that went quiet.
- **A node whose FreeSWITCH is not answering** is left out as well. The
  exporter keeps repeating its last good count while it cannot read
  FreeSWITCH (and reports `freeswitch_esl_scrape_ok 0`); without this rule a
  dead FreeSWITCH would keep adding the calls it had when it died. The NOC
  live panel does not apply this rule, so during such an outage this endpoint
  reads lower than the panel.
- **No node at all** gives `calls: null`, never `0`.

The query, per node (the API sums the nodes):

```
max by (freeswitch_node, zone) (last_over_time(freeswitch_calls_active[60s]))
and on (freeswitch_node, zone)
(max by (freeswitch_node, zone) (max_over_time(freeswitch_esl_scrape_ok[60s])) == 1)
```

`max by (freeswitch_node, zone)` gives one value per node even if a node is
ever collected twice. The 60-second window is written into the query, so the
result does not depend on VictoriaMetrics' own rules for old samples.

## Errors

| Status | Body | When |
|---|---|---|
| 401 | `{"detail": "Not authenticated"}` | No session, a bad or expired token, or a disabled user |
| 403 | `{"detail": "Admin access required"}` | A valid session whose role is not `admin` |
| 422 | `{"detail": [ { "type", "loc", "msg", "input", … } ]}` (FastAPI's validation list) | `hours` or `step_seconds` is not an integer inside its limits |
| 503 | `{"detail": "Call metrics are unavailable: <reason>", "code": "metrics_unavailable"}` | The metrics store could not be reached, did not answer within 5 seconds, or its answer was not usable |

On 503 match on `code`; the `detail` sentence is for people and may change.
The API never answers 500 for a metrics-store problem and never returns an
empty or invented series in its place. Retrying after a short wait is safe:
the endpoint only reads.

A 200 whose points are all `null` is different: the metrics store answered and
holds no readings for that window.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `VICTORIAMETRICS_URL` | `http://victoriametrics:8428` | Base URL of the metrics store. The default is the `victoriametrics` service on the services VM's compose network (`services-network`), which the API container is already on. No secret; the API only calls `/api/v1/query_range` and `/api/v1/query` |

The whole read is limited to 5 seconds. The local dev stack
(`docker-compose.yml`) has no VictoriaMetrics, so there the endpoint answers
503 unless the variable points at one.
