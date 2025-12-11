"""FastAPI routes for the webapp."""

import asyncio
from datetime import datetime
from enum import Enum

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from ..scrapers import get_scraper, list_scrapers
from ..scheduler import get_scheduler, init_scheduler
from .auth import (
    create_session,
    invalidate_session,
    is_valid_session,
    require_auth,
    verify_password,
)

router = APIRouter()


class ScraperStatus(Enum):
    IDLE = "idle"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


# In-memory task tracking (lost on restart, which is fine)
scraper_tasks: dict[str, dict] = {}


def get_db(request: Request):
    """Get database instance from app state."""
    return request.app.state.db


def templates(request: Request):
    """Get templates instance from app state."""
    return request.app.state.templates


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


# --- Dashboard ---


@router.get("/", response_class=HTMLResponse)
async def dashboard(request: Request, _: str = Depends(require_auth)):
    """Dashboard showing overview stats."""
    db = get_db(request)
    stats = db.get_stats()
    sources = db.get_sources()
    last_scrape_times = db.get_last_scrape_times()

    return templates(request).TemplateResponse(
        "dashboard.html",
        {
            "request": request,
            "stats": stats,
            "sources": sources,
            "last_scrape_times": last_scrape_times,
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
    unlinked = db.get_unlinked_products()
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
    unlinked = db.get_unlinked_products()
    products = [p for p in unlinked if p["source"] == source]

    return templates(request).TemplateResponse(
        "link/_product_list.html",
        {
            "request": request,
            "products": products,
            "source": source,
        },
    )


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
    unlinked = db.get_unlinked_products()
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
    unlinked = db.get_unlinked_products()
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


# --- Unlinked Products ---


@router.get("/unlinked", response_class=HTMLResponse)
async def list_unlinked_products(request: Request, _: str = Depends(require_auth)):
    """List all unlinked products."""
    db = get_db(request)
    products = db.get_unlinked_products()
    sources = db.get_sources()

    # Group by source
    products_by_source = {}
    for source in sources:
        products_by_source[source] = [p for p in products if p["source"] == source]

    return templates(request).TemplateResponse(
        "unlinked/list.html",
        {
            "request": request,
            "products_by_source": products_by_source,
            "total_count": len(products),
        },
    )


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


# --- Scraper Management ---


def _get_scraper_info(name: str, db, last_run_confirmed: bool = False) -> dict:
    """Get scraper info including status and last run data."""
    task = scraper_tasks.get(name, {})
    status = task.get("status", ScraperStatus.IDLE.value)

    # Get last scrape info from db
    history = db.get_scrape_history(name)
    last_run = history[0] if history else None

    return {
        "name": name,
        "status": status,
        "last_run": last_run["scraped_at"] if last_run else None,
        "last_count": last_run["product_count"] if last_run else None,
        "error": task.get("error"),
        "started_at": task.get("started_at"),
        "completed_at": task.get("completed_at"),
        "products_found": task.get("products_found"),
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


@router.post("/scrapers/{name}/run", response_class=HTMLResponse)
async def run_scraper(request: Request, name: str, _: str = Depends(require_auth)):
    """Start a scraper in the background."""
    db = get_db(request)

    # Validate scraper name
    if name not in list_scrapers():
        raise HTTPException(status_code=404, detail=f"Scraper '{name}' not found")

    # Check if already running
    if scraper_tasks.get(name, {}).get("status") == ScraperStatus.RUNNING.value:
        raise HTTPException(status_code=409, detail=f"Scraper '{name}' is already running")

    # Initialize task state
    scraper_tasks[name] = {
        "status": ScraperStatus.RUNNING.value,
        "started_at": datetime.utcnow().isoformat(),
        "error": None,
        "products_found": None,
        "completed_at": None,
    }

    # Run scraper in background
    async def run_scraper_task():
        try:
            scraper = get_scraper(name)
            result = await scraper.scrape()
            db.save_results(result)
            scraper_tasks[name].update({
                "status": ScraperStatus.COMPLETED.value,
                "completed_at": datetime.utcnow().isoformat(),
                "products_found": len(result.products),
            })
        except Exception as e:
            scraper_tasks[name].update({
                "status": ScraperStatus.FAILED.value,
                "completed_at": datetime.utcnow().isoformat(),
                "error": str(e),
            })

    asyncio.create_task(run_scraper_task())

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
    """Start all scrapers in parallel."""
    db = get_db(request)
    scraper_names = list_scrapers()

    for name in scraper_names:
        # Skip if already running
        if scraper_tasks.get(name, {}).get("status") == ScraperStatus.RUNNING.value:
            continue

        # Initialize task state
        scraper_tasks[name] = {
            "status": ScraperStatus.RUNNING.value,
            "started_at": datetime.utcnow().isoformat(),
            "error": None,
            "products_found": None,
            "completed_at": None,
        }

        # Run scraper in background
        async def run_scraper_task(scraper_name: str):
            try:
                scraper = get_scraper(scraper_name)
                result = await scraper.scrape()
                db.save_results(result)
                scraper_tasks[scraper_name].update({
                    "status": ScraperStatus.COMPLETED.value,
                    "completed_at": datetime.utcnow().isoformat(),
                    "products_found": len(result.products),
                })
            except Exception as e:
                scraper_tasks[scraper_name].update({
                    "status": ScraperStatus.FAILED.value,
                    "completed_at": datetime.utcnow().isoformat(),
                    "error": str(e),
                })

        asyncio.create_task(run_scraper_task(name))

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
    products = db.get_latest_products_with_price_change()
    sources = db.get_sources()
    canonical_products = db.get_all_canonical_products()

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
        },
    )


@router.get("/prices/product/{source}/{item_id}", response_class=HTMLResponse)
async def product_price_detail(request: Request, source: str, item_id: str, _: str = Depends(require_auth)):
    """Price history for a specific product."""
    db = get_db(request)

    # Get all price history for this product
    history = db.get_product_price_history(source, item_id)
    if not history:
        raise HTTPException(status_code=404, detail="Product not found")

    # Get latest product info
    latest = history[0] if history else None

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
    for link in links:
        history = db.get_product_price_history(link["source"], link["source_item_id"])
        price_data.append({
            "source": link["source"],
            "item_id": link["source_item_id"],
            "current_price": link["price"],
            "currency": link["currency"],
            "url": link["url"],
            "name": link["name"],
            "history": history,
        })

    return templates(request).TemplateResponse(
        "prices/canonical_detail.html",
        {
            "request": request,
            "canonical": canonical,
            "price_data": price_data,
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

    # Clear in-memory scraper task states
    scraper_tasks.clear()

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
