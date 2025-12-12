"""FastAPI routes for the webapp."""

import asyncio
import base64
import os
import re
import signal
import shutil
import subprocess
import sys
from datetime import datetime
from enum import Enum
from pathlib import Path
from urllib.parse import urlparse, urlunparse

from fastapi import APIRouter, Depends, Form, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response, StreamingResponse

from ..scrapers import get_scraper, get_scraper_display_name, list_scrapers
from ..scheduler import get_scheduler, init_scheduler
from ..job_queue import JobQueue
from ..scraper_builder import (
    find_codex_bin,
    generate_job_id,
    get_current_job_id,
    init_job,
    is_pid_running,
    job_dir,
    log_path,
    read_job_meta,
    read_job_status,
    read_lock,
    read_log_tail,
    release_lock,
    try_acquire_lock,
    write_job_status,
)
from .auth import (
    SERVER_ID,
    create_session,
    invalidate_session,
    is_valid_session,
    require_auth,
    verify_password,
)

router = APIRouter()


SCRAPER_BUILDER_SUBMIT_PASSWORD = "michi"

class ScraperStatus(Enum):
    IDLE = "idle"
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


def get_db(request: Request):
    """Get database instance from app state."""
    return request.app.state.db


def templates(request: Request):
    """Get templates instance from app state."""
    return request.app.state.templates


def _normalize_target_url(url: str) -> str:
    raw = (url or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="URL is required")
    if raw.startswith("//"):
        raw = "https:" + raw
    elif "://" not in raw:
        raw = "https://" + raw

    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise HTTPException(status_code=400, detail="URL must be http(s) and include a hostname")
    parsed = parsed._replace(fragment="")
    return urlunparse(parsed)


def _validate_scraper_builder_job_id(job_id: str) -> str:
    if not re.fullmatch(r"\d+-[0-9a-f]{8}", job_id):
        raise HTTPException(status_code=400, detail="Invalid job_id")
    return job_id


def _scraper_builder_current_payload() -> dict:
    job_id = get_current_job_id()
    if not job_id:
        lock = read_lock()
        return {
            "running": bool(lock),
            "job": None,
            "log": {"text": "", "start_offset": 0, "file_size": 0},
        }

    meta = read_job_meta(job_id) or {"job_id": job_id}
    status = read_job_status(job_id) or {"job_id": job_id, "state": "unknown"}
    pid = status.get("pid")
    if isinstance(pid, int) and status.get("state") == "running":
        status["pid_running"] = is_pid_running(pid)
        if not status["pid_running"]:
            status["state"] = "failed"
            status.setdefault("error", "Runner process is not running")
            write_job_status(job_id, status)
            release_lock(job_id)

    log = read_log_tail(job_id)
    running = status.get("state") == "running"
    return {"running": running, "job": {**meta, **status}, "log": log}


# --- Authentication ---


@router.get("/login", response_class=HTMLResponse)
async def login_page(request: Request, next: str = "/", error: str = None):
    """Login page."""
    # If already authenticated, redirect to home
    session_token = request.cookies.get("session_token")
    if is_valid_session(session_token):
        return RedirectResponse(next, status_code=303)

    return templates(request).TemplateResponse(
        "login.html",
        {
            "request": request,
            "next_url": next,
            "error": error,
        },
    )


@router.post("/login")
async def login(
    request: Request,
    password: str = Form(...),
    next: str = Form("/"),
):
    """Process login."""
    if not verify_password(password):
        return templates(request).TemplateResponse(
            "login.html",
            {
                "request": request,
                "next_url": next,
                "error": "Invalid password",
            },
            status_code=401,
        )

    # Create session and set cookie
    token = create_session()
    response = RedirectResponse(next, status_code=303)
    response.set_cookie(
        key="session_token",
        value=token,
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 24 * 7,  # 7 days
    )
    return response


@router.get("/logout")
async def logout(request: Request):
    """Logout and clear session."""
    session_token = request.cookies.get("session_token")
    if session_token:
        invalidate_session(session_token)

    response = RedirectResponse("/login", status_code=303)
    response.delete_cookie("session_token")
    return response


@router.get("/api/server-id")
async def get_server_id():
    """Return server ID for dev auto-refresh detection."""
    return {"server_id": SERVER_ID}


def _get_templates_mtime() -> float:
    """Get the latest modification time of all template files."""
    templates_dir = Path(__file__).parent / "templates"
    max_mtime = 0.0
    for f in templates_dir.rglob("*.html"):
        max_mtime = max(max_mtime, f.stat().st_mtime)
    return max_mtime


def _to_data_uri(data: bytes | None, mime: str | None = None) -> str | None:
    """Convert raw image bytes to a data URI for inline display."""
    if not data:
        return None

    try:
        encoded = base64.b64encode(data).decode("ascii")
    except Exception:
        return None

    mime_type = mime or "image/jpeg"
    return f"data:{mime_type};base64,{encoded}"


