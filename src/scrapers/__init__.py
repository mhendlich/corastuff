"""Scraper registry - add new scrapers here."""

from .base import BaseScraper
from .bergzeit import BergzeitScraper
from .galaxus import GalaxusCHScraper, GalaxusDEScraper
from .kaufland import KauflandScraper
from .sportscheck import SportscheckScraper

__all__ = ["BaseScraper", "get_scraper", "get_all_scrapers", "list_scrapers"]

SCRAPERS: dict[str, type[BaseScraper]] = {
    "bergzeit": BergzeitScraper,
    "sportscheck": SportscheckScraper,
    "galaxus_ch": GalaxusCHScraper,
    "galaxus_de": GalaxusDEScraper,
    "kaufland": KauflandScraper,
}


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
