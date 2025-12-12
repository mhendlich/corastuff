"""SQLite database operations for storing scrape results."""

from __future__ import annotations

import hashlib
import math
import re
import sqlite3
import statistics
from io import BytesIO
from difflib import SequenceMatcher
from datetime import datetime, timedelta, timezone
from pathlib import Path
from collections import defaultdict

from PIL import Image

from .models import Product, ScrapeResult


class ProductDatabase:
    """SQLite database for storing scraped products with history."""

    def __init__(self, db_path: Path | None = None):
        self.db_path = db_path or Path(__file__).parent.parent / "output" / "products.db"
        self._init_db()

    def _init_db(self):
        """Initialize the database schema."""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        with sqlite3.connect(self.db_path) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                scraped_at TEXT NOT NULL,
                name TEXT NOT NULL,
                price REAL,
                currency TEXT,
                url TEXT,
                item_id TEXT,
                product_key TEXT
            )
            """)
            # Index for efficient querying by source and time
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_source_time
                ON products (source, scraped_at)
            """)

            # Index for efficient item_id lookups
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_source_item
                ON products (source, item_id)
            """)
            # Composite index for historical lookups per item
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_source_item_time
                ON products (source, item_id, scraped_at)
            """)

            # Ensure product_key column exists for older databases
            try:
                conn.execute("ALTER TABLE products ADD COLUMN product_key TEXT")
            except sqlite3.OperationalError:
                pass  # Column already exists

            # Latest product images per source/product
            conn.execute("""
                CREATE TABLE IF NOT EXISTS product_images (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source TEXT NOT NULL,
                    product_key TEXT NOT NULL,
                    item_id TEXT,
                    url TEXT,
                    image_data BLOB,
                    image_hash TEXT,
                    image_mime TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(source, product_key)
                )
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_product_images_source
                ON product_images (source)
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_product_images_hash
                ON product_images (image_hash)
            """)

            # Canonical products - master product entities
            conn.execute("""
                CREATE TABLE IF NOT EXISTS canonical_products (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    description TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            """)

            # Product links - connects source products to canonical products
            conn.execute("""
                CREATE TABLE IF NOT EXISTS product_links (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    canonical_id INTEGER NOT NULL,
                    source TEXT NOT NULL,
                    source_item_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (canonical_id) REFERENCES canonical_products(id) ON DELETE CASCADE,
                    UNIQUE(source, source_item_id)
                )
            """)

            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_product_links_canonical
                ON product_links (canonical_id)
            """)

            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_product_links_source
                ON product_links (source, source_item_id)
            """)

            # Scraper schedules - configuration for automatic scraper runs
            conn.execute("""
                CREATE TABLE IF NOT EXISTS scraper_schedules (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    scraper_name TEXT NOT NULL UNIQUE,
                    enabled BOOLEAN DEFAULT 0,
                    interval_minutes INTEGER DEFAULT 60,
                    last_run TEXT,
                    next_run TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
            """)

            # Scrape runs - history of all scrape job executions
            conn.execute("""
                CREATE TABLE IF NOT EXISTS scrape_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    scraper_name TEXT NOT NULL,
                    status TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    completed_at TEXT,
                    products_found INTEGER,
                    error_message TEXT,
                    duration_seconds REAL
                )
            """)

            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_scrape_runs_scraper
                ON scrape_runs (scraper_name, started_at DESC)
            """)

            # Job queue - persistent queue for scrape jobs (survives restarts)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS job_queue (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    scraper_name TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    priority INTEGER DEFAULT 0,
                    created_at TEXT NOT NULL,
                    claimed_at TEXT,
                    completed_at TEXT,
                    worker_id TEXT,
                    scrape_run_id INTEGER,
                    error_message TEXT,
                    retry_count INTEGER DEFAULT 0,
                    max_retries INTEGER DEFAULT 3,
                    FOREIGN KEY (scrape_run_id) REFERENCES scrape_runs(id)
                )
            """)

            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_job_queue_status
                ON job_queue (status, priority DESC, created_at ASC)
            """)

            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_job_queue_scraper
                ON job_queue (scraper_name, status)
            """)

            conn.commit()

    def save_results(self, result: ScrapeResult):
        """Save scrape results to the database (append mode for history)."""
        scraped_at = result.scraped_at.isoformat()

        with sqlite3.connect(self.db_path) as conn:
            for product in result.products:
                product_key = self._build_product_key(product)
                product_key_db = product_key or None
                conn.execute(
                    """
                    INSERT INTO products (source, scraped_at, name, price, currency, url, item_id, product_key)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        result.source,
                        scraped_at,
                        product.name,
                        product.price,
                        product.currency,
                        product.url,
                        product.item_id,
                        product_key_db,
                    ),
                )
                self._upsert_product_image(conn, result.source, product, product_key)
            conn.commit()

        print(f"[db] Saved {len(result.products)} products from '{result.source}' to {self.db_path}")

    def get_latest_scrape(self, source: str) -> list[dict]:
        """Get products from the most recent scrape for a source."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                """
                SELECT * FROM products
                WHERE source = ? AND scraped_at = (
                    SELECT MAX(scraped_at) FROM products WHERE source = ?
                )
                """,
                (source, source),
            )
            return [dict(row) for row in cursor.fetchall()]

    def get_all_scrapes(self, source: str | None = None) -> list[dict]:
        """Get all scrapes, optionally filtered by source."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            if source:
                cursor = conn.execute(
                    "SELECT * FROM products WHERE source = ? ORDER BY scraped_at DESC",
                    (source,),
                )
            else:
                cursor = conn.execute(
                    "SELECT * FROM products ORDER BY scraped_at DESC"
                )
            return [dict(row) for row in cursor.fetchall()]

    def get_scrape_history(self, source: str) -> list[dict]:
        """Get summary of all scrapes for a source (timestamp and count)."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                """
                SELECT scraped_at, COUNT(*) as product_count
                FROM products
                WHERE source = ?
                GROUP BY scraped_at
                ORDER BY scraped_at DESC
                """,
                (source,),
            )
            return [dict(row) for row in cursor.fetchall()]

    def get_product_price_history(self, source: str, item_id: str) -> list[dict]:
        """Get price history for a specific product across all scrapes."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                """
                SELECT p.*, pi.image_data, pi.image_mime, pi.image_hash, pi.updated_at as image_updated_at
                FROM products p
                LEFT JOIN product_images pi
                    ON pi.source = p.source
                    AND pi.product_key = COALESCE(p.product_key, p.item_id, p.url, p.name)
                WHERE p.source = ? AND p.item_id = ?
                ORDER BY scraped_at DESC
                """,
                (source, item_id),
            )
            return [dict(row) for row in cursor.fetchall()]

    # --- Canonical Products ---

    def create_canonical_product(self, name: str, description: str | None = None) -> int:
        """Create a new canonical product and return its ID."""
        now = datetime.utcnow().isoformat()
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute(
                """
                INSERT INTO canonical_products (name, description, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                """,
                (name, description, now, now),
            )
            conn.commit()
            return cursor.lastrowid

    def get_canonical_product(self, canonical_id: int) -> dict | None:
        """Get a canonical product by ID."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                "SELECT * FROM canonical_products WHERE id = ?",
                (canonical_id,),
            )
            row = cursor.fetchone()
            return dict(row) if row else None

    def get_all_canonical_products(self) -> list[dict]:
        """Get all canonical products."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                "SELECT * FROM canonical_products ORDER BY name"
            )
            return [dict(row) for row in cursor.fetchall()]

    def update_canonical_product(
        self, canonical_id: int, name: str, description: str | None = None
    ) -> bool:
        """Update a canonical product. Returns True if updated."""
        now = datetime.utcnow().isoformat()
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute(
                """
                UPDATE canonical_products
                SET name = ?, description = ?, updated_at = ?
                WHERE id = ?
                """,
                (name, description, now, canonical_id),
            )
            conn.commit()
            return cursor.rowcount > 0

    def delete_canonical_product(self, canonical_id: int) -> bool:
        """Delete a canonical product (cascades to links). Returns True if deleted."""
        with sqlite3.connect(self.db_path) as conn:
            # Enable foreign keys for cascade delete
            conn.execute("PRAGMA foreign_keys = ON")
            cursor = conn.execute(
                "DELETE FROM canonical_products WHERE id = ?",
                (canonical_id,),
            )
            conn.commit()
            return cursor.rowcount > 0

    # --- Product Links ---

    def link_product(
        self, canonical_id: int, source: str, source_item_id: str
    ) -> int | None:
        """Link a source product to a canonical product. Returns link ID or None if exists."""
        now = datetime.utcnow().isoformat()
        with sqlite3.connect(self.db_path) as conn:
            try:
                cursor = conn.execute(
                    """
                    INSERT INTO product_links (canonical_id, source, source_item_id, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (canonical_id, source, source_item_id, now),
                )
                conn.commit()
                return cursor.lastrowid
            except sqlite3.IntegrityError:
                # Already linked
                return None

    def unlink_product(self, source: str, source_item_id: str) -> bool:
        """Remove a product link. Returns True if unlinked."""
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute(
                "DELETE FROM product_links WHERE source = ? AND source_item_id = ?",
                (source, source_item_id),
            )
            conn.commit()
            return cursor.rowcount > 0

    def get_links_for_canonical(self, canonical_id: int) -> list[dict]:
        """Get all product links for a canonical product."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                """
                SELECT pl.*, p.name, p.price, p.currency, p.url,
                       pi.image_data, pi.image_mime, pi.image_hash, pi.updated_at as image_updated_at
                FROM product_links pl
                LEFT JOIN (
                    SELECT source, item_id, name, price, currency, url, product_key,
                           ROW_NUMBER() OVER (PARTITION BY source, item_id ORDER BY scraped_at DESC) as rn
                    FROM products
                ) p ON pl.source = p.source
                    AND (
                        pl.source_item_id = p.item_id
                        OR (pl.source_item_id IN ('', 'None') AND p.item_id IS NULL)
                    )
                    AND p.rn = 1
                LEFT JOIN product_images pi
                    ON pi.source = pl.source
                    AND pi.product_key = COALESCE(p.product_key, pl.source_item_id, p.url, p.name)
                WHERE pl.canonical_id = ?
                ORDER BY pl.source
                """,
                (canonical_id,),
            )
            return [dict(row) for row in cursor.fetchall()]

    def get_link_for_product(self, source: str, source_item_id: str) -> dict | None:
        """Get the canonical product link for a source product, if any."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                """
                SELECT pl.*, cp.name as canonical_name
                FROM product_links pl
                JOIN canonical_products cp ON pl.canonical_id = cp.id
                WHERE pl.source = ? AND pl.source_item_id = ?
                """,
                (source, source_item_id),
            )
            row = cursor.fetchone()
            return dict(row) if row else None

    # --- Aggregated Queries ---

    def get_latest_products_all_sources(self) -> list[dict]:
        """Get the latest products from all sources (most recent scrape per source)."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                """
                SELECT p.*, pl.canonical_id,
                       pi.image_data, pi.image_mime, pi.image_hash, pi.updated_at as image_updated_at
                FROM products p
                LEFT JOIN product_links pl ON p.source = pl.source AND p.item_id = pl.source_item_id
                LEFT JOIN product_images pi
                    ON pi.source = p.source
                    AND pi.product_key = COALESCE(p.product_key, p.item_id, p.url, p.name)
                WHERE p.scraped_at = (
                    SELECT MAX(p2.scraped_at) FROM products p2 WHERE p2.source = p.source
                )
                ORDER BY p.source, p.name
                """
            )
            return [dict(row) for row in cursor.fetchall()]

    def get_unlinked_products(
        self,
        include_images: bool = True,
        source: str | None = None,
    ) -> list[dict]:
        """Get latest products that are not linked to any canonical product.

        include_images=False avoids pulling large blobs when we only need metadata.
        """
        image_select = (
            ", pi.image_data, pi.image_mime, pi.image_hash, pi.updated_at as image_updated_at"
            if include_images
            else ", pi.image_hash, pi.image_mime, pi.updated_at as image_updated_at"
        )
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            where_source = ""
            params: list[str] = []
            if source:
                where_source = " AND p.source = ?"
                params.append(source)

            cursor = conn.execute(
                """
                SELECT p.*{image_select}
                FROM products p
                LEFT JOIN product_links pl ON p.source = pl.source AND p.item_id = pl.source_item_id
                LEFT JOIN product_images pi
                    ON pi.source = p.source
                    AND pi.product_key = COALESCE(p.product_key, p.item_id, p.url, p.name)
                WHERE pl.id IS NULL
                AND p.scraped_at = (
                    SELECT MAX(p2.scraped_at) FROM products p2 WHERE p2.source = p.source
                )
                {where_source}
                ORDER BY p.source, p.name
                """.format(image_select=image_select, where_source=where_source),
                params,
            )
            return [dict(row) for row in cursor.fetchall()]

    def get_linked_products(self) -> list[dict]:
        """Get latest products that are linked to a canonical product."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                """
                SELECT p.*, pl.canonical_id, cp.name as canonical_name,
                       pi.image_data, pi.image_mime, pi.image_hash, pi.updated_at as image_updated_at
                FROM products p
                JOIN product_links pl ON p.source = pl.source AND p.item_id = pl.source_item_id
                JOIN canonical_products cp ON pl.canonical_id = cp.id
                LEFT JOIN product_images pi
                    ON pi.source = p.source
                    AND pi.product_key = COALESCE(p.product_key, p.item_id, p.url, p.name)
                WHERE p.scraped_at = (
                    SELECT MAX(p2.scraped_at) FROM products p2 WHERE p2.source = p.source
                )
                ORDER BY cp.name, p.source
                """
            )
            return [dict(row) for row in cursor.fetchall()]

    # --- Amazon Pricing / Manual Inputs ---

    def add_manual_amazon_product(
        self,
        asin: str,
        name: str | None = None,
        price: float | None = None,
        currency: str | None = "EUR",
        url: str | None = None,
    ) -> int:
        """Insert a manual Amazon price snapshot into products history.

        This is used before the Amazon scraper exists and continues to be useful
        for quick corrections. The Amazon listing is identified by ASIN.
        """
        asin_clean = (asin or "").strip()
        if not asin_clean:
            raise ValueError("ASIN is required")

        now = datetime.utcnow().isoformat()
        display_name = (name or asin_clean).strip()
        product_key = asin_clean

        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute(
                """
                INSERT INTO products (source, scraped_at, name, price, currency, url, item_id, product_key)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                ("amazon", now, display_name, price, currency, url, asin_clean, product_key),
            )
            conn.commit()
            return int(cursor.lastrowid)

    def get_amazon_pricing_items(
        self,
        amazon_prefix: str = "amazon",
        undercut_by: float = 0.01,
        tolerance: float = 0.01,
        only_with_amazon: bool = False,
    ) -> list[dict]:
        """Compute Amazon vs retailer pricing opportunities per canonical product.

        Returns one item per canonical with:
          - action: undercut | raise | watch | missing_amazon | missing_competitors | missing_own_price
          - suggested_price when applicable

        When `only_with_amazon` is True, canonicals without an Amazon link are skipped.
        """
        canonicals = self.get_all_canonical_products()
        items: list[dict] = []

        def is_amazon_source(source: str | None) -> bool:
            if not source:
                return False
            return source == amazon_prefix or source.startswith(amazon_prefix)

        for canonical in canonicals:
            canonical_id = int(canonical["id"])
            links = self.get_links_for_canonical(canonical_id)

            amazon_links = [l for l in links if is_amazon_source(l.get("source"))]
            competitor_links = [l for l in links if l.get("source") and not is_amazon_source(l.get("source"))]

            # Pick a primary Amazon listing to compare (lowest priced if multiple).
            primary_amazon = None
            if amazon_links:
                with_prices = [l for l in amazon_links if l.get("price") is not None]
                primary_amazon = min(with_prices, key=lambda l: float(l["price"])) if with_prices else amazon_links[0]

            competitor_with_prices = [l for l in competitor_links if l.get("price") is not None]
            comp_min = min(competitor_with_prices, key=lambda l: float(l["price"])) if competitor_with_prices else None
            comp_max = max(competitor_with_prices, key=lambda l: float(l["price"])) if competitor_with_prices else None

            item: dict = {
                "canonical_id": canonical_id,
                "canonical_name": canonical.get("name"),
                "canonical_description": canonical.get("description"),
                "amazon_links": amazon_links,
                "primary_amazon": primary_amazon,
                "competitors": competitor_with_prices,
                "competitor_min": comp_min,
                "competitor_max": comp_max,
                "competitor_count": len(competitor_with_prices),
                "action": None,
                "own_price": None,
                "own_currency": None,
                "delta_abs": None,
                "delta_pct": None,
                "suggested_price": None,
                "suggested_reason": None,
            }

            if not amazon_links:
                if only_with_amazon:
                    continue
                item["action"] = "missing_amazon"
                items.append(item)
                continue

            own_price = primary_amazon.get("price") if primary_amazon else None
            item["own_price"] = own_price
            item["own_currency"] = primary_amazon.get("currency") if primary_amazon else None

            if own_price is None:
                item["action"] = "missing_own_price"
                items.append(item)
                continue

            if not competitor_with_prices:
                item["action"] = "missing_competitors"
                items.append(item)
                continue

            comp_min_price = float(comp_min["price"]) if comp_min else None
            own_price_f = float(own_price)
            if comp_min_price is None or comp_min_price <= 0:
                item["action"] = "missing_competitors"
                items.append(item)
                continue

            delta_abs = own_price_f - comp_min_price
            delta_pct = (delta_abs / comp_min_price) * 100 if comp_min_price else None
            item["delta_abs"] = delta_abs
            item["delta_pct"] = delta_pct

            if delta_abs > tolerance:
                item["action"] = "undercut"
                item["suggested_price"] = max(comp_min_price - undercut_by, 0.0)
                item["suggested_reason"] = f"Undercut {comp_min.get('source')} by {undercut_by:.2f}"
            elif delta_abs < -tolerance:
                item["action"] = "raise"
                item["suggested_price"] = comp_min_price
                item["suggested_reason"] = f"Match lowest retailer ({comp_min.get('source')})"
            else:
                item["action"] = "watch"

            items.append(item)

        # Sort by urgency: undercut first (largest overprice), then raise (largest gap), then others.
        def sort_key(it: dict) -> tuple:
            action = it.get("action")
            delta_abs = it.get("delta_abs") or 0.0
            if action == "undercut":
                return (0, -abs(delta_abs))
            if action == "raise":
                return (1, -abs(delta_abs))
            if action == "watch":
                return (2, 0)
            if action == "missing_own_price":
                return (3, 0)
            if action == "missing_competitors":
                return (4, 0)
            return (5, 0)

        items.sort(key=sort_key)
        return items

    def get_product_image_by_hash(self, image_hash: str) -> dict | None:
        """Fetch a stored product image by its content hash."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                """
                SELECT image_data, image_mime, updated_at
                FROM product_images
                WHERE image_hash = ?
                """,
                (image_hash,),
            )
            row = cursor.fetchone()
            return dict(row) if row else None

    def get_link_suggestions(self, limit: int = 15, exclude_keys: list[str] | None = None) -> list[dict]:
        """Return high-confidence canonical matches for unlinked products."""
        exclude_set = {key for key in (exclude_keys or []) if key}
        unlinked = self.get_unlinked_products()
        canonical_products = self.get_all_canonical_products()

        matches: list[dict] = []

        # If no canonicals exist yet, bootstrap suggestions by fuzzy matching
        # unlinked products against a "seed" source so users can create canonicals.
        if not canonical_products:
            bootstrap_limit = min(limit * 10, 200)
            matches = self._bootstrap_link_suggestions(
                unlinked_products=unlinked,
                limit=bootstrap_limit,
                exclude_set=exclude_set,
            )
        else:
            canonical_assets = self._build_canonical_asset_index(canonical_products)

            for product in unlinked:
                product_key = f"{product['source']}::{product.get('item_id') or ''}"
                if product_key in exclude_set:
                    continue

                product_features = self._extract_product_features(product)
                best_match = None

                for canonical in canonical_products:
                    assets = canonical_assets.get(
                        canonical["id"],
                        {"linked_names": set(), "item_ids": set(), "images": []},
                    )
                    score, reasons, details = self._score_match(
                        product, product_features, canonical, assets
                    )
                    if score <= 0.35:
                        continue

                    if not best_match or score > best_match["score"]:
                        canonical_image = None
                        canonical_image_mime = None
                        if details.get("image_bytes"):
                            canonical_image = details["image_bytes"]
                            canonical_image_mime = details.get("image_mime")
                        elif assets.get("images"):
                            canonical_image = assets["images"][0].get("data")
                            canonical_image_mime = assets["images"][0].get("mime")

                        best_match = {
                            "source": product["source"],
                            "source_item_id": product.get("item_id"),
                            "product_name": product.get("name"),
                            "product_price": product.get("price"),
                            "product_currency": product.get("currency"),
                            "product_url": product.get("url"),
                            "product_image": product.get("image_data"),
                            "product_image_mime": product.get("image_mime"),
                            "canonical_id": canonical["id"],
                            "canonical_name": canonical["name"],
                            "score": round(score, 4),
                            "reasons": reasons,
                            "matched_name": details.get("matched_name"),
                            "canonical_image": canonical_image,
                            "canonical_image_mime": canonical_image_mime,
                            "linked_names": sorted(list(assets.get("linked_names", [])))[:3],
                        }

                if best_match:
                    matches.append(best_match)

        if not matches:
            return []

        # Group matches per canonical (one product per source).
        groups: dict[object, dict] = {}
        for match in matches:
            canonical_id = match.get("canonical_id")
            if canonical_id is None:
                seed_source = match.get("seed_source") or ""
                seed_item_id = match.get("seed_item_id") or match.get("canonical_name") or ""
                canonical_key: object = f"seed::{seed_source}::{seed_item_id}"
            else:
                canonical_key = canonical_id

            group = groups.get(canonical_key)
            if group is None:
                group = {
                    "canonical_id": canonical_id,
                    "canonical_name": match.get("canonical_name"),
                    "canonical_image": match.get("canonical_image"),
                    "canonical_image_mime": match.get("canonical_image_mime"),
                    "linked_names": match.get("linked_names") or [],
                    "reasons": match.get("reasons") or [],
                    "matched_name": match.get("matched_name"),
                    "score": match.get("score") or 0.0,
                    "create_new": bool(match.get("create_new")),
                    "seed_source": match.get("seed_source"),
                    "_matches_by_source": {},
                }
                groups[canonical_key] = group

            source = match.get("source")
            if not source:
                continue
            existing = group["_matches_by_source"].get(source)
            if existing is None or (match.get("score") or 0.0) > (existing.get("score") or 0.0):
                group["_matches_by_source"][source] = match

            if (match.get("score") or 0.0) > (group.get("score") or 0.0):
                group["score"] = match.get("score") or 0.0
                group["reasons"] = match.get("reasons") or []
                group["matched_name"] = match.get("matched_name")
                group["canonical_image"] = match.get("canonical_image")
                group["canonical_image_mime"] = match.get("canonical_image_mime")
                if match.get("linked_names"):
                    group["linked_names"] = match.get("linked_names") or group["linked_names"]
            if match.get("create_new"):
                group["create_new"] = True
                if match.get("seed_source"):
                    group["seed_source"] = match.get("seed_source")

        grouped: list[dict] = []
        for group in groups.values():
            matches_for_group = list(group.pop("_matches_by_source").values())
            matches_for_group.sort(key=lambda m: m.get("score") or 0.0, reverse=True)
            group["matches"] = matches_for_group
            grouped.append(group)

        grouped.sort(key=lambda g: g.get("score") or 0.0, reverse=True)
        return grouped[:limit]

    def _bootstrap_link_suggestions(
        self,
        unlinked_products: list[dict],
        limit: int,
        exclude_set: set[str],
        min_score: float = 0.35,
    ) -> list[dict]:
        """Suggest matches even when there are no canonicals.

        Strategy: pick the largest source as a stable seed pool and match other
        sources' products to it. Suggestions are returned with canonical_id=None
        and create_new=True so the UI can create a canonical on approval.
        """
        if not unlinked_products:
            return []

        products_by_source: dict[str, list[dict]] = defaultdict(list)
        for product in unlinked_products:
            if not product.get("source"):
                continue
            products_by_source[product["source"]].append(product)

        if len(products_by_source) < 2:
            return []

        seed_source = max(products_by_source.items(), key=lambda kv: len(kv[1]))[0]
        seed_products = products_by_source.get(seed_source, [])
        if not seed_products:
            return []

        seed_index: list[tuple[dict, dict, set[str], dict]] = []
        for seed in seed_products:
            seed_name = seed.get("name") or ""
            seed_tokens = self._tokenize(seed_name)
            seed_features = self._extract_product_features(seed)
            seed_assets = {
                "linked_names": {seed_name} if seed_name else set(),
                "item_ids": {str(seed.get("item_id"))} if seed.get("item_id") else set(),
                "images": [],
            }
            if seed.get("image_data"):
                seed_assets["images"].append(
                    {
                        "hash": seed.get("image_hash"),
                        "avg_hash": seed_features.get("avg_hash"),
                        "data": seed.get("image_data"),
                        "mime": seed.get("image_mime"),
                    }
                )
            seed_index.append((seed, seed_features, seed_tokens, seed_assets))

        suggestions: list[dict] = []
        for product in unlinked_products:
            if product.get("source") == seed_source:
                continue

            product_key = f"{product.get('source')}::{product.get('item_id') or ''}"
            if product_key in exclude_set:
                continue

            product_features = self._extract_product_features(product)
            product_name = product.get("name") or ""
            product_tokens = self._tokenize(product_name)

            best_match = None
            best_seed = None
            best_details = None
            best_reasons: list[str] = []

            for seed, _seed_features, seed_tokens, seed_assets in seed_index:
                if product_tokens and seed_tokens and not (product_tokens & seed_tokens):
                    continue

                score, reasons, details = self._score_match(
                    product,
                    product_features,
                    {"id": -1, "name": seed.get("name") or ""},
                    seed_assets,
                )
                if score <= min_score:
                    continue
                if not best_match or score > best_match:
                    best_match = score
                    best_seed = seed
                    best_details = details
                    best_reasons = reasons

            if best_match is None or best_seed is None:
                continue

            canonical_name = best_seed.get("name")
            canonical_image = None
            canonical_image_mime = None
            if best_details and best_details.get("image_bytes"):
                canonical_image = best_details["image_bytes"]
                canonical_image_mime = best_details.get("image_mime")
            elif best_seed.get("image_data"):
                canonical_image = best_seed.get("image_data")
                canonical_image_mime = best_seed.get("image_mime")

            reasons = list(best_reasons)
            reasons.append("Creates new canonical on approval")

            suggestions.append(
                {
                    "source": product.get("source"),
                    "source_item_id": product.get("item_id"),
                    "product_name": product.get("name"),
                    "product_price": product.get("price"),
                    "product_currency": product.get("currency"),
                    "product_url": product.get("url"),
                    "product_image": product.get("image_data"),
                    "product_image_mime": product.get("image_mime"),
                    "canonical_id": None,
                    "canonical_name": canonical_name,
                    "score": round(float(best_match), 4),
                    "reasons": reasons,
                    "matched_name": best_details.get("matched_name") if best_details else None,
                    "canonical_image": canonical_image,
                    "canonical_image_mime": canonical_image_mime,
                    "linked_names": [],
                    "create_new": True,
                    "seed_source": seed_source,
                    "seed_item_id": best_seed.get("item_id"),
                }
            )

        suggestions.sort(key=lambda s: s.get("score") or 0.0, reverse=True)
        return suggestions[:limit]

    def auto_link_source_products(
        self,
        source: str,
        min_score: float = 0.8,
        max_links: int | None = None,
    ) -> list[dict]:
        """Automatically link latest unlinked products from a source to canonicals.

        Uses the same scoring model as link suggestions. Only links when the best
        match score is >= min_score. Returns a list of link actions taken.
        """
        if not source:
            return []

        unlinked = self.get_unlinked_products(include_images=True, source=source)
        if not unlinked:
            return []

        canonical_products = self.get_all_canonical_products()
        if not canonical_products:
            return []

        canonical_assets = self._build_canonical_asset_index(canonical_products)
        actions: list[dict] = []

        for product in unlinked:
            product_features = self._extract_product_features(product)
            best_match = None

            for canonical in canonical_products:
                assets = canonical_assets.get(
                    canonical["id"],
                    {"linked_names": set(), "item_ids": set(), "images": []},
                )
                score, reasons, _details = self._score_match(
                    product, product_features, canonical, assets
                )
                if score < min_score:
                    continue
                if not best_match or score > best_match["score"]:
                    best_match = {
                        "canonical_id": canonical["id"],
                        "canonical_name": canonical.get("name"),
                        "score": score,
                        "reasons": reasons,
                    }

            if not best_match:
                continue

            source_item_id = str(product.get("item_id") or "").strip()
            if not source_item_id:
                continue

            link_id = self.link_product(best_match["canonical_id"], source, source_item_id)
            if link_id is None:
                continue

            actions.append(
                {
                    "link_id": link_id,
                    "source": source,
                    "source_item_id": source_item_id,
                    "product_name": product.get("name"),
                    "canonical_id": best_match["canonical_id"],
                    "canonical_name": best_match["canonical_name"],
                    "score": round(float(best_match["score"]), 4),
                    "reasons": best_match["reasons"],
                }
            )

            if max_links is not None and len(actions) >= max_links:
                break

        return actions

    def get_tracked_amazon_links(self, amazon_prefix: str = "amazon") -> list[dict]:
        """Return distinct Amazon links (source + ASIN) attached to canonicals."""
        like_pattern = f"{amazon_prefix}%"
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                """
                SELECT DISTINCT canonical_id, source, source_item_id
                FROM product_links
                WHERE source = ? OR source LIKE ?
                """,
                (amazon_prefix, like_pattern),
            )
            links: list[dict] = []
            for row in cursor.fetchall():
                asin = str(row["source_item_id"] or "").strip().upper()
                if not asin:
                    continue
                links.append(
                    {
                        "canonical_id": row["canonical_id"],
                        "source": row["source"],
                        "asin": asin,
                    }
                )
            return links

    def get_tracked_amazon_asins(self, amazon_prefix: str = "amazon") -> set[str]:
        """Return all ASINs linked to canonicals for Amazon sources."""
        return {l["asin"] for l in self.get_tracked_amazon_links(amazon_prefix=amazon_prefix)}

    def _build_canonical_asset_index(self, canonical_products: list[dict]) -> dict[int, dict]:
        """Collect linked names, SKUs, and images for each canonical product."""
        assets = {
            cp["id"]: {"name": cp["name"], "linked_names": set(), "item_ids": set(), "images": []}
            for cp in canonical_products
        }

        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                """
                SELECT cp.id as canonical_id, cp.name as canonical_name,
                       p.name as linked_name, p.item_id,
                       pi.image_data, pi.image_mime, pi.image_hash
                FROM canonical_products cp
                JOIN product_links pl ON cp.id = pl.canonical_id
                LEFT JOIN (
                    SELECT source, item_id, name, url, product_key,
                           ROW_NUMBER() OVER (PARTITION BY source, item_id ORDER BY scraped_at DESC) as rn
                    FROM products
                ) p ON pl.source = p.source
                    AND (
                        pl.source_item_id = p.item_id
                        OR (pl.source_item_id IN ('', 'None') AND p.item_id IS NULL)
                    )
                    AND p.rn = 1
                LEFT JOIN product_images pi
                    ON pi.source = pl.source
                    AND pi.product_key = COALESCE(p.product_key, pl.source_item_id, p.url, p.name)
                """
            )

            for row in cursor.fetchall():
                entry = assets.setdefault(
                    row["canonical_id"],
                    {"name": row["canonical_name"], "linked_names": set(), "item_ids": set(), "images": []},
                )
                if row["linked_name"]:
                    entry["linked_names"].add(row["linked_name"])
                if row["item_id"]:
                    entry["item_ids"].add(str(row["item_id"]))
                if row["image_data"]:
                    entry["images"].append(
                        {
                            "hash": row["image_hash"],
                            "avg_hash": self._average_hash_for_similarity(row["image_data"]),
                            "data": row["image_data"],
                            "mime": row["image_mime"],
                        }
                    )

        return assets

    def _extract_product_features(self, product: dict) -> dict:
        """Prepare normalized features used for suggestion scoring."""
        image_data = product.get("image_data")
        avg_hash = self._average_hash_for_similarity(image_data) if image_data else None
        image_hash = product.get("image_hash")

        if not image_hash and image_data:
            image_hash = hashlib.sha256(image_data).hexdigest()

        return {
            "sku": self._normalize_token(product.get("item_id")),
            "avg_hash": avg_hash,
            "image_hash": image_hash,
        }

    def _score_match(
        self,
        product: dict,
        product_features: dict,
        canonical: dict,
        assets: dict,
    ) -> tuple[float, list[str], dict]:
        """Compute a similarity score for a single product/canonical pairing."""
        reasons: list[str] = []
        name = product.get("name") or ""
        best_name_score = self._text_similarity(name, canonical.get("name") or "")
        matched_name = canonical.get("name")

        for linked_name in assets.get("linked_names", []):
            candidate_score = self._text_similarity(name, linked_name)
            if candidate_score > best_name_score:
                best_name_score = candidate_score
                matched_name = linked_name

        score = 0.0
        if best_name_score > 0:
            score += best_name_score * 0.55
            if best_name_score >= 0.25:
                reasons.append(f"Name similarity {int(best_name_score * 100)}% vs '{matched_name}'")

        # SKU / item_id match
        sku_reason = None
        product_sku = product_features.get("sku")
        if product_sku and assets.get("item_ids"):
            for sku in assets["item_ids"]:
                normalized = self._normalize_token(sku)
                if not normalized:
                    continue
                if normalized == product_sku:
                    score += 0.3
                    sku_reason = f"Exact SKU match ({sku})"
                    break
                sku_similarity = self._text_similarity(product.get("item_id"), sku)
                if sku_similarity > 0.7:
                    score += 0.15
                    sku_reason = f"Similar SKU {sku} ({int(sku_similarity * 100)}%)"
                    break

        if sku_reason:
            reasons.append(sku_reason)

        # Image match
        image_boost = 0.0
        image_reason = None
        best_image_bytes = None
        best_image_mime = None
        if product_features.get("image_hash") and assets.get("images"):
            for image in assets["images"]:
                if image.get("hash") and image["hash"] == product_features["image_hash"]:
                    image_boost = 0.45
                    image_reason = "Exact image match"
                    best_image_bytes = image.get("data")
                    best_image_mime = image.get("mime")
                    break

                if image.get("avg_hash") and product_features.get("avg_hash"):
                    distance = self._hamming_distance(image["avg_hash"], product_features["avg_hash"])
                    if distance is None:
                        continue
                    similarity = 1 - (distance / len(image["avg_hash"]))
                    if similarity >= 0.75:
                        boost = 0.25 + (similarity - 0.75) * 0.3
                        if boost > image_boost:
                            image_boost = boost
                            image_reason = f"Similar image ({int(similarity * 100)}%)"
                            best_image_bytes = image.get("data")
                            best_image_mime = image.get("mime")

        if image_reason:
            score += image_boost
            reasons.append(image_reason)

        total_score = min(score, 0.99)
        return total_score, reasons, {
            "matched_name": matched_name,
            "image_bytes": best_image_bytes,
            "image_mime": best_image_mime,
        }

    @staticmethod
    def _tokenize(text: str) -> set[str]:
        if not text:
            return set()
        return set(re.findall(r"[a-z0-9]+", text.lower()))

    @staticmethod
    def _normalize_token(value: str | None) -> str:
        if not value:
            return ""
        return re.sub(r"[^a-z0-9]+", "", str(value).lower())

    def _text_similarity(self, a: str | None, b: str | None) -> float:
        if not a or not b:
            return 0.0

        tokens_a = self._tokenize(a)
        tokens_b = self._tokenize(b)
        overlap = (len(tokens_a & tokens_b) / len(tokens_a | tokens_b)) if tokens_a and tokens_b else 0.0
        ratio = SequenceMatcher(None, a.lower(), b.lower()).ratio()
        return (ratio * 0.6) + (overlap * 0.4)

    def _average_hash_for_similarity(self, image_bytes: bytes | None, hash_size: int = 8) -> str | None:
        if not image_bytes:
            return None

        try:
            with Image.open(BytesIO(image_bytes)) as img:
                resample = Image.Resampling.LANCZOS if hasattr(Image, "Resampling") else Image.LANCZOS
                img = img.convert("L").resize((hash_size, hash_size), resample)
                pixels = list(img.getdata())
        except Exception:
            return None

        avg = sum(pixels) / len(pixels)
        return "".join("1" if pixel > avg else "0" for pixel in pixels)

    @staticmethod
    def _hamming_distance(a: str | None, b: str | None) -> int | None:
        if not a or not b or len(a) != len(b):
            return None
        return sum(ch1 != ch2 for ch1, ch2 in zip(a, b))

    def get_sources(self) -> list[str]:
        """Get list of all sources that have products."""
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute(
                "SELECT DISTINCT source FROM products ORDER BY source"
            )
            return [row[0] for row in cursor.fetchall()]

    def get_stats(self) -> dict:
        """Get statistics for dashboard."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row

            # Count canonical products
            canonical_count = conn.execute(
                "SELECT COUNT(*) FROM canonical_products"
            ).fetchone()[0]

            # Count total links
            link_count = conn.execute(
                "SELECT COUNT(*) FROM product_links"
            ).fetchone()[0]

            # Count unique unlinked products (latest scrape only)
            unlinked_count = conn.execute(
                """
                SELECT COUNT(DISTINCT p.source || '::' || p.item_id)
                FROM products p
                LEFT JOIN product_links pl ON p.source = pl.source AND p.item_id = pl.source_item_id
                WHERE pl.id IS NULL
                AND p.item_id IS NOT NULL
                AND p.scraped_at = (
                    SELECT MAX(p2.scraped_at) FROM products p2 WHERE p2.source = p.source
                )
                """
            ).fetchone()[0]

            # Count sources
            source_count = conn.execute(
                "SELECT COUNT(DISTINCT source) FROM products"
            ).fetchone()[0]

            return {
                "canonical_products": canonical_count,
                "linked_products": link_count,
                "unlinked_products": unlinked_count,
                "sources": source_count,
            }

    @staticmethod
    def _parse_timestamp(value: str | None) -> datetime | None:
        """Parse ISO timestamp strings safely."""
        if not value:
            return None

        for candidate in (value, value.replace("Z", "") if "Z" in value else value):
            try:
                parsed = datetime.fromisoformat(candidate)
                # Normalize to naive UTC to avoid offset-aware vs naive math errors
                if parsed.tzinfo:
                    return parsed.astimezone(timezone.utc).replace(tzinfo=None)
                return parsed
            except Exception:
                continue
        return None

    def get_source_coverage_snapshot(self, limit: int = 6) -> list[dict]:
        """Return coverage per source for the latest scrape (linked vs unlinked, missing prices)."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                """
                WITH latest AS (
                    SELECT source, MAX(scraped_at) AS latest_at
                    FROM products
                    GROUP BY source
                ),
                current AS (
                    SELECT p.*
                    FROM products p
                    JOIN latest l ON p.source = l.source AND p.scraped_at = l.latest_at
                )
                SELECT
                    c.source,
                    COUNT(*) AS total_products,
                    SUM(CASE WHEN pl.id IS NULL THEN 1 ELSE 0 END) AS unlinked_products,
                    SUM(CASE WHEN c.price IS NULL THEN 1 ELSE 0 END) AS missing_prices,
                    MAX(c.scraped_at) AS scraped_at
                FROM current c
                LEFT JOIN product_links pl
                    ON c.source = pl.source
                    AND (pl.source_item_id = c.item_id OR (pl.source_item_id IN ('', 'None') AND c.item_id IS NULL))
                GROUP BY c.source
                ORDER BY unlinked_products DESC, missing_prices DESC
                LIMIT ?
                """,
                (limit,),
            )

            results: list[dict] = []
            for row in cursor.fetchall():
                total = row["total_products"] or 0
                unlinked = row["unlinked_products"] or 0
                missing_prices = row["missing_prices"] or 0
                coverage_pct = 0.0
                if total > 0:
                    coverage_pct = round((1 - (unlinked / total)) * 100, 1)

                results.append(
                    {
                        "source": row["source"],
                        "total_products": total,
                        "unlinked_products": unlinked,
                        "missing_prices": missing_prices,
                        "coverage_pct": coverage_pct,
                        "scraped_at": row["scraped_at"],
                    }
                )

            return results

    def get_canonical_coverage_gaps(self, limit: int = 6) -> list[dict]:
        """Return canonical products with weak coverage (zero or single link)."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                """
                SELECT
                    cp.id,
                    cp.name,
                    cp.created_at,
                    COUNT(pl.id) AS link_count,
                    MIN(pl.created_at) AS first_linked_at,
                    MAX(pl.created_at) AS last_linked_at
                FROM canonical_products cp
                LEFT JOIN product_links pl ON cp.id = pl.canonical_id
                GROUP BY cp.id
                HAVING link_count <= 1
                ORDER BY link_count ASC, cp.created_at DESC
                LIMIT ?
                """,
                (limit,),
            )
            return [dict(row) for row in cursor.fetchall()]

    def get_recent_scrape_failures(self, hours: int = 36, limit: int = 10) -> list[dict]:
        """Return recent scrape failures within the provided window."""
        cutoff = datetime.utcnow() - timedelta(hours=hours)
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                "SELECT * FROM scrape_runs ORDER BY started_at DESC LIMIT ?",
                (max(limit * 3, 30),),
            )

            failures: list[dict] = []
            for row in cursor.fetchall():
                started_at = self._parse_timestamp(row["started_at"])
                if started_at and started_at < cutoff:
                    break
                if row["status"] == "failed":
                    failures.append(dict(row))
                if len(failures) >= limit:
                    break
            return failures

    def get_insights_snapshot(self) -> dict:
        """Build a snapshot of interesting insights across price movements, canonicals, and scrape health."""
        now = datetime.utcnow()
        stats = self.get_stats()
        last_scrapes = self.get_last_scrape_times()
        latest_products = self.get_latest_products_with_price_change(include_images=False)
        latest_by_pair = {
            (p.get("source"), p.get("item_id")): p
            for p in latest_products
            if p.get("source") and p.get("item_id")
        }

        def _median(values: list[float]) -> float | None:
            if not values:
                return None
            try:
                return float(statistics.median(values))
            except statistics.StatisticsError:
                return None

        price_drops: list[dict] = []
        price_rises: list[dict] = []
        missing_prices: list[dict] = []

        # New signals
        multi_horizon: dict[str, list[dict]] = {
            "7d_drops": [],
            "7d_spikes": [],
            "30d_drops": [],
            "30d_spikes": [],
        }
        new_lows: list[dict] = []
        new_highs: list[dict] = []
        volatility_items: list[dict] = []
        sustained_drops: list[dict] = []
        sustained_rises: list[dict] = []
        returned_to_normal: list[dict] = []
        dormant_revived: list[dict] = []
        canonical_drops: list[dict] = []
        canonical_spikes: list[dict] = []
        dispersion_leaders: list[dict] = []
        outliers: list[dict] = []

        drop_threshold_pct = -8.0
        spike_threshold_pct = 12.0
        outlier_threshold_pct = 18.0
        recent_window = timedelta(hours=24)
        dormant_days = 14

        cutoff_7d = (now - timedelta(days=7)).isoformat()
        cutoff_30d = (now - timedelta(days=30)).isoformat()
        cutoff_30d_history = cutoff_30d

        # Historical stats for items in latest scrape
        item_stats: dict[tuple[str, str], dict] = {}
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                """
                WITH latest_scrapes AS (
                    SELECT source, MAX(scraped_at) as latest_at
                    FROM products
                    GROUP BY source
                ),
                latest_items AS (
                    SELECT p.source, p.item_id, ls.latest_at
                    FROM products p
                    JOIN latest_scrapes ls
                        ON p.source = ls.source AND p.scraped_at = ls.latest_at
                    WHERE p.item_id IS NOT NULL
                )
                SELECT li.source, li.item_id,
                       MIN(p.scraped_at) as first_seen,
                       MIN(p.price) as min_price,
                       MAX(p.price) as max_price,
                       MIN(CASE WHEN p.scraped_at < li.latest_at THEN p.price END) as min_prev_price,
                       MAX(CASE WHEN p.scraped_at < li.latest_at THEN p.price END) as max_prev_price,
                       (
                         SELECT p2.price
                         FROM products p2
                         WHERE p2.source = li.source
                           AND p2.item_id = li.item_id
                           AND p2.price IS NOT NULL
                           AND p2.scraped_at <= ?
                         ORDER BY p2.scraped_at DESC
                         LIMIT 1
                       ) as price_7d,
                       (
                         SELECT p3.price
                         FROM products p3
                         WHERE p3.source = li.source
                           AND p3.item_id = li.item_id
                           AND p3.price IS NOT NULL
                           AND p3.scraped_at <= ?
                         ORDER BY p3.scraped_at DESC
                         LIMIT 1
                       ) as price_30d
                FROM latest_items li
                JOIN products p
                    ON p.source = li.source AND p.item_id = li.item_id
                WHERE p.price IS NOT NULL
                GROUP BY li.source, li.item_id
                """,
                (cutoff_7d, cutoff_30d),
            )
            for row in cursor.fetchall():
                item_stats[(row["source"], row["item_id"])] = dict(row)

        # Recent movers, missing prices, and enriched per-item metrics
        for product in latest_products:
            source = product.get("source")
            item_id = product.get("item_id")
            scraped_at_raw = product.get("scraped_at")
            scraped_at = self._parse_timestamp(scraped_at_raw)
            change_pct = product.get("price_change_pct")
            change_abs = product.get("price_change")
            price = product.get("price")

            entry = {
                "name": product.get("name"),
                "source": source,
                "price": price,
                "currency": product.get("currency"),
                "change": change_abs,
                "change_pct": change_pct,
                "prev_price": product.get("prev_price"),
                "item_id": item_id,
                "scraped_at": scraped_at_raw,
                "url": product.get("url"),
                "canonical_id": product.get("canonical_id"),
            }

            if change_pct is not None and change_abs is not None:
                if change_pct <= drop_threshold_pct or change_abs <= -5:
                    price_drops.append(entry)
                elif change_pct >= spike_threshold_pct or change_abs >= 8:
                    price_rises.append(entry)

            if price is None:
                missing_prices.append(entry)

            if source and item_id and price is not None:
                stats_row = item_stats.get((source, item_id), {})
                price_7d = stats_row.get("price_7d")
                price_30d = stats_row.get("price_30d")
                min_price = stats_row.get("min_price")
                max_price = stats_row.get("max_price")
                min_prev_price = stats_row.get("min_prev_price")
                max_prev_price = stats_row.get("max_prev_price")
                first_seen = stats_row.get("first_seen")

                if price_7d is not None and price_7d > 0:
                    delta_pct = ((price - price_7d) / price_7d) * 100
                    delta_abs = price - price_7d
                    if abs(delta_pct) >= 5:
                        horizon_entry = {**entry, "baseline_price": price_7d, "horizon_days": 7, "delta_pct": delta_pct, "delta_abs": delta_abs}
                        (multi_horizon["7d_drops"] if delta_pct < 0 else multi_horizon["7d_spikes"]).append(horizon_entry)

                if price_30d is not None and price_30d > 0:
                    delta_pct = ((price - price_30d) / price_30d) * 100
                    delta_abs = price - price_30d
                    if abs(delta_pct) >= 7:
                        horizon_entry = {**entry, "baseline_price": price_30d, "horizon_days": 30, "delta_pct": delta_pct, "delta_abs": delta_abs}
                        (multi_horizon["30d_drops"] if delta_pct < 0 else multi_horizon["30d_spikes"]).append(horizon_entry)

                epsilon = 0.01
                if min_prev_price is not None and price <= float(min_prev_price) - epsilon:
                    new_lows.append({**entry, "extreme_price": float(min_price), "first_seen": first_seen})
                if max_prev_price is not None and price >= float(max_prev_price) + epsilon:
                    new_highs.append({**entry, "extreme_price": float(max_price), "first_seen": first_seen})

        price_drops.sort(key=lambda x: x.get("change_pct") if x.get("change_pct") is not None else float("inf"))
        price_rises.sort(key=lambda x: x.get("change_pct") if x.get("change_pct") is not None else -float("inf"), reverse=True)

        drop_count = len(price_drops)
        rise_count = len(price_rises)
        missing_price_count = len(missing_prices)
        new_lows_count = len(new_lows)
        new_highs_count = len(new_highs)

        # Limit noise and size
        price_drops = price_drops[:8]
        price_rises = price_rises[:6]
        missing_prices = missing_prices[:8]

        for key in multi_horizon:
            multi_horizon[key].sort(key=lambda x: x.get("delta_pct") or 0)
        multi_horizon["7d_drops"] = multi_horizon["7d_drops"][:6]
        multi_horizon["7d_spikes"] = list(reversed(multi_horizon["7d_spikes"]))[:6]
        multi_horizon["30d_drops"] = multi_horizon["30d_drops"][:6]
        multi_horizon["30d_spikes"] = list(reversed(multi_horizon["30d_spikes"]))[:6]

        new_lows.sort(key=lambda x: (x.get("change_pct") or 0))
        new_highs.sort(key=lambda x: -(x.get("change_pct") or 0))
        new_lows = new_lows[:6]
        new_highs = new_highs[:6]

        # Volatility over last 30 days
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                """
                WITH latest_scrapes AS (
                    SELECT source, MAX(scraped_at) as latest_at
                    FROM products
                    GROUP BY source
                ),
                latest_items AS (
                    SELECT p.source, p.item_id
                    FROM products p
                    JOIN latest_scrapes ls
                        ON p.source = ls.source AND p.scraped_at = ls.latest_at
                    WHERE p.item_id IS NOT NULL
                ),
                history AS (
                    SELECT p.source, p.item_id, p.price
                    FROM products p
                    JOIN latest_items li
                        ON p.source = li.source AND p.item_id = li.item_id
                    WHERE p.price IS NOT NULL AND p.scraped_at >= ?
                )
                SELECT source, item_id,
                       COUNT(*) as n,
                       AVG(price) as mean_price,
                       AVG(price * price) as mean_sq
                FROM history
                GROUP BY source, item_id
                HAVING n >= 4
                """,
                (cutoff_30d_history,),
            )
            vol_rows = [dict(r) for r in cursor.fetchall()]

        vol_scores: dict[tuple[str, str], float] = {}
        for row in vol_rows:
            mean_price = row.get("mean_price") or 0
            mean_sq = row.get("mean_sq") or 0
            if mean_price <= 0:
                continue
            variance = max(0.0, float(mean_sq) - float(mean_price) ** 2)
            stddev = math.sqrt(variance)
            cv = stddev / float(mean_price)
            vol_scores[(row["source"], row["item_id"])] = cv

        for product in latest_products:
            source = product.get("source")
            item_id = product.get("item_id")
            if not source or not item_id:
                continue
            cv = vol_scores.get((source, item_id))
            if cv is None:
                continue
            volatility_items.append(
                {
                    "name": product.get("name"),
                    "source": source,
                    "item_id": item_id,
                    "price": product.get("price"),
                    "currency": product.get("currency"),
                    "cv": cv,
                    "canonical_id": product.get("canonical_id"),
                }
            )
        volatility_items.sort(key=lambda x: x["cv"], reverse=True)
        volatility_items = volatility_items[:8]

        # Last 4 prices for sustained trends and dormancy gaps
        ranked_prices: list[dict] = []
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                """
                WITH latest_scrapes AS (
                    SELECT source, MAX(scraped_at) as latest_at
                    FROM products
                    GROUP BY source
                ),
                latest_items AS (
                    SELECT p.source, p.item_id
                    FROM products p
                    JOIN latest_scrapes ls
                        ON p.source = ls.source AND p.scraped_at = ls.latest_at
                    WHERE p.item_id IS NOT NULL
                ),
                ranked AS (
                    SELECT p.source, p.item_id, p.price, p.scraped_at,
                           ROW_NUMBER() OVER (
                               PARTITION BY p.source, p.item_id
                               ORDER BY p.scraped_at DESC
                           ) as rn
                    FROM products p
                    JOIN latest_items li
                        ON p.source = li.source AND p.item_id = li.item_id
                    WHERE p.price IS NOT NULL
                )
                SELECT * FROM ranked
                WHERE rn <= 4
                ORDER BY source, item_id, rn
                """
            )
            ranked_prices = [dict(r) for r in cursor.fetchall()]

        prices_by_item: dict[tuple[str, str], list[dict]] = defaultdict(list)
        for row in ranked_prices:
            prices_by_item[(row["source"], row["item_id"])].append(row)

        for (source, item_id), rows in prices_by_item.items():
            rows.sort(key=lambda r: r["rn"])  # rn=1 latest
            if len(rows) < 4:
                continue
            series_latest_first = [float(r["price"]) for r in rows]
            series_oldest_first = list(reversed(series_latest_first))
            oldest, latest = series_oldest_first[0], series_oldest_first[-1]
            if oldest <= 0:
                continue
            deltas_pct = []
            monotone_down = True
            monotone_up = True
            for i in range(1, len(series_oldest_first)):
                prev_p = series_oldest_first[i - 1]
                cur_p = series_oldest_first[i]
                if prev_p <= 0:
                    monotone_down = monotone_up = False
                    break
                step_pct = ((cur_p - prev_p) / prev_p) * 100
                deltas_pct.append(step_pct)
                if step_pct > -1.0:
                    monotone_down = False
                if step_pct < 1.0:
                    monotone_up = False
            trend_pct = ((latest - oldest) / oldest) * 100

            base_info = latest_by_pair.get((source, item_id), {})
            trend_entry = {
                "name": base_info.get("name"),
                "source": source,
                "item_id": item_id,
                "price": base_info.get("price"),
                "currency": base_info.get("currency"),
                "url": base_info.get("url"),
                "canonical_id": base_info.get("canonical_id"),
                "trend_pct": trend_pct,
                "prices": series_oldest_first,
            }

            if monotone_down:
                sustained_drops.append(trend_entry)
            if monotone_up:
                sustained_rises.append(trend_entry)

            latest_at = self._parse_timestamp(rows[0]["scraped_at"])
            prev_at = self._parse_timestamp(rows[1]["scraped_at"]) if len(rows) > 1 else None
            if latest_at and prev_at:
                gap_days = (latest_at - prev_at).days
                if gap_days >= dormant_days:
                    dormant_revived.append(
                        {
                            **trend_entry,
                            "gap_days": gap_days,
                            "prev_seen": rows[1]["scraped_at"],
                            "latest_seen": rows[0]["scraped_at"],
                        }
                    )

        sustained_drops.sort(key=lambda x: x["trend_pct"])
        sustained_rises.sort(key=lambda x: x["trend_pct"], reverse=True)
        sustained_drops = sustained_drops[:6]
        sustained_rises = sustained_rises[:6]
        dormant_revived.sort(key=lambda x: x["gap_days"], reverse=True)
        dormant_revived = dormant_revived[:6]

        # First-seen based new arrivals
        new_arrivals: list[dict] = []
        for product in latest_products:
            source = product.get("source")
            item_id = product.get("item_id")
            if not source or not item_id:
                continue
            first_seen_raw = item_stats.get((source, item_id), {}).get("first_seen")
            first_seen_dt = self._parse_timestamp(first_seen_raw)
            if first_seen_dt and (now - first_seen_dt) <= recent_window:
                new_arrivals.append(
                    {
                        "name": product.get("name"),
                        "source": source,
                        "price": product.get("price"),
                        "currency": product.get("currency"),
                        "item_id": item_id,
                        "scraped_at": product.get("scraped_at"),
                        "url": product.get("url"),
                        "canonical_id": product.get("canonical_id"),
                        "first_seen": first_seen_raw,
                        "age_hours": round((now - first_seen_dt).total_seconds() / 3600, 1),
                    }
                )
        new_arrivals.sort(key=lambda x: x.get("first_seen") or "", reverse=True)
        new_arrivals = new_arrivals[:8]

        # Canonical-level signals
        canonicals = self.get_all_canonical_products()
        canonical_names = {c["id"]: c["name"] for c in canonicals}
        products_by_canonical: dict[int, list[dict]] = defaultdict(list)
        for product in latest_products:
            cid = product.get("canonical_id")
            if cid:
                products_by_canonical[int(cid)].append(product)

        canonical_moves: list[dict] = []
        dispersion_candidates: list[dict] = []
        outlier_items: list[dict] = []
        returned_items: list[dict] = []
        for cid, items in products_by_canonical.items():
            current_prices = [float(i["price"]) for i in items if i.get("price") is not None]
            prev_prices = [float(i["prev_price"]) for i in items if i.get("prev_price") is not None]
            median_current = _median(current_prices)
            median_prev = _median(prev_prices)
            if median_current is not None and len(current_prices) >= 2 and median_current > 0:
                spread_pct = ((max(current_prices) - min(current_prices)) / median_current) * 100
                dispersion_candidates.append(
                    {
                        "canonical_id": cid,
                        "name": canonical_names.get(cid, f"Canonical {cid}"),
                        "median_price": median_current,
                        "min_price": min(current_prices),
                        "max_price": max(current_prices),
                        "spread_pct": spread_pct,
                        "count": len(current_prices),
                    }
                )
                for item in items:
                    if item.get("price") is None:
                        continue
                    deviation_pct = ((float(item["price"]) - median_current) / median_current) * 100
                    if abs(deviation_pct) >= outlier_threshold_pct and len(current_prices) >= 3:
                        outlier_items.append(
                            {
                                "canonical_id": cid,
                                "canonical_name": canonical_names.get(cid, f"Canonical {cid}"),
                                "name": item.get("name"),
                                "source": item.get("source"),
                                "item_id": item.get("item_id"),
                                "price": item.get("price"),
                                "currency": item.get("currency"),
                                "deviation_pct": deviation_pct,
                                "median_price": median_current,
                                "url": item.get("url"),
                            }
                        )

            if median_current is not None and median_prev is not None and median_prev > 0:
                pct_change = ((median_current - median_prev) / median_prev) * 100
                canonical_moves.append(
                    {
                        "canonical_id": cid,
                        "name": canonical_names.get(cid, f"Canonical {cid}"),
                        "median_price": median_current,
                        "prev_median_price": median_prev,
                        "pct_change": pct_change,
                        "count": len(items),
                    }
                )

                # Returned-to-normal items
                if median_current > 0 and median_prev > 0:
                    for item in items:
                        price_now = item.get("price")
                        price_prev = item.get("prev_price")
                        if price_now is None or price_prev is None:
                            continue
                        dev_prev = ((float(price_prev) - median_prev) / median_prev) * 100
                        dev_now = ((float(price_now) - median_current) / median_current) * 100
                        if abs(dev_prev) >= outlier_threshold_pct and abs(dev_now) < outlier_threshold_pct * 0.6:
                            returned_items.append(
                                {
                                    "canonical_id": cid,
                                    "canonical_name": canonical_names.get(cid, f"Canonical {cid}"),
                                    "name": item.get("name"),
                                    "source": item.get("source"),
                                    "item_id": item.get("item_id"),
                                    "price": price_now,
                                    "prev_price": price_prev,
                                    "currency": item.get("currency"),
                                    "dev_prev": dev_prev,
                                    "dev_now": dev_now,
                                    "url": item.get("url"),
                                }
                            )

        canonical_moves.sort(key=lambda x: x["pct_change"])
        canonical_drops = canonical_moves[:5]
        canonical_spikes = list(reversed(canonical_moves))[:5]

        dispersion_candidates.sort(key=lambda x: x["spread_pct"], reverse=True)
        dispersion_leaders = dispersion_candidates[:6]

        outlier_items.sort(key=lambda x: abs(x["deviation_pct"]), reverse=True)
        outliers = outlier_items[:8]

        returned_items.sort(key=lambda x: abs(x["dev_prev"]), reverse=True)
        returned_to_normal = returned_items[:6]

        coverage = self.get_source_coverage_snapshot(limit=8)
        canonical_gaps = self.get_canonical_coverage_gaps(limit=8)

        stale_sources: list[dict] = []
        stale_cutoff = now - timedelta(hours=12)
        for source, ts in last_scrapes.items():
            parsed = self._parse_timestamp(ts)
            if parsed and parsed < stale_cutoff:
                stale_sources.append(
                    {
                        "source": source,
                        "last_scraped": ts,
                        "age_hours": round((now - parsed).total_seconds() / 3600, 1),
                    }
                )
        stale_sources.sort(key=lambda x: x["age_hours"], reverse=True)

        failures = self.get_recent_scrape_failures(hours=36, limit=10)

        summary = {
            "price_drops": drop_count,
            "price_rises": rise_count,
            "new_extremes": new_lows_count + new_highs_count,
            "outliers": len(outlier_items),
            "stale_sources": len(stale_sources),
            "unlinked_products": stats.get("unlinked_products", 0),
            "canonical_gaps": len(canonical_gaps),
            "recent_failures": len(failures),
            "missing_prices": missing_price_count,
        }

        return {
            "summary": summary,
            "price_drops": price_drops,
            "price_rises": price_rises,
            "multi_horizon": multi_horizon,
            "new_lows": new_lows,
            "new_highs": new_highs,
            "volatility_items": volatility_items,
            "sustained_drops": sustained_drops,
            "sustained_rises": sustained_rises,
            "canonical_drops": canonical_drops,
            "canonical_spikes": canonical_spikes,
            "dispersion_leaders": dispersion_leaders,
            "outliers": outliers,
            "returned_to_normal": returned_to_normal,
            "new_arrivals": new_arrivals,
            "dormant_revived": dormant_revived,
            "missing_prices": missing_prices,
            "coverage": coverage,
            "canonical_gaps": canonical_gaps,
            "stale_sources": stale_sources,
            "recent_failures": failures,
            "sources_seen": sorted(last_scrapes.keys()),
            "last_scrape_times": last_scrapes,
        }

    def reset_all(self) -> dict:
        """Clear all database tables and return counts of deleted records."""
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("PRAGMA foreign_keys = ON")

            # Get counts before deletion
            counts = {
                "products": conn.execute("SELECT COUNT(*) FROM products").fetchone()[0],
                "canonical_products": conn.execute("SELECT COUNT(*) FROM canonical_products").fetchone()[0],
                "product_links": conn.execute("SELECT COUNT(*) FROM product_links").fetchone()[0],
                "product_images": conn.execute("SELECT COUNT(*) FROM product_images").fetchone()[0],
            }

            # Delete all data (product_links will cascade from canonical_products)
            conn.execute("DELETE FROM product_links")
            conn.execute("DELETE FROM canonical_products")
            conn.execute("DELETE FROM products")
            conn.execute("DELETE FROM product_images")

            # Also clear scraper schedules if table exists
            try:
                schedule_count = conn.execute("SELECT COUNT(*) FROM scraper_schedules").fetchone()[0]
                conn.execute("DELETE FROM scraper_schedules")
                counts["scraper_schedules"] = schedule_count
            except sqlite3.OperationalError:
                pass  # Table doesn't exist yet

            # Also clear scrape runs if table exists
            try:
                runs_count = conn.execute("SELECT COUNT(*) FROM scrape_runs").fetchone()[0]
                conn.execute("DELETE FROM scrape_runs")
                counts["scrape_runs"] = runs_count
            except sqlite3.OperationalError:
                pass  # Table doesn't exist yet

            # Also clear job queue if table exists
            try:
                queue_count = conn.execute("SELECT COUNT(*) FROM job_queue").fetchone()[0]
                conn.execute("DELETE FROM job_queue")
                counts["job_queue"] = queue_count
            except sqlite3.OperationalError:
                pass  # Table doesn't exist yet

            conn.commit()

    def _build_product_key(self, product: Product) -> str:
        """Return a stable key for identifying a product across scrapes."""
        for value in (product.item_id, product.url, product.name):
            if value:
                cleaned = str(value).strip()
                if cleaned.lower() in {"", "none", "null"}:
                    continue
                return cleaned
        return ""

    def _process_image(self, image_bytes: bytes, mime_type: str | None) -> tuple[bytes, str]:
        """Resize and convert product images to WebP before storage."""
        try:
            with Image.open(BytesIO(image_bytes)) as img:
                resample = Image.Resampling.LANCZOS if hasattr(Image, "Resampling") else Image.LANCZOS
                # Preserve transparency when present
                if "A" in img.getbands():
                    img = img.convert("RGBA")
                else:
                    img = img.convert("RGB")
                img.thumbnail((512, 512), resample=resample)

                buffer = BytesIO()
                img.save(buffer, format="WEBP", quality=80, method=6)
                return buffer.getvalue(), "image/webp"
        except Exception as exc:
            # Fall back to the original bytes if processing fails
            print(f"[db] Failed to process image, storing original: {exc}")
            return image_bytes, mime_type or "image/jpeg"

    def _upsert_product_image(self, conn: sqlite3.Connection, source: str, product: Product, product_key: str) -> None:
        """Store or update the latest image for a product if provided."""
        if not product.image or not product_key:
            return

        # Normalize to bytes for hashing/storage
        if isinstance(product.image, str):
            image_bytes = product.image.encode("utf-8")
        elif isinstance(product.image, memoryview):
            image_bytes = product.image.tobytes()
        else:
            image_bytes = bytes(product.image)
        mime_type = product.image_mime or "image/jpeg"

        # Convert and downsize before hashing/storing
        image_bytes, mime_type = self._process_image(image_bytes, mime_type)
        image_hash = hashlib.sha256(image_bytes).hexdigest()
        now = datetime.utcnow().isoformat()

        existing = conn.execute(
            "SELECT image_hash FROM product_images WHERE source = ? AND product_key = ?",
            (source, product_key),
        ).fetchone()

        if existing:
            existing_hash = existing[0]
            if existing_hash != image_hash:
                conn.execute(
                    """
                    UPDATE product_images
                    SET image_data = ?, image_hash = ?, image_mime = ?, item_id = ?, url = ?, updated_at = ?
                    WHERE source = ? AND product_key = ?
                    """,
                    (image_bytes, image_hash, mime_type, product.item_id, product.url, now, source, product_key),
                )
            else:
                # Keep metadata fresh even if the image itself is unchanged
                conn.execute(
                    """
                    UPDATE product_images
                    SET image_mime = ?, item_id = ?, url = ?, updated_at = ?
                    WHERE source = ? AND product_key = ?
                    """,
                    (mime_type, product.item_id, product.url, now, source, product_key),
                )
        else:
            conn.execute(
                """
                INSERT INTO product_images (source, product_key, item_id, url, image_data, image_hash, image_mime, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (source, product_key, product.item_id, product.url, image_bytes, image_hash, mime_type, now, now),
            )

        return None

    # --- Scraper Schedules ---

    def get_schedule(self, scraper_name: str) -> dict | None:
        """Get schedule configuration for a scraper."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                "SELECT * FROM scraper_schedules WHERE scraper_name = ?",
                (scraper_name,),
            )
            row = cursor.fetchone()
            return dict(row) if row else None

    def get_all_schedules(self) -> list[dict]:
        """Get all scraper schedules."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                "SELECT * FROM scraper_schedules ORDER BY scraper_name"
            )
            return [dict(row) for row in cursor.fetchall()]

    def upsert_schedule(
        self,
        scraper_name: str,
        enabled: bool,
        interval_minutes: int,
    ) -> int:
        """Create or update a scraper schedule. Returns the schedule ID."""
        now = datetime.utcnow().isoformat()

        with sqlite3.connect(self.db_path) as conn:
            # Check if exists
            existing = conn.execute(
                "SELECT id FROM scraper_schedules WHERE scraper_name = ?",
                (scraper_name,),
            ).fetchone()

            if existing:
                # Update
                conn.execute(
                    """
                    UPDATE scraper_schedules
                    SET enabled = ?, interval_minutes = ?, updated_at = ?
                    WHERE scraper_name = ?
                    """,
                    (enabled, interval_minutes, now, scraper_name),
                )
                conn.commit()
                return existing[0]
            else:
                # Insert
                cursor = conn.execute(
                    """
                    INSERT INTO scraper_schedules
                    (scraper_name, enabled, interval_minutes, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (scraper_name, enabled, interval_minutes, now, now),
                )
                conn.commit()
                return cursor.lastrowid

    def update_schedule_last_run(self, scraper_name: str, last_run: str, next_run: str):
        """Update the last_run and next_run timestamps for a schedule."""
        now = datetime.utcnow().isoformat()
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                UPDATE scraper_schedules
                SET last_run = ?, next_run = ?, updated_at = ?
                WHERE scraper_name = ?
                """,
                (last_run, next_run, now, scraper_name),
            )
            conn.commit()

    def get_enabled_schedules(self) -> list[dict]:
        """Get all enabled scraper schedules."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                "SELECT * FROM scraper_schedules WHERE enabled = 1 ORDER BY scraper_name"
            )
            return [dict(row) for row in cursor.fetchall()]

    def get_due_schedules(self) -> list[dict]:
        """Get schedules that are due to run (next_run <= now or next_run is NULL)."""
        now = datetime.utcnow().isoformat()
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                """
                SELECT * FROM scraper_schedules
                WHERE enabled = 1 AND (next_run IS NULL OR next_run <= ?)
                ORDER BY scraper_name
                """,
                (now,),
            )
            return [dict(row) for row in cursor.fetchall()]

    def get_latest_products_with_price_change(self, include_images: bool = True) -> list[dict]:
        """Get latest products with price change info from previous scrape.

        include_images=False avoids loading large blobs when only hashes are needed.
        """
        image_select = (
            ", pi.image_data, pi.image_mime, pi.image_hash, pi.updated_at as image_updated_at"
            if include_images
            else ", pi.image_hash, pi.image_mime, pi.updated_at as image_updated_at"
        )
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                """
                WITH latest_scrapes AS (
                    SELECT source, MAX(scraped_at) as latest_at
                    FROM products
                    GROUP BY source
                ),
                previous_scrapes AS (
                    SELECT p.source, MAX(p.scraped_at) as prev_at
                    FROM products p
                    JOIN latest_scrapes ls ON p.source = ls.source
                    WHERE p.scraped_at < ls.latest_at
                    GROUP BY p.source
                ),
                current_products AS (
                    SELECT p.*, pl.canonical_id
                    FROM products p
                    JOIN latest_scrapes ls ON p.source = ls.source AND p.scraped_at = ls.latest_at
                    LEFT JOIN product_links pl ON p.source = pl.source AND p.item_id = pl.source_item_id
                ),
                previous_products AS (
                    SELECT p.source, p.item_id, p.price as prev_price
                    FROM products p
                    JOIN previous_scrapes ps ON p.source = ps.source AND p.scraped_at = ps.prev_at
                )
                SELECT cp.*, pp.prev_price,
                       CASE WHEN pp.prev_price IS NOT NULL AND cp.price IS NOT NULL
                            THEN cp.price - pp.prev_price
                            ELSE NULL END as price_change,
                       CASE WHEN pp.prev_price IS NOT NULL AND pp.prev_price > 0 AND cp.price IS NOT NULL
                            THEN ((cp.price - pp.prev_price) / pp.prev_price) * 100
                            ELSE NULL END as price_change_pct
                       {image_select}
                FROM current_products cp
                LEFT JOIN previous_products pp ON cp.source = pp.source AND cp.item_id = pp.item_id
                LEFT JOIN product_images pi
                    ON pi.source = cp.source
                    AND pi.product_key = COALESCE(cp.product_key, cp.item_id, cp.url, cp.name)
                ORDER BY cp.source, cp.name
                """.format(image_select=image_select)
            )
            return [dict(row) for row in cursor.fetchall()]

    def get_last_scrape_times(self) -> dict:
        """Get the last scrape timestamp for each source."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                """
                SELECT source, MAX(scraped_at) as last_scraped
                FROM products
                GROUP BY source
                ORDER BY source
                """
            )
            return {row["source"]: row["last_scraped"] for row in cursor.fetchall()}

    # --- Scrape Runs ---

    def create_scrape_run(self, scraper_name: str, started_at: str) -> int:
        """Create a new scrape run record and return its ID."""
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute(
                """
                INSERT INTO scrape_runs (scraper_name, status, started_at)
                VALUES (?, 'running', ?)
                """,
                (scraper_name, started_at),
            )
            conn.commit()
            return cursor.lastrowid

    def complete_scrape_run(
        self,
        run_id: int,
        status: str,
        completed_at: str,
        products_found: int | None = None,
        error_message: str | None = None,
        duration_seconds: float | None = None,
    ):
        """Update a scrape run with completion details."""
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                UPDATE scrape_runs
                SET status = ?, completed_at = ?, products_found = ?,
                    error_message = ?, duration_seconds = ?
                WHERE id = ?
                """,
                (status, completed_at, products_found, error_message, duration_seconds, run_id),
            )
            conn.commit()

    def get_scrape_runs(
        self,
        scraper_name: str | None = None,
        limit: int = 100,
        status: str | None = None,
    ) -> list[dict]:
        """Get scrape run history, optionally filtered by scraper name and status."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            query = "SELECT * FROM scrape_runs WHERE 1=1"
            params = []

            if scraper_name:
                query += " AND scraper_name = ?"
                params.append(scraper_name)

            if status:
                query += " AND status = ?"
                params.append(status)

            query += " ORDER BY started_at DESC LIMIT ?"
            params.append(limit)

            cursor = conn.execute(query, params)
            return [dict(row) for row in cursor.fetchall()]

    def get_scrape_run(self, run_id: int) -> dict | None:
        """Get a specific scrape run by ID."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                "SELECT * FROM scrape_runs WHERE id = ?",
                (run_id,),
            )
            row = cursor.fetchone()
            return dict(row) if row else None

    def get_scrape_run_stats(self) -> dict:
        """Get statistics about scrape runs."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row

            # Total runs
            total = conn.execute("SELECT COUNT(*) FROM scrape_runs").fetchone()[0]

            # Successful runs
            successful = conn.execute(
                "SELECT COUNT(*) FROM scrape_runs WHERE status = 'completed'"
            ).fetchone()[0]

            # Failed runs
            failed = conn.execute(
                "SELECT COUNT(*) FROM scrape_runs WHERE status = 'failed'"
            ).fetchone()[0]

            # Running
            running = conn.execute(
                "SELECT COUNT(*) FROM scrape_runs WHERE status = 'running'"
            ).fetchone()[0]

            # Recent failures (last 24h)
            recent_failures = conn.execute(
                """
                SELECT COUNT(*) FROM scrape_runs
                WHERE status = 'failed'
                AND started_at >= datetime('now', '-24 hours')
                """
            ).fetchone()[0]

            return {
                "total": total,
                "successful": successful,
                "failed": failed,
                "running": running,
                "recent_failures": recent_failures,
                "success_rate": (successful / total * 100) if total > 0 else 0,
            }
