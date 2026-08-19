"""
FastAPI dependency functions for authentication and authorization.
"""
from fastapi import Request, HTTPException


async def get_current_user(request: Request) -> dict:
    """
    Read the authenticated user from request.state (set by auth middleware).
    Returns the decoded JWT claims as a dict.
    Raises 401 if no user is attached to the request.
    """
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


async def require_admin(request: Request) -> dict:
    """
    Require that the current user has the 'admin' role.
    Returns the user dict if authorized, raises 403 otherwise.
    """
    user = await get_current_user(request)
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


async def require_support_or_admin(request: Request) -> dict:
    """
    Require that the current user has the 'admin' or 'support' role.
    Support = platform-wide READ-ONLY troubleshooting staff; use this gate
    only on read endpoints that are safe for support (writes stay admin-only).
    Returns the user dict if authorized, raises 403 otherwise.
    """
    user = await get_current_user(request)
    if user.get("role") not in ("admin", "support"):
        raise HTTPException(status_code=403, detail="Support or admin access required")
    return user


async def get_customer_filter(request: Request) -> int | None:
    """
    Return the customer_id the current user is scoped to.
    Admins get None (no filter, can see everything).
    Regular users get their customer_id for row-level filtering.
    A non-admin whose JWT carries no customer_id (e.g. a support user) is
    rejected with 403 — tenant-scoped routes must fail CLOSED, never return
    an unscoped None for a non-admin.
    """
    user = await get_current_user(request)
    if user.get("role") == "admin":
        return None
    customer_id = user.get("customer_id")
    if customer_id is None:
        raise HTTPException(status_code=403, detail="No customer scope")
    return customer_id


async def get_support_read_filter(request: Request) -> int | None:
    """
    Row-scope filter for WHITELISTED read-only troubleshooting/quality
    endpoints ONLY (CDR queries/summary/detail, attestations, customer and
    trunk lists). Admin AND support get None (platform-wide read); all other
    roles get their customer_id, failing closed with 403 when the JWT has no
    customer scope. Never use this on writes or secret-bearing reads.
    """
    user = await get_current_user(request)
    if user.get("role") in ("admin", "support"):
        return None
    customer_id = user.get("customer_id")
    if customer_id is None:
        raise HTTPException(status_code=403, detail="No customer scope")
    return customer_id
