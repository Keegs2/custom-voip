"""In-memory fake of the three ClickHouse queries the Homer router ships.

Shared by tests/test_homer_number_search.py, tests/test_homer_pcap_export.py
and tests/test_homer_leg_correlation.py.  It answers the router's REAL SQL
(parsed, not pattern-stubbed) against a store of JSONEachRow-shaped rows:

  * fetch-by-Call-ID   (``time_series_gin`` ... ``val IN (...)``): rows of the
    listed Call-IDs inside ``s.timestamp_ns >= X AND s.timestamp_ns < Y``,
    ORDER BY ts, LIMIT n;
  * X-CID scan         (``multiSearchAny``): rows inside the OR-ed
    ``timestamp_ns`` ranges whose text contains any needle, with the
    header-anchored X-CID / Call-ID extract applied exactly like ClickHouse
    (the RE2 patterns are compiled here with Python ``re`` — same grammar),
    grouped by (fingerprint, xcid, hdr_callid), HAVING xcid != '';
  * fingerprint map    (``FROM <db>.time_series`` + ``fingerprint IN``).

Literals are parsed with ClickHouse backslash-escape rules, so a wrongly
escaped value in the router's SQL fails these tests.  ``fail`` injects HTTP
500s per query kind; every request is recorded in ``calls`` for assertions.
"""
import json
import re
import zlib

_LIT_RE = re.compile(r"'((?:[^'\\]|\\.)*)'")
_ESC = {"n": "\n", "r": "\r", "t": "\t", "0": "\0", "\\": "\\", "'": "'"}


def _unescape(body):
    out, i = [], 0
    while i < len(body):
        c = body[i]
        if c == "\\" and i + 1 < len(body):
            n = body[i + 1]
            if n == "x" and i + 3 < len(body):
                out.append(chr(int(body[i + 2:i + 4], 16)))
                i += 4
                continue
            out.append(_ESC.get(n, n))
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def literals(fragment):
    return [_unescape(m.group(1)) for m in _LIT_RE.finditer(fragment)]


def _bracket_body(sql, opener, open_ch, close_ch):
    """Text between ``opener`` + matching close bracket, quote-aware."""
    start = sql.index(opener) + len(opener)
    depth, i, in_q = 1, start, False
    while i < len(sql):
        c = sql[i]
        if in_q:
            if c == "\\":
                i += 2
                continue
            if c == "'":
                in_q = False
        elif c == "'":
            in_q = True
        elif c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return sql[start:i]
        i += 1
    raise AssertionError(f"unbalanced {opener!r} in SQL")


def fingerprint(row):
    return zlib.crc32(row["labels"].encode()) & 0xFFFFFFFF


def ch_row(cid, ts_ns, src, dst, msg, sport="5060", dport="5060",
           node="100", method="INVITE", response=None):
    """One ClickHouse JSONEachRow row as samples_v3/time_series produce it."""
    return {
        "timestamp_ns": ts_ns,
        "msg": msg,
        "labels": json.dumps({
            "type": "sip", "method": method, "call_id": cid,
            "response": response if response is not None else method,
            "src_ip": src, "dst_ip": dst,
            "src_port": sport, "dst_port": dport, "node": node,
        }),
    }


