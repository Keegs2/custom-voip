#!/usr/bin/env python3
"""vm-forwarder — deliver voicemail that FreeSWITCH SEALED to its spool while
the East API was unreachable (Visual IVR plan D11 / §7.5; contract
docs/IVR_INTERFACES.md §7 + §8.4; design docs/VOICEMAIL_OUTAGE_RESILIENCE.md).

One container per media VM (docker-compose.media.yml ``vm-forwarder``), host
network, Python stdlib only, NO KEYS: it moves ciphertext it cannot read.

    /var/lib/crag/vm-spool/<msg_uuid>.cms    CMS AuthEnvelopedData (lib/vm_spool.lua)
    /var/lib/crag/vm-spool/<msg_uuid>.json   the X-VM-Meta fields (plaintext metadata)
    /var/lib/crag/vm-spool/rejected/         422'd / unusable pairs, kept for triage
    /var/lib/crag/vm-spool/audit/spool-audit.jsonl   append-only drop/reject journal

Loop (every SCAN_INTERVAL_S):
  1. scan the spool;
  2. enforce the caps — age: anything (pending or rejected) whose
     received_at is older than VM_SPOOL_MAX_AGE_DAYS (7) is dropped; size:
     while the spool holds more than VM_SPOOL_MAX_BYTES (2 GiB) the OLDEST
     rejected pair goes first, then the oldest pending one. Every drop is
     journaled (audit/spool-audit.jsonl, fsync'd) and logged;
  3. sweep leftovers older than an hour (a crash between FS's writes):
     *.tmp deleted, a .json without its .cms deleted, a .cms without its
     .json moved to rejected/ (journaled);
  4. unless backing off, replay pending messages OLDEST FIRST:
       POST http://API_HOST:API_PORT/v1/voicemail/fs/deposit-sealed
       X-Ingest-Secret  (read from /run/revup/vm_ingest.header on every send)
       X-VM-Meta        base64url (no padding) of the sidecar's exact bytes
       body             the .cms bytes
     201 / 200 with status stored|duplicate -> delete the pair
     410                                   -> delete (the API audited the
                                              drop), journal it
     422                                   -> move to rejected/, journal it
     anything else (503, 5xx, 401, 404 = an API without the route, network
     error, a 2xx without the status) -> keep; exponential backoff
     (5 s .. 5 min, +/- 20 % jitter) for the WHOLE queue — an outage is
     global, so one failure pauses the pass instead of hammering East.

Metrics (Prometheus text, http://127.0.0.1:9105/metrics, scraped by the
co-located vmagent — docker/vmagent/scrape-media.yml job vm_forwarder) for a
dashboard tile; NO alerting by design (owner: no pagers):
  vm_spool_messages{state}  vm_spool_bytes{state}  vm_spool_oldest_age_seconds
  vm_spool_forwarded_total{result}  vm_spool_dropped_total{reason}
  vm_spool_send_failures_total  vm_spool_api_reachable  vm_spool_last_scan_timestamp_seconds
/healthz answers 200 while the loop has run in the last 120 s (compose healthcheck).

Never logged: the ingest secret, caller numbers/names, file contents. The
journal and logs carry msg_uuid, mailbox_id, received_at, sizes and reasons.
"""
from __future__ import annotations

import base64
import http.client
import json
import logging
import os
import random
import re
import signal
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = logging.getLogger("vm-forwarder")

UUID4_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
HOST_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.-]*$")
SECRET_RE = re.compile(r"^X-Ingest-Secret: ([!-~]+)$")
PATH = "/v1/voicemail/fs/deposit-sealed"
SIDECAR_MAX = 4096
RESPONSE_MAX = 65536
JOURNAL_MAX = 10 * 1024 * 1024


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        v = int(raw)
    except ValueError:
        LOG.warning("%s=%r is not an integer — using %d", name, raw, default)
        return default
    if not lo <= v <= hi:
        LOG.warning("%s=%d outside %d..%d — using %d", name, v, lo, hi, default)
        return default
    return v


