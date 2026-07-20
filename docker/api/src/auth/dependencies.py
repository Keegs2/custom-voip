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


async def get_customer_filter(request: Request) -> int | None:
    """
    Return the customer_id the current user is scoped to.
    Admins get None (no filter, can see everything).
    Regular users get their customer_id for row-level filtering.

    SECURITY (HIGH-4): fails CLOSED. A non-admin whose JWT has a missing/null
    ``customer_id`` is DENIED (403) rather than returning None. Returning None for
    a non-admin is indistinguishable from the admin "no filter" sentinel, so every
    tenant-scoped endpoint (cdrs / customers / ai-agents / lco / toll-free / ...)
    would treat it as "see everything" — a cross-tenant read. Real tenant tokens
    always carry a customer_id, so this never rejects a legitimate caller; only a
    malformed/forged non-admin token with no tenant scope is refused.
    """
    user = await get_current_user(request)
    if user.get("role") == "admin":
        return None
    customer_id = user.get("customer_id")
    if customer_id is None:
        raise HTTPException(
            status_code=403,
            detail="Token is missing a customer scope",
        )
    return customer_id