def _serialize_price_history(history: list[dict]) -> list[dict]:
    """Remove non-JSON-safe fields (like image blobs) from price history entries."""
    serialized: list[dict] = []
    for entry in history:
        serialized.append(
            {
                "scraped_at": entry.get("scraped_at"),
                "price": entry.get("price"),
                "currency": entry.get("currency"),
                "item_id": entry.get("item_id"),
                "source": entry.get("source"),
            }
        )
    return serialized


@router.get("/api/live-reload")
async def live_reload_stream():
    """SSE stream for live reload - detects server restarts and template changes."""
    async def event_stream():
        last_mtime = _get_templates_mtime()
        # Send initial version (server ID + mtime)
        yield f"data: {SERVER_ID}:{last_mtime}\n\n"
        # Check for template changes periodically
        while True:
            await asyncio.sleep(1)
            current_mtime = _get_templates_mtime()
            if current_mtime != last_mtime:
                last_mtime = current_mtime
                yield f"data: {SERVER_ID}:{current_mtime}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --- Scraper Builder (Codex) ---


@router.get("/api/scraper-builder/status")
async def scraper_builder_status(_: str = Depends(require_auth)):
    return _scraper_builder_current_payload()


@router.post("/api/scraper-builder/start")
async def scraper_builder_start(
    url: str = Form(...),
    password: str = Form(...),
    _: str = Depends(require_auth),
):
    if password != SCRAPER_BUILDER_SUBMIT_PASSWORD:
        raise HTTPException(status_code=403, detail="Invalid password")

    normalized_url = _normalize_target_url(url)

    try:
        codex_bin = find_codex_bin()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # Clear stale locks.
    lock = read_lock()
    if lock and isinstance(lock.get("job_id"), str):
        locked_job_id = lock["job_id"]
        locked_status = read_job_status(locked_job_id) or {}
        locked_pid = locked_status.get("pid")
        locked_state = locked_status.get("state")
        if locked_state in ("success", "failed", "canceled"):
            release_lock(locked_job_id)
        elif isinstance(locked_pid, int) and not is_pid_running(locked_pid):
            write_job_status(
                locked_job_id,
                {"state": "failed", "phase": "stale-lock", "error": "Runner process is not running"},
            )
            release_lock(locked_job_id)

    if read_lock():
        raise HTTPException(status_code=409, detail="A scraper-building agent is already running")

    job_id = generate_job_id()
    if not try_acquire_lock(job_id):
        raise HTTPException(status_code=409, detail="A scraper-building agent is already running")

    init_job(job_id, normalized_url)
    write_job_status(
        job_id,
        {
            "state": "running",
            "phase": "spawn",
            "url": normalized_url,
            "started_at": datetime.utcnow().isoformat() + "Z",
        },
    )

    log_file = log_path(job_id)
    log_file.parent.mkdir(parents=True, exist_ok=True)
    log_fp = log_file.open("ab")
    try:
        env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}
        env["CODEX_BIN"] = codex_bin
        extra_paths = [
            str(Path(codex_bin).resolve().parent),
            str(Path.home() / ".cargo" / "bin"),
            str(Path.home() / ".local" / "bin"),
        ]
        existing_path = env.get("PATH", "")
        prefix = ":".join([p for p in extra_paths if p])
        env["PATH"] = f"{prefix}:{existing_path}" if existing_path else prefix
        proc = subprocess.Popen(
            [sys.executable, "-m", "src.scraper_builder_runner", "--job-id", job_id, "--url", normalized_url],
            cwd=Path(__file__).resolve().parent.parent.parent,
            start_new_session=True,
            env=env,
            stdout=log_fp,
            stderr=subprocess.STDOUT,
        )
    except Exception:
        log_fp.close()
        release_lock(job_id)
        write_job_status(job_id, {"state": "failed", "phase": "spawn", "error": "Failed to start runner"})
        raise

    log_fp.close()
    write_job_status(job_id, {"pid": proc.pid, "phase": "running"})
    return {"job_id": job_id}


@router.post("/api/scraper-builder/cancel")
async def scraper_builder_cancel(_: str = Depends(require_auth)):
    payload = _scraper_builder_current_payload()
    job = payload.get("job") or {}
    job_id = job.get("job_id")
    pid = job.get("pid")
    if not isinstance(job_id, str) or not isinstance(pid, int):
        raise HTTPException(status_code=404, detail="No running job found")
    if not is_pid_running(pid):
        write_job_status(job_id, {"state": "failed", "phase": "cancel", "error": "Runner process is not running"})
        release_lock(job_id)
        return {"ok": False}

    try:
        os.killpg(pid, signal.SIGTERM)
    except Exception:
        os.kill(pid, signal.SIGTERM)

    write_job_status(job_id, {"state": "canceled", "phase": "cancel-requested"})
    return {"ok": True}


