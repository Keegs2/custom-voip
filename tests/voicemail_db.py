"""Throwaway PostgreSQL built from the REAL init scripts the voicemail
migrations need (54 encrypted voicemail, 56 transcription).

Shared by the voicemail test modules (tests/test_voicemail_*.py and
tests/voicemail_api_harness.py).
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

Then the voicemail chain itself, in order (``VOICEMAIL_MIGRATIONS``):
  54 encrypted voicemail v1
  56 voicemail transcription v1.1 (requires 54; two transactions)
``apply_voicemail_schema`` applies the whole chain; ``apply_54`` /
``apply_56`` exist for the migration tests that step through it.
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
MIG_56 = INIT / "56_voicemail_transcription.sql"
#: The voicemail migrations, in apply order (every voicemail test DB gets all of them).
VOICEMAIL_MIGRATIONS = (MIG_54, MIG_56)
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


async def apply_56(conn) -> None:
    """56 is two explicit BEGIN/COMMIT blocks. asyncpg sends the script as ONE
    simple-protocol query; PostgreSQL honours both blocks, and an error stops
    the rest (like ``psql -v ON_ERROR_STOP=on -f``)."""
    await conn.execute(MIG_56.read_text())


async def apply_voicemail_schema(conn) -> None:
    """Every voicemail migration, in order (54, 56). Prerequisites first."""
    for mig in VOICEMAIL_MIGRATIONS:
        await conn.execute(mig.read_text())