class Config:
    def __init__(self) -> None:
        self.spool_dir = os.getenv("VM_SPOOL_DIR") or "/var/lib/crag/vm-spool"
        self.header_file = os.getenv("VM_INGEST_HEADER_FILE") or "/run/revup/vm_ingest.header"
        self.api_host = (os.getenv("API_HOST") or "").strip()
        self.api_port = (os.getenv("API_PORT") or "8000").strip() or "8000"
        self.max_age_s = _env_int("VM_SPOOL_MAX_AGE_DAYS", 7, 1, 30) * 86400
        self.max_bytes = _env_int("VM_SPOOL_MAX_BYTES", 2 * 1024 ** 3, 1024 ** 2, 64 * 1024 ** 3)
        self.scan_interval_s = _env_int("VM_FORWARDER_SCAN_S", 10, 1, 300)
        self.backoff_min_s = _env_int("VM_FORWARDER_BACKOFF_MIN_S", 5, 1, 600)
        self.backoff_max_s = _env_int("VM_FORWARDER_BACKOFF_MAX_S", 300, 1, 3600)
        self.http_timeout_s = _env_int("VM_FORWARDER_HTTP_TIMEOUT_S", 60, 5, 600)
        self.orphan_age_s = 3600
        self.metrics_host = os.getenv("VM_FORWARDER_METRICS_HOST") or "127.0.0.1"
        self.metrics_port = _env_int("VM_FORWARDER_METRICS_PORT", 9105, 0, 65535)

    def api_ok(self) -> tuple[bool, str]:
        if not self.api_host:
            return False, "API_HOST unset"
        if len(self.api_host) > 253 or not HOST_RE.match(self.api_host):
            return False, "API_HOST is not a plain hostname/IPv4"
        if not self.api_port.isdigit() or not 1 <= int(self.api_port) <= 65535:
            return False, "API_PORT invalid"
        return True, ""


class Msg:
    __slots__ = ("uuid", "cms", "json", "size", "received", "mailbox_id", "sidecar", "error")

    def __init__(self, uuid: str, cms: str, json_path: str):
        self.uuid = uuid
        self.cms = cms
        self.json = json_path
        self.size = 0
        self.received = 0.0          # epoch seconds (received_at, else mtime)
        self.mailbox_id = None
        self.sidecar = b""
        self.error = None            # why the sidecar is unusable


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _parse_received(value) -> float | None:
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        ts = datetime.fromisoformat(value)
    except ValueError:
        return None
    if ts.tzinfo is None:
        return None
    return ts.timestamp()


