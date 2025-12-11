"""SQLite database operations for storing scrape results."""

from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path

from .models import ScrapeResult


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
                    item_id TEXT
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

            conn.commit()

    def save_results(self, result: ScrapeResult):
        """Save scrape results to the database (append mode for history)."""
        scraped_at = result.scraped_at.isoformat()

        with sqlite3.connect(self.db_path) as conn:
            for product in result.products:
                conn.execute(
                    """
                    INSERT INTO products (source, scraped_at, name, price, currency, url, item_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        result.source,
                        scraped_at,
                        product.name,
                        product.price,
                        product.currency,
                        product.url,
                        product.item_id,
                    ),
                )
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
                SELECT *
                FROM products
                WHERE source = ? AND item_id = ?
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
                SELECT pl.*, p.name, p.price, p.currency, p.url
                FROM product_links pl
                LEFT JOIN (
                    SELECT source, item_id, name, price, currency, url,
                           ROW_NUMBER() OVER (PARTITION BY source, item_id ORDER BY scraped_at DESC) as rn
                    FROM products
                ) p ON pl.source = p.source
                    AND (
                        pl.source_item_id = p.item_id
                        OR (pl.source_item_id IN ('', 'None') AND p.item_id IS NULL)
                    )
                    AND p.rn = 1
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
                SELECT p.*, pl.canonical_id
                FROM products p
                LEFT JOIN product_links pl ON p.source = pl.source AND p.item_id = pl.source_item_id
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
                SELECT p.*
                FROM products p
                LEFT JOIN product_links pl ON p.source = pl.source AND p.item_id = pl.source_item_id
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
                SELECT p.*, pl.canonical_id, cp.name as canonical_name
                FROM products p
                JOIN product_links pl ON p.source = pl.source AND p.item_id = pl.source_item_id
                JOIN canonical_products cp ON pl.canonical_id = cp.id
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
