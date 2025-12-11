"""SQLite-backed job queue for scraper jobs."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, UTC
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .db import ProductDatabase

# Stale job timeout - jobs running longer than this are considered abandoned
STALE_JOB_TIMEOUT_MINUTES = 30


class JobQueue:
    """SQLite-backed job queue with atomic claim operations."""

    def __init__(self, db: ProductDatabase):
        self.db = db
        self.db_path = db.db_path

    def enqueue(
        self,
        scraper_name: str,
        priority: int = 0,
        source: str = "manual",
    ) -> int:
        """
        Add a job to the queue.

        Args:
            scraper_name: Name of the scraper to run
            priority: Job priority (higher = more urgent)
            source: How the job was triggered (manual, scheduled, cli)

        Returns:
            Job ID
        """
        now = datetime.now(UTC).isoformat()

        with sqlite3.connect(self.db_path) as conn:
            # Create scrape_run record first (with pending status)
            cursor = conn.execute(
                """
                INSERT INTO scrape_runs (scraper_name, status, started_at)
                VALUES (?, 'pending', ?)
                """,
                (scraper_name, now),
            )
            scrape_run_id = cursor.lastrowid

            # Create job queue entry
            cursor = conn.execute(
                """
                INSERT INTO job_queue (scraper_name, status, priority, created_at, scrape_run_id)
                VALUES (?, 'pending', ?, ?, ?)
                """,
                (scraper_name, priority, now, scrape_run_id),
            )
            job_id = cursor.lastrowid
            conn.commit()

        return job_id

    def claim_next(self, worker_id: str) -> dict | None:
        """
        Atomically claim the next available job.

        Uses SQLite's row-level locking to prevent race conditions.

        Args:
            worker_id: Unique identifier for the worker claiming the job

        Returns:
            Job dict or None if no jobs available
        """
        now = datetime.now(UTC).isoformat()

        with sqlite3.connect(self.db_path, isolation_level="IMMEDIATE") as conn:
            conn.row_factory = sqlite3.Row

            # Find and claim in one atomic operation using RETURNING
            cursor = conn.execute(
                """
                UPDATE job_queue
                SET status = 'running', claimed_at = ?, worker_id = ?
                WHERE id = (
                    SELECT id FROM job_queue
                    WHERE status = 'pending'
                    ORDER BY priority DESC, created_at ASC
                    LIMIT 1
                )
                RETURNING *
                """,
                (now, worker_id),
            )
            row = cursor.fetchone()

            if row:
                # Also update scrape_runs status
                conn.execute(
                    """
                    UPDATE scrape_runs SET status = 'running', started_at = ?
                    WHERE id = ?
                    """,
                    (now, row["scrape_run_id"]),
                )
                conn.commit()
                return dict(row)

            return None

    def complete(
        self,
        job_id: int,
        success: bool,
        products_found: int | None = None,
        error_message: str | None = None,
        duration_seconds: float | None = None,
    ) -> None:
        """
        Mark a job as completed or failed.

        Args:
            job_id: ID of the job to complete
            success: Whether the job succeeded
            products_found: Number of products scraped (if successful)
            error_message: Error message (if failed)
            duration_seconds: How long the job took
        """
        now = datetime.now(UTC).isoformat()
        status = "completed" if success else "failed"

        with sqlite3.connect(self.db_path) as conn:
            # Update job_queue
            conn.execute(
                """
                UPDATE job_queue
                SET status = ?, completed_at = ?, error_message = ?
                WHERE id = ?
                """,
                (status, now, error_message, job_id),
            )

            # Get scrape_run_id
            cursor = conn.execute(
                "SELECT scrape_run_id FROM job_queue WHERE id = ?",
                (job_id,),
            )
            row = cursor.fetchone()
            if row:
                # Update scrape_runs
                conn.execute(
                    """
                    UPDATE scrape_runs
                    SET status = ?, completed_at = ?, products_found = ?,
                        error_message = ?, duration_seconds = ?
                    WHERE id = ?
                    """,
                    (status, now, products_found, error_message, duration_seconds, row[0]),
                )

            conn.commit()

    def reclaim_stale_jobs(self) -> int:
        """
        Find jobs that have been 'running' too long and reset them.

        Jobs that have been running longer than STALE_JOB_TIMEOUT_MINUTES
        are considered abandoned (worker crashed) and are reset to pending
        for retry.

        Returns:
            Number of jobs reclaimed
        """
        cutoff = (datetime.now(UTC) - timedelta(minutes=STALE_JOB_TIMEOUT_MINUTES)).isoformat()

        with sqlite3.connect(self.db_path) as conn:
            # Reset stale jobs that haven't exceeded max retries
            cursor = conn.execute(
                """
                UPDATE job_queue
                SET status = 'pending', claimed_at = NULL, worker_id = NULL,
                    retry_count = retry_count + 1
                WHERE status = 'running'
                AND claimed_at < ?
                AND retry_count < max_retries
                """,
                (cutoff,),
            )
            count = cursor.rowcount

            # Also reset corresponding scrape_runs
            conn.execute(
                """
                UPDATE scrape_runs
                SET status = 'pending'
                WHERE id IN (
                    SELECT scrape_run_id FROM job_queue
                    WHERE status = 'pending' AND retry_count > 0
                )
                """,
            )

            # Mark jobs that exceeded max retries as failed
            conn.execute(
                """
                UPDATE job_queue
                SET status = 'failed', error_message = 'Max retries exceeded (stale job)',
                    completed_at = ?
                WHERE status = 'running'
                AND claimed_at < ?
                AND retry_count >= max_retries
                """,
                (datetime.now(UTC).isoformat(), cutoff),
            )

            # Update corresponding scrape_runs for failed jobs
            conn.execute(
                """
                UPDATE scrape_runs
                SET status = 'failed', error_message = 'Max retries exceeded (stale job)',
                    completed_at = ?
                WHERE id IN (
                    SELECT scrape_run_id FROM job_queue
                    WHERE status = 'failed' AND error_message = 'Max retries exceeded (stale job)'
                )
                """,
                (datetime.now(UTC).isoformat(),),
            )

            conn.commit()
            return count

    def get_queue_status(self) -> dict:
        """
        Get current queue statistics.

        Returns:
            Dict with counts for each status
        """
        with sqlite3.connect(self.db_path) as conn:
            # Single query with GROUP BY instead of 4 separate queries
            cursor = conn.execute(
                "SELECT status, COUNT(*) FROM job_queue GROUP BY status"
            )
            stats = {"pending": 0, "running": 0, "completed": 0, "failed": 0}
            for status, count in cursor.fetchall():
                if status in stats:
                    stats[status] = count

            return stats

    def get_pending_jobs(self, scraper_name: str | None = None) -> list[dict]:
        """
        Get all pending jobs, optionally filtered by scraper.

        Args:
            scraper_name: Optional filter by scraper name

        Returns:
            List of pending job dicts
        """
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row

            if scraper_name:
                cursor = conn.execute(
                    """
                    SELECT * FROM job_queue
                    WHERE status = 'pending' AND scraper_name = ?
                    ORDER BY priority DESC, created_at ASC
                    """,
                    (scraper_name,),
                )
            else:
                cursor = conn.execute(
                    """
                    SELECT * FROM job_queue
                    WHERE status = 'pending'
                    ORDER BY priority DESC, created_at ASC
                    """
                )

            return [dict(row) for row in cursor.fetchall()]

    def is_scraper_queued_or_running(self, scraper_name: str) -> bool:
        """
        Check if a scraper already has a pending or running job.

        Args:
            scraper_name: Name of the scraper to check

        Returns:
            True if scraper has an active job
        """
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.execute(
                """
                SELECT COUNT(*) FROM job_queue
                WHERE scraper_name = ? AND status IN ('pending', 'running')
                """,
                (scraper_name,),
            )
            return cursor.fetchone()[0] > 0

    def get_active_job(self, scraper_name: str) -> dict | None:
        """
        Get the active (pending or running) job for a scraper.

        Args:
            scraper_name: Name of the scraper

        Returns:
            Job dict or None if no active job
        """
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                """
                SELECT * FROM job_queue
                WHERE scraper_name = ? AND status IN ('pending', 'running')
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (scraper_name,),
            )
            row = cursor.fetchone()
            return dict(row) if row else None

    def get_job(self, job_id: int) -> dict | None:
        """
        Get a specific job by ID.

        Args:
            job_id: ID of the job

        Returns:
            Job dict or None if not found
        """
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(
                "SELECT * FROM job_queue WHERE id = ?",
                (job_id,),
            )
            row = cursor.fetchone()
            return dict(row) if row else None
