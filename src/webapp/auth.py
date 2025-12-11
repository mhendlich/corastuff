"""Simple authentication for the webapp."""

import json
import secrets
from functools import wraps
from pathlib import Path
from typing import Callable

from fastapi import Cookie, Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse

# Hardcoded master password
MASTER_PASSWORD = "iloveanal"

# File-based session store for persistence across restarts
SESSIONS_FILE = Path(__file__).parent.parent.parent / "data" / "sessions.json"

# Unique server ID generated at startup (for dev auto-refresh)
SERVER_ID = secrets.token_hex(8)


def _load_sessions() -> set[str]:
    """Load sessions from file."""
    if SESSIONS_FILE.exists():
        try:
            data = json.loads(SESSIONS_FILE.read_text())
            return set(data.get("sessions", []))
        except (json.JSONDecodeError, IOError):
            pass
    return set()


def _save_sessions(sessions: set[str]) -> None:
    """Save sessions to file."""
    SESSIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SESSIONS_FILE.write_text(json.dumps({"sessions": list(sessions)}))


# Load sessions from file on module load
active_sessions: set[str] = _load_sessions()


def verify_password(password: str) -> bool:
    """Verify if the provided password matches the master password."""
    return secrets.compare_digest(password, MASTER_PASSWORD)


def create_session() -> str:
    """Create a new session token."""
    token = secrets.token_urlsafe(32)
    active_sessions.add(token)
    _save_sessions(active_sessions)
    return token


def is_valid_session(token: str | None) -> bool:
    """Check if a session token is valid."""
    if not token:
        return False
    return token in active_sessions


def invalidate_session(token: str) -> None:
    """Invalidate a session token."""
    active_sessions.discard(token)
    _save_sessions(active_sessions)


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
