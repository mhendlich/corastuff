"""Scraper registry - add new scrapers here."""

from .base import BaseScraper
from .amazon import AmazonDEScraper
from .bergzeit import BergzeitScraper
from .galaxus import GalaxusCHScraper, GalaxusDEScraper
from .kaufland import KauflandScraper
from .sportscheck import SportscheckScraper

__all__ = [
    "BaseScraper",
    "get_scraper",
    "get_all_scrapers",
    "list_scrapers",
    "get_scraper_display_name",
]

SCRAPERS: dict[str, type[BaseScraper]] = {
    "bergzeit": BergzeitScraper,
    "sportscheck": SportscheckScraper,
    "galaxus_ch": GalaxusCHScraper,
    "galaxus_de": GalaxusDEScraper,
    "kaufland": KauflandScraper,
    "amazon_de": AmazonDEScraper,
}

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
