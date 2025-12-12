import tempfile
import unittest
from pathlib import Path


class TestJobQueueConcurrencyLimit(unittest.TestCase):
    def setUp(self):
        from src.db import ProductDatabase

        self._tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self._tmp.name) / "test.db"
        self.db = ProductDatabase(db_path=self.db_path)

    def tearDown(self):
        self._tmp.cleanup()

    def test_scraper_concurrency_setting_roundtrip(self):
        self.assertEqual(self.db.get_scraper_concurrency_limit(default=7), 7)
        self.db.set_scraper_concurrency_limit(3)
        self.assertEqual(self.db.get_scraper_concurrency_limit(), 3)

    def test_claim_next_respects_global_running_cap(self):
        from src.job_queue import JobQueue

        queue = JobQueue(self.db)
        queue.enqueue("scraper_a")
        queue.enqueue("scraper_b")

        claimed_1 = queue.claim_next("worker-1", max_running_jobs=1)
        self.assertIsNotNone(claimed_1)

        claimed_2 = queue.claim_next("worker-2", max_running_jobs=1)
        self.assertIsNone(claimed_2)

        claimed_3 = queue.claim_next("worker-2", max_running_jobs=2)
        self.assertIsNotNone(claimed_3)