@router.get("/api/scraper-builder/stream")
async def scraper_builder_stream(
    request: Request,
    job_id: str | None = Query(default=None),
    offset: int = Query(default=0, ge=0),
    _: str = Depends(require_auth),
):
    resolved_job_id = _validate_scraper_builder_job_id(job_id) if job_id else get_current_job_id()
    if not resolved_job_id:
        raise HTTPException(status_code=404, detail="No job found")

    lf = log_path(resolved_job_id)
    if not job_dir(resolved_job_id).exists():
        raise HTTPException(status_code=404, detail="Job not found")

    import base64 as _b64
    import json as _json

    async def event_stream():
        nonlocal offset

        for _ in range(40):
            if lf.exists():
                break
            await asyncio.sleep(0.25)

        while True:
            if await request.is_disconnected():
                return

            status = read_job_status(resolved_job_id) or {}
            state = status.get("state", "unknown")
            done = state in ("success", "failed", "canceled")

            if lf.exists():
                with lf.open("rb") as f:
                    f.seek(offset)
                    chunk = f.read(32 * 1024)
                if chunk:
                    offset += len(chunk)
                    payload = {
                        "chunk_b64": _b64.b64encode(chunk).decode("ascii"),
                        "offset": offset,
                        "state": state,
                    }
                    yield f"data: {_json.dumps(payload)}\n\n"
                    continue

            if done:
                yield f"data: {_json.dumps({'chunk_b64': '', 'offset': offset, 'state': state, 'done': True})}\n\n"
                return

            await asyncio.sleep(0.5)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --- Dashboard ---


@router.get("/", response_class=HTMLResponse)
async def dashboard(request: Request, _: str = Depends(require_auth)):
    """Dashboard showing overview stats."""
    db = get_db(request)
    stats = db.get_stats()
    sources = db.get_sources()
    last_scrape_times = db.get_last_scrape_times()
    source_display_names = {s: get_scraper_display_name(s) for s in sources}

    return templates(request).TemplateResponse(
        "dashboard.html",
        {
            "request": request,
            "stats": stats,
            "sources": sources,
            "last_scrape_times": last_scrape_times,
            "source_display_names": source_display_names,
        },
    )


@router.get("/insights", response_class=HTMLResponse)
async def insights_page(request: Request, _: str = Depends(require_auth)):
    """Automated insight page surfacing interesting changes and risks."""
    db = get_db(request)
    insights = db.get_insights_snapshot()
    source_display_names = {
        source: get_scraper_display_name(source)
        for source in insights.get("sources_seen", [])
    }

    return templates(request).TemplateResponse(
        "insights.html",
        {
            "request": request,
            "insights": insights,
            "source_display_names": source_display_names,
        },
    )


# --- Canonical Products ---


@router.get("/products", response_class=HTMLResponse)
async def list_canonical_products(request: Request, _: str = Depends(require_auth)):
    """List all canonical products."""
    db = get_db(request)
    products = db.get_all_canonical_products()

    # Get linked product counts for each canonical
    for product in products:
        links = db.get_links_for_canonical(product["id"])
        product["link_count"] = len(links)
        product["links"] = links

    return templates(request).TemplateResponse(
        "products/list.html",
        {
            "request": request,
            "products": products,
        },
    )


@router.get("/products/new", response_class=HTMLResponse)
async def new_canonical_product_form(request: Request, _: str = Depends(require_auth)):
    """Form to create a new canonical product."""
    return templates(request).TemplateResponse(
        "products/form.html",
        {
            "request": request,
            "product": None,
        },
    )


@router.post("/products/new")
async def create_canonical_product(
    request: Request,
    name: str = Form(...),
    description: str = Form(None),
    _: str = Depends(require_auth),
):
    """Create a new canonical product."""
    db = get_db(request)
    product_id = db.create_canonical_product(name, description)
    return RedirectResponse(f"/products/{product_id}", status_code=303)


@router.get("/products/{product_id}", response_class=HTMLResponse)
async def view_canonical_product(request: Request, product_id: int, _: str = Depends(require_auth)):
    """View a canonical product and its linked source products."""
    db = get_db(request)
    product = db.get_canonical_product(product_id)

    if not product:
        raise HTTPException(status_code=404, detail="Product not found")

    links = db.get_links_for_canonical(product_id)

    return templates(request).TemplateResponse(
        "products/detail.html",
        {
            "request": request,
            "product": product,
            "links": links,
        },
    )


@router.get("/products/{product_id}/edit", response_class=HTMLResponse)
async def edit_canonical_product_form(request: Request, product_id: int, _: str = Depends(require_auth)):
    """Form to edit a canonical product."""
    db = get_db(request)
    product = db.get_canonical_product(product_id)

    if not product:
        raise HTTPException(status_code=404, detail="Product not found")

    return templates(request).TemplateResponse(
        "products/form.html",
        {
            "request": request,
            "product": product,
        },
    )


