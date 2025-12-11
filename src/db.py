"""SQLite database operations for storing scrape results."""

from __future__ import annotations

import sqlite3
import hashlib
from io import BytesIO
from datetime import datetime
from pathlib import Path

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
                SELECT p.*, pi.image_data, pi.image_mime, pi.updated_at as image_updated_at
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
                       pi.image_data, pi.image_mime, pi.updated_at as image_updated_at
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
                       pi.image_data, pi.image_mime, pi.updated_at as image_updated_at
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

    def get_unlinked_products(self) -> list[dict]:
        """Get latest products that are not linked to any canonical product."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                """
                SELECT p.*, pi.image_data, pi.image_mime, pi.updated_at as image_updated_at
                FROM products p
                LEFT JOIN product_links pl ON p.source = pl.source AND p.item_id = pl.source_item_id
                LEFT JOIN product_images pi
                    ON pi.source = p.source
                    AND pi.product_key = COALESCE(p.product_key, p.item_id, p.url, p.name)
                WHERE pl.id IS NULL
                AND p.scraped_at = (
                    SELECT MAX(p2.scraped_at) FROM products p2 WHERE p2.source = p.source
                )
                ORDER BY p.source, p.name
                """
            )
            return [dict(row) for row in cursor.fetchall()]

    def get_linked_products(self) -> list[dict]:
        """Get latest products that are linked to a canonical product."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                """
                SELECT p.*, pl.canonical_id, cp.name as canonical_name,
                       pi.image_data, pi.image_mime, pi.updated_at as image_updated_at
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

    def get_latest_products_with_price_change(self) -> list[dict]:
        """Get latest products with price change info from previous scrape."""
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
                            ELSE NULL END as price_change_pct,
                       pi.image_data, pi.image_mime, pi.updated_at as image_updated_at
                FROM current_products cp
                LEFT JOIN previous_products pp ON cp.source = pp.source AND cp.item_id = pp.item_id
                LEFT JOIN product_images pi
                    ON pi.source = cp.source
                    AND pi.product_key = COALESCE(cp.product_key, cp.item_id, cp.url, cp.name)
                ORDER BY cp.source, cp.name
                """
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
