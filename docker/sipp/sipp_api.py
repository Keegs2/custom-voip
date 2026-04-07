"""
SIPp Testing Microservice
Wraps SIPp with an HTTP API so the web UI can trigger SIP load tests.
"""

import asyncio
import csv
import io
import logging
import os
import re
import signal
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, field_validator

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="SIPp Test Runner", version="1.0.0")

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------
_lock = asyncio.Lock()
_running_process: Optional[asyncio.subprocess.Process] = None
_last_test_time: Optional[str] = None

# Hardcoded target host -- never let the caller choose the SIP destination IP
SIPP_TARGET_HOST = "freeswitch"
SIPP_TARGET_PORT = 5080
STAT_FILE = "/tmp/sipp_stat.csv"

# ---------------------------------------------------------------------------
# Presets
# ---------------------------------------------------------------------------
PRESETS: list[dict] = [
    {
        "id": "connectivity",
        "name": "Connectivity Test",
        "description": "Single call to echo extension - verifies SIP connectivity",
        "defaults": {"target": "9196", "rate": 1, "calls": 1, "timeout": 10, "duration": 0},
    },
    {
        "id": "echo_load",
        "name": "Echo Load Test",
        "description": "High-rate calls to echo extension - measures raw FreeSWITCH CPS capacity",
        "defaults": {"target": "9196", "rate": 100, "calls": 1000, "timeout": 60, "duration": 0},
    },
    {
        "id": "rcf_single",
        "name": "RCF Routing Test",
        "description": "Single call through RCF pipeline - verifies Lua/Redis/DB routing",
        "defaults": {"target": "+15551234567", "rate": 1, "calls": 1, "timeout": 10, "duration": 0},
    },
    {
        "id": "rcf_load",
        "name": "RCF Load Test",
        "description": "Load test through full RCF routing pipeline - measures end-to-end CPS",
        "defaults": {"target": "+15551234567", "rate": 50, "calls": 500, "timeout": 60, "duration": 0},
    },
    {
        "id": "sustained",
        "name": "Sustained Call Test",
        "description": "Calls with hold duration - tests concurrent session capacity",
        "defaults": {"target": "9196", "rate": 50, "calls": 500, "timeout": 120, "duration": 5000},
    },
    {
        "id": "stress",
        "name": "Stress Test",
        "description": "Maximum rate test to find the CPS ceiling",
        "defaults": {"target": "9196", "rate": 300, "calls": 3000, "timeout": 60, "duration": 0},
    },
]

PRESET_MAP = {p["id"]: p for p in PRESETS}

# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class RunRequest(BaseModel):
    preset: Optional[str] = None
    target: Optional[str] = None
    rate: Optional[int] = None
    calls: Optional[int] = None
    timeout: Optional[int] = None
    duration: Optional[int] = None

    @field_validator("rate")
    @classmethod
    def validate_rate(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and not (1 <= v <= 500):
            raise ValueError("rate must be between 1 and 500")
        return v

    @field_validator("calls")
    @classmethod
    def validate_calls(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and not (1 <= v <= 10000):
            raise ValueError("calls must be between 1 and 10000")
        return v

    @field_validator("timeout")
    @classmethod
    def validate_timeout(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and not (5 <= v <= 120):
            raise ValueError("timeout must be between 5 and 120")
        return v

    @field_validator("duration")
    @classmethod
    def validate_duration(cls, v: Optional[int]) -> Optional[int]:
        if v is not None and not (0 <= v <= 30000):
            raise ValueError("duration must be between 0 and 30000")
        return v


class TestConfig(BaseModel):
    target: str
    rate: int
    calls: int
    timeout: int
    duration: int


class TestResults(BaseModel):
    total_calls: int = 0
    successful: int = 0
    failed: int = 0
    retransmissions: int = 0
    effective_cps: float = 0.0
    elapsed_seconds: float = 0.0
    peak_concurrent: int = 0
    invite_sent: int = 0
    response_100: int = 0
    response_200: int = 0
    timeouts: int = 0
    unexpected_msg: int = 0


class RunResponse(BaseModel):
    status: str  # "completed", "error", "timeout"
    preset: Optional[str] = None
    config: TestConfig
    results: TestResults
    verdict: str  # "PASS", "WARN", "FAIL"
    raw_output: str


class StatusResponse(BaseModel):
    running: bool
    last_test: Optional[str] = None


# ---------------------------------------------------------------------------
# SIPp output parsing
# ---------------------------------------------------------------------------

def _parse_sipp_output(output: str) -> TestResults:
    """Parse SIPp stdout to extract test statistics."""
    results = TestResults()

    # Successful calls:  "Successful call        |   <current>  |  <cumulative>"
    m = re.search(r"Successful\s+call\s*\|\s*\d+\s*\|\s*(\d+)", output)
    if m:
        results.successful = int(m.group(1))

    # Failed calls
    m = re.search(r"Failed\s+call\s*\|\s*\d+\s*\|\s*(\d+)", output)
    if m:
        results.failed = int(m.group(1))

    results.total_calls = results.successful + results.failed

    # Effective CPS:  "Call Rate |  <current> cps |  <cumulative> cps"
    m = re.search(r"Call\s+Rate\s*\|\s*[\d.]+\s*cps\s*\|\s*([\d.]+)\s*cps", output)
    if m:
        results.effective_cps = float(m.group(1))

    # INVITE sent (cumulative column)
    m = re.search(r"INVITE\s+[-]+>\s+(\d+)", output)
    if m:
        results.invite_sent = int(m.group(1))

    # 100 response (cumulative)
    m = re.search(r"100\s+<[-]+\s+(\d+)", output)
    if m:
        results.response_100 = int(m.group(1))

    # 200 response (cumulative)
    m = re.search(r"200\s+<[-]+\s+E?-?RTD\d?\s*(\d+)", output)
    if m:
        results.response_200 = int(m.group(1))
    else:
        # Fallback: simpler pattern for 200 without RTD tag
        m = re.search(r"200\s+<[-]+\s+(\d+)", output)
        if m:
            results.response_200 = int(m.group(1))

    # Retransmissions -- sum the "Retrans" column values from scenario lines
    retrans_values = re.findall(
        r"(?:INVITE|ACK|BYE|CANCEL|100|180|183|200)\s+[<>-]+\s+\d+\s+(\d+)", output
    )
    results.retransmissions = sum(int(v) for v in retrans_values)

    # Timeouts
    m = re.search(r"Timeout\s*\|\s*\d+\s*\|\s*(\d+)", output)
    if m:
        results.timeouts = int(m.group(1))
    else:
        m = re.search(r"Timeout\(s\)\s*:\s*(\d+)", output)
        if m:
            results.timeouts = int(m.group(1))

    # Unexpected messages
    m = re.search(r"Unexpected\s+msg\s*\|\s*\d+\s*\|\s*(\d+)", output)
    if m:
        results.unexpected_msg = int(m.group(1))

    return results


def _parse_stat_csv() -> dict:
    """Parse the SIPp CSV stat file for additional metrics."""
    extras: dict = {}
    try:
        with open(STAT_FILE, "r") as f:
            content = f.read()
        # The CSV may have a header starting with "StartTime" or similar
        reader = csv.DictReader(io.StringIO(content), delimiter=";")
        rows = list(reader)
        if rows:
            last = rows[-1]
            # Try to extract peak concurrent calls
            for key in ("CurrentCall", "CurrentCalls", "TotalCurrentCalls"):
                if key in last:
                    try:
                        extras["peak_concurrent"] = max(
                            int(row.get(key, 0) or 0) for row in rows
                        )
                    except (ValueError, TypeError):
                        pass
                    break
            # Elapsed time from first to last row
            if len(rows) >= 2:
                for key in ("ElapsedTime", "ElapsedTime(C)"):
                    if key in rows[-1]:
                        try:
                            elapsed_ms = float(rows[-1][key])
                            extras["elapsed_seconds"] = round(elapsed_ms / 1000.0, 2)
                        except (ValueError, TypeError):
                            pass
                        break
    except FileNotFoundError:
        logger.warning("SIPp stat CSV not found at %s", STAT_FILE)
    except Exception:
        logger.exception("Error parsing SIPp stat CSV")
    return extras


def _compute_verdict(results: TestResults) -> str:
    """Determine pass/warn/fail based on failure ratio."""
    if results.total_calls == 0:
        return "FAIL"
    failure_rate = results.failed / results.total_calls
    if failure_rate == 0:
        return "PASS"
    elif failure_rate < 0.05:
        return "WARN"
    else:
        return "FAIL"


# ---------------------------------------------------------------------------
# Process management helpers
# ---------------------------------------------------------------------------

async def _kill_running() -> None:
    """Kill any currently running SIPp process."""
    global _running_process
    if _running_process is not None and _running_process.returncode is None:
        logger.info("Killing existing SIPp process (pid=%s)", _running_process.pid)
        try:
            os.kill(_running_process.pid, signal.SIGTERM)
            await asyncio.sleep(0.5)
            if _running_process.returncode is None:
                os.kill(_running_process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        _running_process = None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/sipp/presets")
async def get_presets() -> list[dict]:
    """Return available test presets."""
    return PRESETS


@app.get("/sipp/status")
async def get_status() -> StatusResponse:
    """Return whether a test is currently running."""
    running = _lock.locked()
    return StatusResponse(running=running, last_test=_last_test_time)


@app.post("/sipp/run")
async def run_test(req: RunRequest) -> RunResponse:
    """Run a SIPp test. Only one test may run at a time."""
    global _last_test_time, _running_process

    # Resolve config from preset defaults + explicit overrides
    defaults = {"target": "9196", "rate": 1, "calls": 1, "timeout": 10, "duration": 0}
    if req.preset:
        if req.preset not in PRESET_MAP:
            raise HTTPException(status_code=400, detail=f"Unknown preset: {req.preset}")
        defaults = {**PRESET_MAP[req.preset]["defaults"]}

    config = TestConfig(
        target=req.target if req.target is not None else defaults["target"],
        rate=req.rate if req.rate is not None else defaults["rate"],
        calls=req.calls if req.calls is not None else defaults["calls"],
        timeout=req.timeout if req.timeout is not None else defaults["timeout"],
        duration=req.duration if req.duration is not None else defaults["duration"],
    )

    # Re-validate merged values against limits
    if not (1 <= config.rate <= 500):
        raise HTTPException(status_code=400, detail="rate must be between 1 and 500")
    if not (1 <= config.calls <= 10000):
        raise HTTPException(status_code=400, detail="calls must be between 1 and 10000")
    if not (5 <= config.timeout <= 120):
        raise HTTPException(status_code=400, detail="timeout must be between 5 and 120")
    if not (0 <= config.duration <= 30000):
        raise HTTPException(status_code=400, detail="duration must be between 0 and 30000")

    # Acquire global lock -- only one test at a time
    if _lock.locked():
        raise HTTPException(status_code=409, detail="A test is already running")

    async with _lock:
        await _kill_running()

        # Clean up old stat file
        try:
            os.remove(STAT_FILE)
        except FileNotFoundError:
            pass

        # Build SIPp command -- target host is hardcoded for safety
        cmd = [
            "sipp",
            "-sn", "uac",
            f"{SIPP_TARGET_HOST}:{SIPP_TARGET_PORT}",
            "-s", config.target,
            "-m", str(config.calls),
            "-r", str(config.rate),
            "-rp", "1000",
            "-timeout", str(config.timeout),
            "-trace_stat",
            "-stf", STAT_FILE,
            "-fd", "1",
            "-nostdin",
        ]

        if config.duration > 0:
            cmd.extend(["-d", str(config.duration)])

        logger.info("Running SIPp: %s", " ".join(cmd))

        status = "completed"
        raw_output = ""
        results = TestResults()

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            _running_process = proc

            # Wait with a generous timeout (config.timeout + buffer)
            effective_timeout = config.timeout + 30
            try:
                stdout_bytes, _ = await asyncio.wait_for(
                    proc.communicate(), timeout=effective_timeout
                )
                raw_output = stdout_bytes.decode("utf-8", errors="replace") if stdout_bytes else ""
            except asyncio.TimeoutError:
                status = "timeout"
                logger.warning("SIPp process timed out after %ds", effective_timeout)
                await _kill_running()
                raw_output = "(process killed after timeout)"

            _running_process = None

            # Parse results
            results = _parse_sipp_output(raw_output)

            # Augment with CSV data
            csv_extras = _parse_stat_csv()
            if "peak_concurrent" in csv_extras:
                results.peak_concurrent = csv_extras["peak_concurrent"]
            if "elapsed_seconds" in csv_extras:
                results.elapsed_seconds = csv_extras["elapsed_seconds"]

            # If elapsed_seconds is still 0 but we have CPS data, estimate it
            if results.elapsed_seconds == 0 and results.effective_cps > 0:
                results.elapsed_seconds = round(
                    results.total_calls / results.effective_cps, 2
                )

        except Exception as exc:
            status = "error"
            raw_output = str(exc)
            logger.exception("Error running SIPp")

        _last_test_time = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        verdict = _compute_verdict(results)

        # Trim raw output to last 50 lines for the response
        output_lines = raw_output.strip().splitlines()
        trimmed_output = "\n".join(output_lines[-50:]) if output_lines else ""

        return RunResponse(
            status=status,
            preset=req.preset,
            config=config,
            results=results,
            verdict=verdict,
            raw_output=trimmed_output,
        )