@router.post("/products/{product_id}/edit")
async def update_canonical_product(
    request: Request,
    product_id: int,
    name: str = Form(...),
    description: str = Form(None),
    _: str = Depends(require_auth),
):
    """Update a canonical product."""
    db = get_db(request)
    success = db.update_canonical_product(product_id, name, description)

    if not success:
        raise HTTPException(status_code=404, detail="Product not found")

    return RedirectResponse(f"/products/{product_id}", status_code=303)


@router.post("/products/{product_id}/delete")
async def delete_canonical_product(request: Request, product_id: int, _: str = Depends(require_auth)):
    """Delete a canonical product."""
    db = get_db(request)
    success = db.delete_canonical_product(product_id)

    if not success:
        raise HTTPException(status_code=404, detail="Product not found")

    return RedirectResponse("/products", status_code=303)


# --- Product Linking ---


@router.get("/link", response_class=HTMLResponse)
async def link_products_page(request: Request, _: str = Depends(require_auth)):
    """Side-by-side view for linking products."""
    db = get_db(request)
    sources = db.get_sources()
    canonical_products = db.get_all_canonical_products()

    # Get unlinked products grouped by source
    unlinked = db.get_unlinked_products(include_images=False)
    products_by_source = {}
    for source in sources:
        products_by_source[source] = [p for p in unlinked if p["source"] == source]

    return templates(request).TemplateResponse(
        "link/index.html",
        {
            "request": request,
            "sources": sources,
            "canonical_products": canonical_products,
            "products_by_source": products_by_source,
        },
    )


@router.get("/link/source/{source}", response_class=HTMLResponse)
async def get_source_products(request: Request, source: str, _: str = Depends(require_auth)):
    """HTMX endpoint: Get unlinked products for a source."""
    db = get_db(request)
    unlinked = db.get_unlinked_products(include_images=False)
    products = [p for p in unlinked if p["source"] == source]

    return templates(request).TemplateResponse(
        "link/_product_list.html",
        {
            "request": request,
            "products": products,
            "source": source,
        },
    )


@router.get("/media/product-image/{image_hash}")
async def product_image(request: Request, image_hash: str, _: str = Depends(require_auth)):
    """Serve stored product images by hash to keep link pages lightweight."""
    db = get_db(request)
    image = db.get_product_image_by_hash(image_hash)

    if not image or not image.get("image_data"):
        raise HTTPException(status_code=404, detail="Image not found")

    return Response(
        content=image["image_data"],
        media_type=image.get("image_mime") or "image/webp",
        headers={"Cache-Control": "public, max-age=604800"},
    )


@router.get("/link/suggestions")
async def get_link_suggestions(
    request: Request,
    exclude: list[str] = Query(default=[]),
    limit: int = Query(default=15, ge=1, le=50),
    _: str = Depends(require_auth),
):
    """Return fuzzy/ML suggestions for linking products to canonicals."""
    db = get_db(request)
    suggestions = db.get_link_suggestions(limit=limit, exclude_keys=exclude)

    payload = []
    for suggestion in suggestions:
        matches_payload: list[dict] = []
        for match in suggestion.get("matches") or []:
            matches_payload.append(
                {
                    "source": match.get("source"),
                    "source_item_id": match.get("source_item_id"),
                    "product_name": match.get("product_name"),
                    "product_price": match.get("product_price"),
                    "product_currency": match.get("product_currency"),
                    "product_url": match.get("product_url"),
                    "score": match.get("score"),
                    "reasons": match.get("reasons") or [],
                    "matched_name": match.get("matched_name"),
                    "product_image": _to_data_uri(
                        match.get("product_image"), match.get("product_image_mime")
                    ),
                }
            )

        payload.append(
            {
                "canonical_id": suggestion.get("canonical_id"),
                "canonical_name": suggestion.get("canonical_name"),
                "score": suggestion.get("score"),
                "reasons": suggestion.get("reasons") or [],
                "linked_names": suggestion.get("linked_names") or [],
                "canonical_image": _to_data_uri(
                    suggestion.get("canonical_image"), suggestion.get("canonical_image_mime")
                ),
                "create_new": bool(suggestion.get("create_new")),
                "seed_source": suggestion.get("seed_source"),
                "matches": matches_payload,
            }
        )

    return {"suggestions": payload}


