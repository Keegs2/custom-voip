"""Throwaway PostgreSQL built from the REAL init scripts migration 54 needs.

Shared by tests/test_voicemail_migration54.py and tests/test_voicemail_crypto.py.
Same harness shape as tests/test_carrier_trunks.py (initdb + pg_ctl on a
private unix socket, trust auth). The only hand-written DDL is the two roles
that 01_extensions.sql would create (01 itself needs TimescaleDB).

Prerequisite chain (all REAL files, in init order):
  02 core (customers, rcf_numbers, sip_trunks, trunk_dids)
  03 api_dids                  — number_routing's api arm
  09 users                     — voicemail_*.created_by FK
  17 did_inventory             — the inline/unnamed product_type CHECK 54 swaps
  20 rcf_numbers.max_channels  — number_routing's rcf arm
  22 number_routing            — the view 54 replaces
  24 grafana_ro                — its ALTER DEFAULT PRIVILEGES is what 54 must undo
  31 E.164 CHECKs              — must survive 54
  34 did_inventory status CHECK (named, other column) — must survive 54
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
INIT = REPO / "docker" / "postgres" / "init"
MIG_54 = INIT / "54_voicemail.sql"
CHECK_MIGRATIONS = REPO / "scripts" / "db" / "check_migrations.sql"

PREREQ_SCRIPTS = (
    "02_schema_core.sql",
    "03_schema_api.sql",
    "09_schema_users.sql",
    "17_did_inventory.sql",
    "20_rcf_max_channels.sql",
    "22_number_routing.sql",
    "24_grafana_ro.sql",
    "31_did_canonicalize.sql",
    "34_release_requested_status.sql",
)

ROLES_SQL = """
CREATE ROLE api LOGIN PASSWORD 'api_secret';
CREATE ROLE freeswitch LOGIN PASSWORD 'fs_secret';
"""


def find_pg_bin():
    override = os.getenv("TEST_PG_BIN")
    candidates = []
    if override:
        candidates.append(override)
    pgctl = shutil.which("pg_ctl")
    if pgctl:
        candidates.append(str(Path(pgctl).parent))
    candidates += [
        "/opt/homebrew/opt/postgresql@16/bin", "/opt/homebrew/opt/postgresql@15/bin",
        "/opt/homebrew/bin", "/usr/local/opt/postgresql@16/bin",
        "/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/15/bin",
    ]
    for d in candidates:
        if d and Path(d, "initdb").exists() and Path(d, "pg_ctl").exists():
            return d
    return None


class EphemeralPG:
    def __init__(self, pg_bin: str, port: int):
        self.pg_bin = pg_bin
        self.tmp = tempfile.mkdtemp(prefix="revup_vm_pg.")
        self.data = os.path.join(self.tmp, "data")
        self.sock = os.path.join(self.tmp, "sock")
        os.makedirs(self.sock, exist_ok=True)
        self.port = port

    def start(self):
        subprocess.run(
            [f"{self.pg_bin}/initdb", "-D", self.data, "-U", "postgres",
             "--auth=trust", "-E", "UTF8"], check=True, capture_output=True)
        subprocess.run(
            [f"{self.pg_bin}/pg_ctl", "-D", self.data,
             "-o", f"-p {self.port} -k {self.sock} -c listen_addresses=''",
             "-w", "-l", os.path.join(self.tmp, "log"), "start"],
            check=True, capture_output=True)

    def stop(self):
        subprocess.run([f"{self.pg_bin}/pg_ctl", "-D", self.data, "-w", "stop"],
                       capture_output=True)
        shutil.rmtree(self.tmp, ignore_errors=True)


async def apply_prerequisites(conn) -> None:
    """Roles + the real init scripts 54 depends on (NOT 54 itself)."""
    await conn.execute(ROLES_SQL)
    for name in PREREQ_SCRIPTS:
        await conn.execute((INIT / name).read_text())


async def apply_54(conn) -> None:
    await conn.execute(MIG_54.read_text())
