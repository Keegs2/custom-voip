"""Suite-wide test isolation.

``auth.user_status`` (the JWT middleware's users.status check) keeps a
per-PROCESS TTL cache keyed by user id — exactly right for a uvicorn worker,
but pytest runs every module in one process against a different throwaway
database each, so a status cached by one module (user 3 active / missing)
must not answer for the next module's user 3. Reset it before every test.

Nothing is imported here: the module is reset only if a test already
imported it (sys.modules), so collection order and sys.path are untouched.
"""
import sys

import pytest


@pytest.fixture(autouse=True)
def _fresh_user_status_cache():
    mod = sys.modules.get("auth.user_status")
    if mod is not None:
        mod.reset()
    yield
