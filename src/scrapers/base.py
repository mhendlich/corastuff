"""Base scraper class for all sources."""

import json
from abc import ABC, abstractmethod
from datetime import datetime, UTC
from pathlib import Path

from playwright.async_api import async_playwright, Page

from ..models import Product, ScrapeResult


class BaseScraper(ABC):
    """Abstract base class for all scrapers."""

    name: str
    url: str

    def __init__(self, output_dir: Path | None = None):
        self.output_dir = output_dir or Path(__file__).parent.parent.parent / "output"

    @abstractmethod
    async def extract_products(self, page: Page) -> list[Product]:
        """Extract products from the page. Subclasses must implement this."""
        ...

    async def scrape(self) -> ScrapeResult:
        """Run the scraper and return results."""
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page()

            print(f"[{self.name}] Loading {self.url}...")
            await page.goto(self.url, wait_until="networkidle")

            products = await self.extract_products(page)
            print(f"[{self.name}] Extracted {len(products)} products")

            await browser.close()

        return ScrapeResult(
            source=self.name,
            source_url=self.url,
            scraped_at=datetime.now(UTC),
            products=products,
        )

    def save_results(self, result: ScrapeResult) -> tuple[Path, Path]:
        """Save results to JSON and CSV files."""
        self.output_dir.mkdir(parents=True, exist_ok=True)

        json_file = self.output_dir / f"{self.name}_products.json"
        json_file.write_text(
            json.dumps(result.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"[{self.name}] Saved JSON to {json_file}")

        csv_file = self.output_dir / f"{self.name}_products.csv"
        lines = ["name,price,currency,url,item_id"]
        for p in result.products:
            name = (p.name or "").replace('"', '""')
            price = p.price if p.price is not None else ""
            lines.append(f'"{name}",{price},"{p.currency or ""}","{p.url or ""}","{p.item_id or ""}"')
        csv_file.write_text("\n".join(lines), encoding="utf-8")
        print(f"[{self.name}] Saved CSV to {csv_file}")

        return json_file, csv_file