@router.post("/link/create")
async def link_product_to_canonical(
    request: Request,
    canonical_id: int = Form(...),
    source: str = Form(...),
    source_item_id: str = Form(...),
    _: str = Depends(require_auth),
):
    """Link a source product to a canonical product."""
    db = get_db(request)
    db.link_product(canonical_id, source, source_item_id)

    # Return updated product list for HTMX
    unlinked = db.get_unlinked_products(include_images=False)
    products = [p for p in unlinked if p["source"] == source]

    return templates(request).TemplateResponse(
        "link/_product_list.html",
        {
            "request": request,
            "products": products,
            "source": source,
        },
    )


@router.post("/link/create-new")
async def link_product_to_new_canonical(
    request: Request,
    name: str = Form(...),
    source: str = Form(...),
    source_item_id: str = Form(...),
    _: str = Depends(require_auth),
):
    """Create a new canonical product and link a source product to it."""
    db = get_db(request)
    canonical_id = db.create_canonical_product(name)
    db.link_product(canonical_id, source, source_item_id)

    # Return updated product list for HTMX
    unlinked = db.get_unlinked_products(include_images=False)
    products = [p for p in unlinked if p["source"] == source]

    return templates(request).TemplateResponse(
        "link/_product_list.html",
        {
            "request": request,
            "products": products,
            "source": source,
        },
    )


@router.post("/link/unlink")
async def unlink_product(
    request: Request,
    source: str = Form(...),
    source_item_id: str = Form(...),
    redirect: str = Form(None),
    _: str = Depends(require_auth),
):
    """Unlink a source product from its canonical product."""
    db = get_db(request)
    db.unlink_product(source, source_item_id)

    if redirect:
        return RedirectResponse(redirect, status_code=303)

    # Default: return to link page
    return RedirectResponse("/link", status_code=303)


# --- HTMX Partials ---


@router.get("/partials/canonical-select", response_class=HTMLResponse)
async def canonical_select_partial(request: Request, _: str = Depends(require_auth)):
    """HTMX endpoint: Get canonical product select options."""
    db = get_db(request)
    canonical_products = db.get_all_canonical_products()

    return templates(request).TemplateResponse(
        "partials/_canonical_select.html",
        {
            "request": request,
            "canonical_products": canonical_products,
        },
    )


@router.get("/partials/stats", response_class=HTMLResponse)
async def stats_partial(request: Request, _: str = Depends(require_auth)):
    """HTMX endpoint: Get updated stats."""
    db = get_db(request)
    stats = db.get_stats()

    return templates(request).TemplateResponse(
        "partials/_stats.html",
        {
            "request": request,
            "stats": stats,
        },
    )


# --- Amazon Pricing ---


@router.get("/amazon-pricing", response_class=HTMLResponse)
async def amazon_pricing_page(request: Request, _: str = Depends(require_auth)):
    """Amazon-centric pricing overview and opportunities."""
    db = get_db(request)
    items = db.get_amazon_pricing_items(only_with_amazon=True)

    undercut = [i for i in items if i.get("action") == "undercut"]
    raise_ops = [i for i in items if i.get("action") == "raise"]
    watch = [i for i in items if i.get("action") == "watch"]
    missing_competitors = [i for i in items if i.get("action") == "missing_competitors"]
    missing_own_price = [i for i in items if i.get("action") == "missing_own_price"]

    def _sum_delta(list_items: list[dict], key: str) -> float:
        total = 0.0
        for it in list_items:
            val = it.get(key)
            if val is None:
                continue
            try:
                total += float(val)
            except Exception:
                continue
        return total

    potential_gain = 0.0
    for it in raise_ops:
        if it.get("suggested_price") is None or it.get("own_price") is None:
            continue
        potential_gain += float(it["suggested_price"]) - float(it["own_price"])

    summary = {
        "total_tracked": len(items),
        "undercut_count": len(undercut),
        "raise_count": len(raise_ops),
        "watch_count": len(watch),
        "missing_competitors_count": len(missing_competitors),
        "missing_own_price_count": len(missing_own_price),
        "missing_data_count": len(missing_competitors) + len(missing_own_price),
        "total_overprice": _sum_delta(undercut, "delta_abs"),
        "total_potential_gain": potential_gain,
    }

    canonical_products = db.get_all_canonical_products()
    sources = db.get_sources()
    source_display_names = {s: get_scraper_display_name(s) for s in sources}

    return templates(request).TemplateResponse(
        "amazon/index.html",
        {
            "request": request,
            "items": items,
            "undercut": undercut,
            "raise_ops": raise_ops,
            "watch": watch,
            "missing_competitors": missing_competitors,
            "missing_own_price": missing_own_price,
            "summary": summary,
            "canonical_products": canonical_products,
            "source_display_names": source_display_names,
        },
    )


# --- Scraper Management ---