class Forwarder:
    def __init__(self, cfg: Config, clock=time.time) -> None:
        self.cfg = cfg
        self.clock = clock
        self.lock = threading.Lock()
        self.backoff_s = 0.0
        self.next_attempt = 0.0
        self.last_scan = 0.0
        self.api_reachable = 0
        self.forwarded = {"stored": 0, "duplicate": 0, "dropped": 0, "rejected": 0}
        self.dropped = {"age": 0, "size": 0, "orphan": 0, "bad_sidecar": 0}
        self.send_failures = 0
        self.gauges = {"pending": (0, 0), "rejected": (0, 0), "oldest_age": 0.0}
        self.rejected_dir = os.path.join(cfg.spool_dir, "rejected")
        self.audit_dir = os.path.join(cfg.spool_dir, "audit")
        self.journal = os.path.join(self.audit_dir, "spool-audit.jsonl")

    # ------------------------------------------------------------------
    # filesystem
    # ------------------------------------------------------------------
    def prepare(self) -> None:
        os.umask(0o077)
        for d in (self.cfg.spool_dir, self.rejected_dir, self.audit_dir):
            os.makedirs(d, mode=0o700, exist_ok=True)
            try:
                os.chmod(d, 0o700)
            except OSError as exc:
                LOG.warning("chmod 0700 %s failed: %s", d, exc)

    def _scan_dir(self, d: str) -> tuple[dict[str, Msg], list[tuple[str, float]], list[str]]:
        """-> {uuid: Msg} for complete pairs, [(leftover path, mtime)], [names]."""
        try:
            names = os.listdir(d)
        except FileNotFoundError:
            return {}, [], []
        cms, js, leftovers = {}, {}, []
        for n in names:
            p = os.path.join(d, n)
            if n.endswith(".tmp"):
                leftovers.append(p)
                continue
            stem, dot, ext = n.rpartition(".")
            if not dot or not UUID4_RE.match(stem):
                continue
            if ext == "cms":
                cms[stem] = p
            elif ext == "json":
                js[stem] = p
        pairs: dict[str, Msg] = {}
        orphans: list[tuple[str, float]] = []
        for u, p in cms.items():
            if u in js:
                pairs[u] = Msg(u, p, js[u])
            else:
                orphans.append((p, self._mtime(p)))
        for u, p in js.items():
            if u not in cms:
                orphans.append((p, self._mtime(p)))
        for p in leftovers:
            orphans.append((p, self._mtime(p)))
        return pairs, orphans, names

    @staticmethod
    def _mtime(p: str) -> float:
        try:
            return os.stat(p).st_mtime
        except OSError:
            return 0.0

    def _load(self, m: Msg) -> None:
        try:
            m.size = os.stat(m.cms).st_size + os.stat(m.json).st_size
        except OSError:
            m.size = 0
        try:
            with open(m.json, "rb") as f:
                raw = f.read(SIDECAR_MAX + 1)
        except OSError as exc:
            m.error = f"sidecar unreadable: {exc.__class__.__name__}"
            m.received = self._mtime(m.cms)
            return
        m.received = self._mtime(m.cms)
        if len(raw) > SIDECAR_MAX:
            m.error = "sidecar too large"
            return
        try:
            obj = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            m.error = "sidecar is not JSON"
            return
        if not isinstance(obj, dict) or obj.get("msg_uuid") != m.uuid:
            m.error = "sidecar msg_uuid does not match the file name"
            return
        ts = _parse_received(obj.get("received_at"))
        if ts is None:
            m.error = "sidecar received_at is not an ISO-8601 timestamp"
            return
        mb = obj.get("mailbox_id")
        m.mailbox_id = mb if isinstance(mb, int) and not isinstance(mb, bool) else None
        m.received = ts
        m.sidecar = raw

    def scan(self) -> tuple[list[Msg], list[Msg], list[tuple[str, float]]]:
        pending, orphans, _ = self._scan_dir(self.cfg.spool_dir)
        rejected, rorphans, _ = self._scan_dir(self.rejected_dir)
        for m in list(pending.values()) + list(rejected.values()):
            self._load(m)
        p = sorted(pending.values(), key=lambda m: (m.received, m.uuid))
        r = sorted(rejected.values(), key=lambda m: (m.received, m.uuid))
        return p, r, orphans + rorphans

    def _remove_pair(self, m: Msg) -> None:
        for p in (m.cms, m.json):          # ciphertext first: never a .cms without metadata
            try:
                os.remove(p)
            except FileNotFoundError:
                pass

    def _reject_pair(self, m: Msg) -> None:
        for p in (m.json, m.cms):
            try:
                os.replace(p, os.path.join(self.rejected_dir, os.path.basename(p)))
            except FileNotFoundError:
                pass

    def audit(self, event: str, m: Msg | None = None, **extra) -> None:
        """Append one line to the journal (fsync'd) and log it. No caller data."""
        entry = {"ts": datetime.now(timezone.utc).isoformat(timespec="seconds"), "event": event}
        if m is not None:
            entry.update({"msg_uuid": m.uuid, "mailbox_id": m.mailbox_id, "bytes": m.size,
                          "received_at": datetime.fromtimestamp(m.received, timezone.utc)
                          .isoformat(timespec="seconds") if m.received else None})
        entry.update(extra)
        line = json.dumps(entry, separators=(",", ":"), sort_keys=True)
        LOG.warning("AUDIT %s", line)
        try:
            if os.path.exists(self.journal) and os.path.getsize(self.journal) > JOURNAL_MAX:
                os.replace(self.journal, self.journal + ".1")
            fd = os.open(self.journal, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            try:
                os.write(fd, (line + "\n").encode("utf-8"))
                os.fsync(fd)
            finally:
                os.close(fd)
        except OSError as exc:
            LOG.error("could not write the spool audit journal: %s", exc)

    # ------------------------------------------------------------------
    # caps + leftovers
    # ------------------------------------------------------------------
    def enforce(self, pending: list[Msg], rejected: list[Msg], orphans, now: float) -> list[Msg]:
        """Age + size caps (oldest first) and leftover sweep. Returns the
        pending messages still to send."""
        keep_p, keep_r = [], []
        for m in rejected:
            if now - m.received > self.cfg.max_age_s:
                self._remove_pair(m)
                self.dropped["age"] += 1
                self.audit("dropped_age", m, where="rejected")
            else:
                keep_r.append(m)
        for m in pending:
            if now - m.received > self.cfg.max_age_s:
                self._remove_pair(m)
                self.dropped["age"] += 1
                self.audit("dropped_age", m, where="pending")
            else:
                keep_p.append(m)
        total = sum(m.size for m in keep_p) + sum(m.size for m in keep_r)
        while total > self.cfg.max_bytes and (keep_r or keep_p):
            victim, where = (keep_r.pop(0), "rejected") if keep_r else (keep_p.pop(0), "pending")
            self._remove_pair(victim)
            total -= victim.size
            self.dropped["size"] += 1
            self.audit("dropped_size", victim, where=where, spool_bytes=total,
                       cap_bytes=self.cfg.max_bytes)
        for path, mtime in orphans:
            if now - mtime <= self.cfg.orphan_age_s:
                continue
            name = os.path.basename(path)
            try:
                if name.endswith(".cms") and os.path.dirname(path) == self.cfg.spool_dir:
                    os.replace(path, os.path.join(self.rejected_dir, name))
                    self.dropped["orphan"] += 1
                    self.audit("orphan_no_metadata", None, msg_uuid=name[:-4])
                else:
                    os.remove(path)
                    LOG.info("removed leftover %s", name)
            except FileNotFoundError:
                pass
        with self.lock:
            self.gauges = {
                "pending": (len(keep_p), sum(m.size for m in keep_p)),
                "rejected": (len(keep_r), sum(m.size for m in keep_r)),
                "oldest_age": max(0.0, now - keep_p[0].received) if keep_p else 0.0,
            }
        return keep_p

    # ------------------------------------------------------------------
    # HTTP
    # ------------------------------------------------------------------
    def _secret(self) -> str | None:
        try:
            with open(self.cfg.header_file, "r", encoding="ascii", errors="replace") as f:
                content = f.read(4097)
        except OSError:
            return None
        if len(content) > 4096:
            return None
        content = content.replace("\r", "").strip()
        m = SECRET_RE.match(content)
        if not m or len(m.group(1)) < 32:
            return None
        return m.group(1)

    def send(self, m: Msg) -> tuple[str, int, str]:
        """-> (outcome, http status (0 = none), short detail). outcome in
        stored | duplicate | gone | rejected | retry."""
        ok, why = self.cfg.api_ok()
        if not ok:
            return "retry", 0, why
        secret = self._secret()
        if secret is None:
            return "retry", 0, f"ingest header file {self.cfg.header_file} missing or invalid"
        try:
            with open(m.cms, "rb") as f:
                body = f.read()
        except OSError as exc:
            return "retry", 0, f"blob unreadable: {exc.__class__.__name__}"
        conn = http.client.HTTPConnection(self.cfg.api_host, int(self.cfg.api_port),
                                          timeout=self.cfg.http_timeout_s)
        try:
            conn.request("POST", PATH, body=body, headers={
                "Content-Type": "application/octet-stream",
                "X-Ingest-Secret": secret,
                "X-VM-Meta": _b64url(m.sidecar),
                "Content-Length": str(len(body)),
                "User-Agent": "crag-vm-forwarder/1",
            })
            resp = conn.getresponse()
            status = resp.status
            raw = resp.read(RESPONSE_MAX)
        except (OSError, http.client.HTTPException) as exc:
            self.api_reachable = 0
            return "retry", 0, f"{exc.__class__.__name__}: {exc}"[:200]
        finally:
            conn.close()
        self.api_reachable = 1
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, ValueError):
            payload = {}
        detail = str(payload.get("detail") or payload.get("status") or "")[:200] \
            if isinstance(payload, dict) else ""
        if status in (200, 201) and isinstance(payload, dict) \
                and payload.get("status") in ("stored", "duplicate"):
            return ("stored" if status == 201 else "duplicate"), status, detail
        if status == 410:
            return "gone", status, detail
        if status == 422:
            return "rejected", status, detail
        return "retry", status, detail or f"http {status}"

    # ------------------------------------------------------------------
    # loop
    # ------------------------------------------------------------------
    def _backoff(self, now: float) -> None:
        self.backoff_s = min(float(self.cfg.backoff_max_s),
                             max(float(self.cfg.backoff_min_s), self.backoff_s * 2))
        self.next_attempt = now + self.backoff_s * random.uniform(0.8, 1.2)

    def run_once(self) -> None:
        now = self.clock()
        pending, rejected, orphans = self.scan()
        pending = self.enforce(pending, rejected, orphans, now)
        self.last_scan = now
        if not pending or now < self.next_attempt:
            return
        for m in pending:
            if m.error:
                self._reject_pair(m)
                self.dropped["bad_sidecar"] += 1
                self.audit("rejected_bad_sidecar", m, detail=m.error)
                continue
            outcome, status, detail = self.send(m)
            if outcome in ("stored", "duplicate"):
                self._remove_pair(m)
                self.forwarded[outcome] += 1
                LOG.info("delivered %s (mailbox %s): http %d %s", m.uuid, m.mailbox_id, status,
                         outcome)
                self.backoff_s = 0.0
            elif outcome == "gone":
                self._remove_pair(m)
                self.forwarded["dropped"] += 1
                self.audit("api_dropped_410", m, detail=detail)
                self.backoff_s = 0.0
            elif outcome == "rejected":
                self._reject_pair(m)
                self.forwarded["rejected"] += 1
                self.audit("api_rejected_422", m, detail=detail)
            else:
                self.send_failures += 1
                self._backoff(self.clock())
                LOG.warning("send %s failed (%s) — keeping it; next attempt in %.0f s",
                            m.uuid, detail or f"http {status}", self.backoff_s)
                break
        # what was sent/removed this pass is reflected at the next scan

    # ------------------------------------------------------------------
    # metrics
    # ------------------------------------------------------------------
    def metrics_text(self) -> str:
        with self.lock:
            g = dict(self.gauges)
        out = [
            "# HELP vm_spool_messages Sealed voicemail messages held in the media VM spool.",
            "# TYPE vm_spool_messages gauge",
            f'vm_spool_messages{{state="pending"}} {g["pending"][0]}',
            f'vm_spool_messages{{state="rejected"}} {g["rejected"][0]}',
            "# HELP vm_spool_bytes Bytes of sealed voicemail (ciphertext + metadata) in the spool.",
            "# TYPE vm_spool_bytes gauge",
            f'vm_spool_bytes{{state="pending"}} {g["pending"][1]}',
            f'vm_spool_bytes{{state="rejected"}} {g["rejected"][1]}',
            "# HELP vm_spool_oldest_age_seconds Age of the oldest undelivered message (0 = none).",
            "# TYPE vm_spool_oldest_age_seconds gauge",
            f"vm_spool_oldest_age_seconds {g['oldest_age']:.0f}",
            "# HELP vm_spool_forwarded_total Replays answered by the API, by result.",
            "# TYPE vm_spool_forwarded_total counter",
        ]
        out += [f'vm_spool_forwarded_total{{result="{k}"}} {v}' for k, v in self.forwarded.items()]
        out += ["# HELP vm_spool_dropped_total Messages dropped by the forwarder's caps, by reason.",
                "# TYPE vm_spool_dropped_total counter"]
        out += [f'vm_spool_dropped_total{{reason="{k}"}} {v}' for k, v in self.dropped.items()]
        out += [
            "# HELP vm_spool_send_failures_total Replays that got no usable answer (kept, retried).",
            "# TYPE vm_spool_send_failures_total counter",
            f"vm_spool_send_failures_total {self.send_failures}",
            "# HELP vm_spool_api_reachable 1 if the last replay got an HTTP answer from the API.",
            "# TYPE vm_spool_api_reachable gauge",
            f"vm_spool_api_reachable {self.api_reachable}",
            "# HELP vm_spool_last_scan_timestamp_seconds When the forwarder last scanned the spool.",
            "# TYPE vm_spool_last_scan_timestamp_seconds gauge",
            f"vm_spool_last_scan_timestamp_seconds {self.last_scan:.0f}",
        ]
        return "\n".join(out) + "\n"

    def healthy(self) -> bool:
        return self.clock() - self.last_scan < 120


