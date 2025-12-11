"""FastAPI application factory."""

from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from ..db import ProductDatabase
from .routes import router

TEMPLATES_DIR = Path(__file__).parent / "templates"
STATIC_DIR = Path(__file__).parent / "static"


def create_app(db: ProductDatabase | None = None) -> FastAPI:
    """Create and configure the FastAPI application."""
    app = FastAPI(
        title="Corastuff Product Manager",
        description="Manage and link products across different sources",
        version="0.1.0",
    )

    # Initialize database
    app.state.db = db or ProductDatabase()

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
