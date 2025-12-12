"""Scraper registry.

Scrapers are auto-discovered from modules in this package. Any `BaseScraper`
subclass with a non-empty `name` attribute will be registered.
"""

from __future__ import annotations

import importlib
import inspect
import logging
import pkgutil

from .base import BaseScraper

__all__ = [
    "BaseScraper",
    "get_scraper",
    "get_all_scrapers",
    "list_scrapers",
    "get_scraper_display_name",
]

logger = logging.getLogger(__name__)


def _discover_scrapers() -> dict[str, type[BaseScraper]]:
    discovered: dict[str, type[BaseScraper]] = {}
    failures: dict[str, Exception] = {}

    # Walk sibling modules under this package (src.scrapers.*).
    for module_info in pkgutil.iter_modules(__path__):  # type: ignore[name-defined]
        if module_info.ispkg:
            continue
        module_name = module_info.name
        if module_name.startswith("_") or module_name in {"base", "browser_pool"}:
            continue

        full_name = f"{__name__}.{module_name}"
        try:
            module = importlib.import_module(full_name)
        except Exception as exc:  # pragma: no cover - depends on optional modules
            failures[full_name] = exc
            continue

        for _, obj in inspect.getmembers(module, inspect.isclass):
            if obj is BaseScraper or not issubclass(obj, BaseScraper):
                continue
            scraper_name = getattr(obj, "name", None)
            if not isinstance(scraper_name, str) or not scraper_name.strip():
                continue

            if scraper_name in discovered and discovered[scraper_name] is not obj:
                logger.warning(
                    "Duplicate scraper name '%s': %s.%s and %s.%s (keeping first)",
                    scraper_name,
                    discovered[scraper_name].__module__,
                    discovered[scraper_name].__name__,
                    obj.__module__,
                    obj.__name__,
                )
                continue
            discovered[scraper_name] = obj

    for mod, exc in failures.items():
        logger.warning("Failed to import scraper module %s: %r", mod, exc)

    return dict(sorted(discovered.items(), key=lambda kv: kv[0]))


SCRAPERS: dict[str, type[BaseScraper]] = _discover_scrapers()

SCRAPER_DISPLAY_NAMES: dict[str, str] = {
    key: getattr(cls, "display_name", key.replace("_", " ").title())
    for key, cls in SCRAPERS.items()
}
# Pre-register display names for sources that may be ingested manually
# before dedicated scrapers exist.
SCRAPER_DISPLAY_NAMES.update(
    {
        "amazon": "Amazon (Official)",
        "amazon_de": "Amazon DE (Official)",
    }
)


def get_scraper(name: str) -> BaseScraper:
    """Get a scraper instance by name."""
    if name not in SCRAPERS:
        available = ", ".join(SCRAPERS.keys())
        raise ValueError(f"Unknown scraper '{name}'. Available: {available}")
    return SCRAPERS[name]()


def get_all_scrapers() -> list[BaseScraper]:
    """Get instances of all registered scrapers."""
    return [cls() for cls in SCRAPERS.values()]


def list_scrapers() -> list[str]:
    """List all available scraper names."""
    return list(SCRAPERS.keys())


def get_scraper_display_name(name: str) -> str:
    """Get a human-friendly display name for a scraper."""
    return SCRAPER_DISPLAY_NAMES.get(name, name)