def serve_metrics(fw: Forwarder) -> ThreadingHTTPServer | None:
    if fw.cfg.metrics_port == 0:
        return None

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            if self.path == "/metrics":
                body, code, ctype = fw.metrics_text().encode(), 200, "text/plain; version=0.0.4"
            elif self.path == "/healthz":
                ok = fw.healthy()
                body, code, ctype = (b"ok\n" if ok else b"stale\n"), (200 if ok else 503), "text/plain"
            else:
                body, code, ctype = b"not found\n", 404, "text/plain"
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):  # scrape noise
            return

    srv = ThreadingHTTPServer((fw.cfg.metrics_host, fw.cfg.metrics_port), Handler)
    threading.Thread(target=srv.serve_forever, name="metrics", daemon=True).start()
    return srv


def main() -> int:
    logging.basicConfig(stream=sys.stdout, level=logging.INFO,
                        format="%(asctime)s vm-forwarder %(levelname)s %(message)s")
    cfg = Config()
    ok, why = cfg.api_ok()
    if not ok:
        LOG.error("%s — messages stay in the spool until it is fixed", why)
    fw = Forwarder(cfg)
    fw.prepare()
    serve_metrics(fw)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    LOG.info("started: spool %s, API %s:%s, caps %d days / %d bytes, metrics %s:%d",
             cfg.spool_dir, cfg.api_host or "?", cfg.api_port, cfg.max_age_s // 86400,
             cfg.max_bytes, cfg.metrics_host, cfg.metrics_port)
    while not stop.is_set():
        try:
            fw.run_once()
        except Exception:  # noqa: BLE001 — never die; the spool is the source of truth
            LOG.exception("forwarder pass failed")
        stop.wait(cfg.scan_interval_s)
    LOG.info("stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