def _get_scraper_info(name: str, db, last_run_confirmed: bool = False) -> dict:
    """Get scraper info including status and last run data from job queue."""
    queue = JobQueue(db)

    # Check for active job in queue
    active_job = queue.get_active_job(name)

    if active_job:
        status = active_job["status"]
        error = active_job["error_message"]
        started_at = active_job["claimed_at"] or active_job["created_at"]
        # Get products_found from scrape_runs if available
        run = db.get_scrape_run(active_job["scrape_run_id"]) if active_job["scrape_run_id"] else None
        products_found = run["products_found"] if run else None
    else:
        status = ScraperStatus.IDLE.value
        error = None
        started_at = None
        products_found = None

    # Get last scrape info from db
    history = db.get_scrape_history(name)
    last_run = history[0] if history else None

    return {
        "name": name,
        "display_name": get_scraper_display_name(name),
        "status": status,
        "last_run": last_run["scraped_at"] if last_run else None,
        "last_count": last_run["product_count"] if last_run else None,
        "error": error,
        "started_at": started_at,
        "completed_at": None,
        "products_found": products_found,
        "last_run_confirmed": last_run_confirmed,
    }


@router.get("/scrapers", response_class=HTMLResponse)
async def scrapers_page(request: Request, _: str = Depends(require_auth)):
    """Scraper management page."""
    db = get_db(request)
    scraper_names = list_scrapers()
    scrapers = [_get_scraper_info(name, db) for name in scraper_names]

    return templates(request).TemplateResponse(
        "scrapers/index.html",
        {
            "request": request,
            "scrapers": scrapers,
        },
    )

@router.get("/scrapers/builder", response_class=HTMLResponse)
async def scraper_builder_page(request: Request, _: str = Depends(require_auth)):
    return templates(request).TemplateResponse(
        "scrapers/builder.html",
        {"request": request},
    )


@router.post("/scrapers/{name}/run", response_class=HTMLResponse)
async def run_scraper(request: Request, name: str, _: str = Depends(require_auth)):
    """Enqueue a scraper job."""
    db = get_db(request)
    queue = JobQueue(db)

    # Validate scraper name
    if name not in list_scrapers():
        raise HTTPException(status_code=404, detail=f"Scraper '{name}' not found")

    # Check if already queued or running
    if queue.is_scraper_queued_or_running(name):
        raise HTTPException(status_code=409, detail=f"Scraper '{name}' is already queued or running")

    # Enqueue the job (worker will execute it)
    queue.enqueue(name, source="manual")

    # Return updated row for HTMX
    info = _get_scraper_info(name, db)
    return templates(request).TemplateResponse(
        "scrapers/_row.html",
        {
            "request": request,
            "scraper": info,
        },
    )


@router.post("/scrapers/run-all", response_class=HTMLResponse)
async def run_all_scrapers(request: Request, _: str = Depends(require_auth)):
    """Enqueue all scrapers."""
    db = get_db(request)
    queue = JobQueue(db)
    scraper_names = list_scrapers()

    for name in scraper_names:
        # Skip if already queued or running
        if queue.is_scraper_queued_or_running(name):
            continue

        # Enqueue the job
        queue.enqueue(name, source="manual")

    # Return full table body for HTMX
    scrapers = [_get_scraper_info(name, db) for name in scraper_names]
    return templates(request).TemplateResponse(
        "scrapers/_table_body.html",
        {
            "request": request,
            "scrapers": scrapers,
        },
    )


@router.get("/scrapers/{name}/status", response_class=HTMLResponse)
async def scraper_status(request: Request, name: str, confirmed: str | None = None, _: str = Depends(require_auth)):
    """Get current status of a scraper (HTMX polling endpoint)."""
    db = get_db(request)

    if name not in list_scrapers():
        raise HTTPException(status_code=404, detail=f"Scraper '{name}' not found")

    info = _get_scraper_info(name, db, last_run_confirmed=confirmed is not None)
    return templates(request).TemplateResponse(
        "scrapers/_row.html",
        {
            "request": request,
            "scraper": info,
        },
    )


# --- Price Display ---


@router.get("/prices", response_class=HTMLResponse)
async def prices_page(request: Request, _: str = Depends(require_auth)):
    """Price overview page - lists all products with price info."""
    db = get_db(request)
    products = db.get_latest_products_with_price_change(include_images=False)
    sources = db.get_sources()
    canonical_products = db.get_all_canonical_products()
    source_display_names = {s: get_scraper_display_name(s) for s in sources}

    # Group products by source for the table view
    products_by_source = {}
    for source in sources:
        products_by_source[source] = [p for p in products if p["source"] == source]

    return templates(request).TemplateResponse(
        "prices/index.html",
        {
            "request": request,
            "products_by_source": products_by_source,
            "sources": sources,
            "canonical_products": canonical_products,
            "source_display_names": source_display_names,
        },
    )


