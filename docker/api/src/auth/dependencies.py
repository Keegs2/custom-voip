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
    """
    user = await get_current_user(request)
    if user.get("role") == "admin":
        return None
    return user.get("customer_id")
