import tempfile
import unittest
from io import BytesIO
from pathlib import Path

from PIL import Image

from src.db import ProductDatabase
from src.job_queue import JobQueue
from src.worker import Worker


class TestSport2000LiveViaWorker(unittest.IsolatedAsyncioTestCase):
    async def test_sport2000_live_worker_run_saves_products_and_images(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            db = ProductDatabase(db_path=Path(td) / "products.db")
            queue = JobQueue(db)

            job_id = queue.enqueue("sport2000", source="test")
            job = queue.claim_next("test-worker")
            self.assertIsNotNone(job)

            worker = Worker(db, max_concurrent_jobs=1)
            await worker._execute_job(job)  # same execution path as web UI/worker

            completed = queue.get_job(job_id)
            self.assertIsNotNone(completed)
            self.assertEqual(completed["status"], "completed")

            products = db.get_latest_scrape("sport2000")
            self.assertGreater(len(products), 0, "expected at least one product from live Sport2000 page")

            enriched = db.get_unlinked_products(include_images=True, source="sport2000")
            self.assertGreater(len(enriched), 0)
            self.assertTrue(
                any(p.get("image_data") for p in enriched),
                "expected at least one product image to be saved",
            )

            sample = next((p for p in enriched if p.get("image_data")), None)
            self.assertIsNotNone(sample)
            self.assertTrue(sample.get("url") and sample["url"].startswith("https://www.sport2000.de/"))
            self.assertTrue(sample.get("image_mime") and sample["image_mime"].startswith("image/"))

            image_data = sample["image_data"]
            img = Image.open(BytesIO(image_data))
            img.load()
            self.assertGreater(img.width, 30)
            self.assertGreater(img.height, 30)