@router.get("/prices/product/{source}/{item_id}", response_class=HTMLResponse)
async def product_price_detail(request: Request, source: str, item_id: str, _: str = Depends(require_auth)):
    """Price history for a specific product."""
    db = get_db(request)

    # Get all price history for this product
    raw_history = db.get_product_price_history(source, item_id)
    if not raw_history:
        raise HTTPException(status_code=404, detail="Product not found")

    # Get latest product info
    latest = raw_history[0] if raw_history else None
    history = _serialize_price_history(raw_history)

    # Check if linked to canonical
    link = db.get_link_for_product(source, item_id)

    return templates(request).TemplateResponse(
        "prices/product_detail.html",
        {
            "request": request,
            "product": latest,
            "history": history,
            "link": link,
            "source": source,
            "source_display_name": get_scraper_display_name(source),
            "item_id": item_id,
        },
    )


@router.get("/prices/canonical/{canonical_id}", response_class=HTMLResponse)
async def canonical_price_detail(request: Request, canonical_id: int, _: str = Depends(require_auth)):
    """Price comparison across sources for a canonical product."""
    db = get_db(request)

    # Get canonical product
    canonical = db.get_canonical_product(canonical_id)
    if not canonical:
        raise HTTPException(status_code=404, detail="Canonical product not found")

    # Get all linked products with their price history
    links = db.get_links_for_canonical(canonical_id)

    # Get price history for each linked product
    price_data = []
    price_chart_data = []
    for link in links:
        history = db.get_product_price_history(link["source"], link["source_item_id"])
        currency = link["currency"] or (history[0].get("currency") if history else None)
        display_name = get_scraper_display_name(link["source"])
        image_data = link.get("image_data") or (history[0].get("image_data") if history else None)
        image_mime = link.get("image_mime") or (history[0].get("image_mime") if history else None)
        price_data.append({
            "source": link["source"],
            "display_name": display_name,
            "item_id": link["source_item_id"],
            "current_price": link["price"],
            "currency": currency,
            "url": link["url"],
            "name": link["name"],
            "image_data": image_data,
            "image_mime": image_mime,
            "history": history,
        })
        price_chart_data.append({
            "source": link["source"],
            "display_name": display_name,
            "item_id": link["source_item_id"],
            "currency": currency,
            "history": _serialize_price_history(history),
        })

    return templates(request).TemplateResponse(
        "prices/canonical_detail.html",
        {
            "request": request,
            "canonical": canonical,
            "price_data": price_data,
            "price_chart_data": price_chart_data,
        },
    )


@router.get("/api/prices/{source}/{item_id}", response_class=HTMLResponse)
async def api_product_prices(request: Request, source: str, item_id: str, _: str = Depends(require_auth)):
    """JSON API endpoint for product price history (for Chart.js)."""
    from fastapi.responses import JSONResponse

    db = get_db(request)
    history = db.get_product_price_history(source, item_id)

    return JSONResponse({
        "labels": [h["scraped_at"] for h in history],
        "prices": [h["price"] for h in history],
        "currency": history[0]["currency"] if history else "EUR",
    })


@router.get("/api/prices/canonical/{canonical_id}")
async def api_canonical_prices(request: Request, canonical_id: int, _: str = Depends(require_auth)):
    """JSON API endpoint for canonical product price history across sources."""
    from fastapi.responses import JSONResponse

    db = get_db(request)
    links = db.get_links_for_canonical(canonical_id)

    datasets = []
    all_dates = set()

    for link in links:
        history = db.get_product_price_history(link["source"], link["source_item_id"])
        for h in history:
            all_dates.add(h["scraped_at"])
        datasets.append({
            "source": link["source"],
            "data": {h["scraped_at"]: h["price"] for h in history},
            "currency": history[0]["currency"] if history else "EUR",
        })

    # Sort dates
    sorted_dates = sorted(all_dates)

    return JSONResponse({
        "labels": sorted_dates,
        "datasets": datasets,
    })


# --- Admin: Reset All ---


@router.post("/admin/reset-all", response_class=HTMLResponse)
async def reset_all_data(request: Request, _: str = Depends(require_auth)):
    """Reset all data in the database."""
    db = get_db(request)
    counts = db.reset_all()

    # Return a confirmation message
    return templates(request).TemplateResponse(
        "admin/_reset_result.html",
        {
            "request": request,
            "counts": counts,
        },
    )


# --- Scraper Schedules ---


@router.get("/scrapers/schedules", response_class=HTMLResponse)
async def schedules_page(request: Request, _: str = Depends(require_auth)):
    """Scraper schedule configuration page."""
    db = get_db(request)
    scraper_names = list_scrapers()

    # Get all schedules, merging with scraper list
    schedules = {s["scraper_name"]: s for s in db.get_all_schedules()}

    scrapers_with_schedules = []
    for name in scraper_names:
        schedule = schedules.get(name, {
            "scraper_name": name,
            "enabled": False,
            "interval_minutes": 60,
            "last_run": None,
            "next_run": None,
        })
        schedule["display_name"] = get_scraper_display_name(name)
        scrapers_with_schedules.append(schedule)

    scheduler = get_scheduler()
    scheduler_status = scheduler.get_status() if scheduler else {"running": False}

    return templates(request).TemplateResponse(
        "scrapers/schedules.html",
        {
            "request": request,
            "scrapers": scrapers_with_schedules,
            "scheduler_status": scheduler_status,
        },
    )


