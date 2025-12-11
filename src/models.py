"""Data models for the scraper."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass
class Product:
    """A scraped product."""

    name: str
    price: float | None
    currency: str | None
    url: str | None
    item_id: str | None
    image: bytes | None = None
    image_mime: str | None = None

    def to_dict(self) -> dict:
        """Convert to dictionary."""
        return {
            "name": self.name,
            "price": self.price,
            "currency": self.currency,
            "url": self.url,
            "item_id": self.item_id,
            # Intentionally skip raw image bytes to avoid bloating JSON exports.
            "image": None,
            "image_mime": self.image_mime,
        }


@dataclass
class ScrapeResult:
    """Result of a scrape operation."""

    source: str
    source_url: str
    scraped_at: datetime
    products: list[Product]

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "source": self.source,
            "source_url": self.source_url,
            "scraped_at": self.scraped_at.isoformat(),
            "total_products": len(self.products),
            "products": [p.to_dict() for p in self.products],
        }
