"""FastAPI application factory."""

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from ..db import ProductDatabase
from ..scheduler import init_scheduler
from .routes import router

TEMPLATES_DIR = Path(__file__).parent / "templates"
STATIC_DIR = Path(__file__).parent / "static"


def create_app(db: ProductDatabase | None = None, auto_start_scheduler: bool = True) -> FastAPI:
    """Create and configure the FastAPI application."""
    # Initialize database early so lifespan can use it
    database = db or ProductDatabase()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        """Manage application lifespan - start/stop scheduler."""
        # Startup: initialize and auto-start scheduler if enabled schedules exist
        scheduler = init_scheduler(database)
        app.state.scheduler = scheduler

        if auto_start_scheduler:
            # Check if there are any enabled schedules - if so, auto-start
            enabled_schedules = database.get_enabled_schedules()
            if enabled_schedules:
                scheduler.start()

        yield

        # Shutdown: stop scheduler
        if scheduler.is_running:
            scheduler.stop()

    app = FastAPI(
        title="Corastuff Product Manager",
        description="Manage and link products across different sources",
        version="0.1.0",
        lifespan=lifespan,
    )

    # Store database reference
    app.state.db = database

    # Setup templates
    app.state.templates = Jinja2Templates(directory=TEMPLATES_DIR)

    # Mount static files if directory exists
    if STATIC_DIR.exists():
        app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    # Include routes
    app.include_router(router)

    return app


# Default app instance for uvicorn
app = create_app()
