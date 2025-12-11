"""Simple authentication for the webapp."""

import secrets
from functools import wraps
from typing import Callable

from fastapi import Cookie, Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse

# Hardcoded master password
MASTER_PASSWORD = "iloveanal"

# In-memory session store (simple token-based)
# In production, use Redis or database-backed sessions
active_sessions: set[str] = set()


def verify_password(password: str) -> bool:
    """Verify if the provided password matches the master password."""
    return secrets.compare_digest(password, MASTER_PASSWORD)


def create_session() -> str:
    """Create a new session token."""
    token = secrets.token_urlsafe(32)
    active_sessions.add(token)
    return token


def is_valid_session(token: str | None) -> bool:
    """Check if a session token is valid."""
    if not token:
        return False
    return token in active_sessions


def invalidate_session(token: str) -> None:
    """Invalidate a session token."""
    active_sessions.discard(token)


async def get_current_session(
    request: Request,
    session_token: str | None = Cookie(None, alias="session_token"),
) -> str | None:
    """Get current session token from cookie."""
    return session_token


async def require_auth(
    request: Request,
    session_token: str | None = Cookie(None, alias="session_token"),
) -> str:
    """Dependency that requires authentication.

    For web pages, redirects to login.
    For API calls, returns 401.
    """
    if not is_valid_session(session_token):
        # Check if this is an API request
        if request.url.path.startswith("/api/"):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Not authenticated",
                headers={"WWW-Authenticate": "Bearer"},
            )
        # For web pages, redirect to login
        raise HTTPException(
            status_code=status.HTTP_307_TEMPORARY_REDIRECT,
            headers={"Location": f"/login?next={request.url.path}"},
        )
    return session_token


def auth_required(func: Callable) -> Callable:
    """Decorator for routes that require authentication."""
    @wraps(func)
    async def wrapper(request: Request, *args, **kwargs):
        session_token = request.cookies.get("session_token")
        if not is_valid_session(session_token):
            if request.url.path.startswith("/api/"):
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Not authenticated",
                )
            return RedirectResponse(f"/login?next={request.url.path}", status_code=303)
        return await func(request, *args, **kwargs)
    return wrapper