@router.post("/scrapers/schedules/save-all", response_class=HTMLResponse)
async def save_all_schedules(request: Request, _: str = Depends(require_auth)):
    """Save all schedule configurations at once."""
    db = get_db(request)
    form = await request.form()

    scraper_names = list_scrapers()

    for name in scraper_names:
        enabled = form.get(f"enabled_{name}") == "on"
        interval_str = form.get(f"interval_{name}", "60")
        try:
            interval_minutes = int(interval_str)
        except ValueError:
            interval_minutes = 60

        db.upsert_schedule(name, enabled, interval_minutes)

    # Redirect back to schedules page
    return RedirectResponse("/scrapers/schedules", status_code=303)


@router.post("/scrapers/schedules/{name}", response_class=HTMLResponse)
async def update_schedule(
    request: Request,
    name: str,
    enabled: bool = Form(False),
    interval_minutes: int = Form(60),
    _: str = Depends(require_auth),
):
    """Update schedule configuration for a scraper."""
    db = get_db(request)

    if name not in list_scrapers():
        raise HTTPException(status_code=404, detail=f"Scraper '{name}' not found")

    db.upsert_schedule(name, enabled, interval_minutes)

    # Return updated row for HTMX
    schedule = db.get_schedule(name) or {
        "scraper_name": name,
        "enabled": enabled,
        "interval_minutes": interval_minutes,
        "last_run": None,
        "next_run": None,
    }
    schedule["display_name"] = get_scraper_display_name(name)

    return templates(request).TemplateResponse(
        "scrapers/_schedule_row.html",
        {
            "request": request,
            "scraper": schedule,
        },
    )


@router.post("/scheduler/start", response_class=HTMLResponse)
async def start_scheduler(request: Request, _: str = Depends(require_auth)):
    """Start the background scheduler."""
    db = get_db(request)
    scheduler = get_scheduler()

    if not scheduler:
        scheduler = init_scheduler(db)
        request.app.state.scheduler = scheduler

    if not scheduler.is_running:
        scheduler.start()

    return RedirectResponse("/scrapers/schedules", status_code=303)


@router.post("/scheduler/stop", response_class=HTMLResponse)
async def stop_scheduler(request: Request, _: str = Depends(require_auth)):
    """Stop the background scheduler."""
    scheduler = get_scheduler()

    if scheduler and scheduler.is_running:
        scheduler.stop()

    return RedirectResponse("/scrapers/schedules", status_code=303)


@router.get("/scheduler/status", response_class=HTMLResponse)
async def scheduler_status_partial(request: Request, _: str = Depends(require_auth)):
    """HTMX endpoint: Get current scheduler status."""
    scheduler = get_scheduler()
    status = scheduler.get_status() if scheduler else {"running": False}

    return templates(request).TemplateResponse(
        "scrapers/_scheduler_status.html",
        {
            "request": request,
            "scheduler_status": status,
        },
    )


# --- Scrape History ---


@router.get("/scrapers/history", response_class=HTMLResponse)
async def scrape_history_page(
    request: Request,
    scraper: str | None = None,
    status: str | None = None,
    _: str = Depends(require_auth),
):
    """Scrape run history page."""
    db = get_db(request)
    scraper_names = list_scrapers()

    # Get runs with optional filters
    runs = db.get_scrape_runs(scraper_name=scraper, status=status, limit=100)
    scraper_display_names = {name: get_scraper_display_name(name) for name in scraper_names}
    for run in runs:
        run["display_name"] = scraper_display_names.get(run["scraper_name"], run["scraper_name"])

    # Get stats
    stats = db.get_scrape_run_stats()

    return templates(request).TemplateResponse(
        "scrapers/history.html",
        {
            "request": request,
            "runs": runs,
            "stats": stats,
            "scraper_names": scraper_names,
            "scraper_display_names": scraper_display_names,
            "selected_scraper": scraper,
            "selected_status": status,
        },
    )


@router.get("/scrapers/history/{run_id}", response_class=HTMLResponse)
async def scrape_run_detail(request: Request, run_id: int, _: str = Depends(require_auth)):
    """Detail view of a specific scrape run."""
    db = get_db(request)

    run = db.get_scrape_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Scrape run not found")

    run["display_name"] = get_scraper_display_name(run["scraper_name"])

    return templates(request).TemplateResponse(
        "scrapers/run_detail.html",
        {
            "request": request,
            "run": run,
        },
    )