class FakeClickHouse:
    def __init__(self, rows_by_cid=None, fail=()):
        self.rows = []
        for rows in (rows_by_cid or {}).values():
            self.rows.extend(rows)
        self.fail = set(fail)     # {"fetch", "scan", "fpmap"}
        self.calls = []           # [(kind, sql, params)]

    def add(self, rows):
        self.rows.extend(rows)

    @staticmethod
    def kind(sql):
        if "multiSearchAny" in sql:
            return "scan"
        if "time_series_gin" in sql:
            return "fetch"
        if "time_series" in sql and "fingerprint IN" in sql:
            return "fpmap"
        return "other"

    def handle(self, sql, params=None):
        """Return (status_code, text)."""
        k = self.kind(sql)
        self.calls.append((k, sql, dict(params or {})))
        if k in self.fail:
            return 500, "Code: 241. DB::Exception: Memory limit (fake)"
        if k == "fetch":
            return 200, self._fetch(sql)
        if k == "scan":
            return 200, self._scan(sql)
        if k == "fpmap":
            return 200, self._fpmap(sql)
        return 200, ""

    # ---- query kinds -----------------------------------------------------

    def _fetch(self, sql):
        cids = set(literals(_bracket_body(sql, "val IN (", "(", ")")))
        lo = int(re.search(r"s\.timestamp_ns >= (\d+)", sql).group(1))
        hi = int(re.search(r"s\.timestamp_ns < (\d+)", sql).group(1))
        limit = int(re.findall(r"LIMIT (\d+)", sql)[-1])
        out = [r for r in self.rows
               if json.loads(r["labels"])["call_id"] in cids
               and lo <= r["timestamp_ns"] < hi]
        out.sort(key=lambda r: r["timestamp_ns"])
        return "\n".join(json.dumps(r) for r in out[:limit])

    def _scan(self, sql):
        ranges = [(int(a), int(b)) for a, b in re.findall(
            r"\(timestamp_ns >= (\d+) AND timestamp_ns < (\d+)\)", sql)]
        needles = literals(_bracket_body(sql, "multiSearchAny(string, [", "[", "]"))
        pats = literals(sql[sql.index("extract(string, "):sql.index("FROM")])
        # pats[0] = X-CID RE2 pattern, pats[1] = Call-ID pattern (inline flags)
        xcid_re = _re2(pats[0])
        hdr_re = _re2(pats[1])
        limit = int(re.findall(r"LIMIT (\d+)", sql)[-1])
        groups = {}
        for r in self.rows:
            ts = r["timestamp_ns"]
            if not any(a <= ts < b for a, b in ranges):
                continue
            if not any(n in r["msg"] for n in needles):
                continue
            m = xcid_re.search(r["msg"])
            xcid = m.group(1) if m else ""
            if xcid == "":
                continue
            h = hdr_re.search(r["msg"])
            key = (fingerprint(r), xcid, h.group(1) if h else "")
            groups[key] = min(groups.get(key, ts), ts)
        out = [{"fp": str(fp), "xcid": x, "hdr_callid": hc, "first_ns": str(t)}
               for (fp, x, hc), t in groups.items()]
        return "\n".join(json.dumps(o) for o in out[:limit])

    def _fpmap(self, sql):
        fps = {int(x) for x in re.findall(
            r"\d+", _bracket_body(sql, "fingerprint IN (", "(", ")"))}
        seen = {}
        for r in self.rows:
            fp = fingerprint(r)
            if fp in fps:
                seen[fp] = r["labels"]
        return "\n".join(json.dumps({"fp": str(fp), "labels": lab})
                         for fp, lab in seen.items())


def _re2(pattern):
    """Compile a ClickHouse/RE2 pattern with leading inline flags in Python."""
    m = re.match(r"\(\?([a-z]+)\)", pattern)
    flags = 0
    if m:
        for f in m.group(1):
            flags |= {"m": re.M, "i": re.I, "s": re.S}[f]
        pattern = pattern[m.end():]
    return re.compile(pattern, flags)


class FakeCDR:
    """Stand-in for db.fetch_all serving the router's CDR B-leg SQL only.

    rows: list of {"uuid", "call_id", "leg_attempt"}; ``fail`` raises.
    Any other SQL (e.g. the attestation lookup) returns [] — isolated.
    """

    def __init__(self, rows=(), fail=False):
        self.rows = list(rows)
        self.fail = fail
        self.calls = []

    async def fetch_all(self, query, *args):
        if "leg = 'B'" not in query:
            return []
        self.calls.append((query, args))
        if self.fail:
            raise ConnectionError("fake PgBouncer down")
        wanted = set(args[0])
        return [r for r in self.rows if r["call_id"] in wanted]
