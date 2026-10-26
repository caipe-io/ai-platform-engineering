from __future__ import annotations

import asyncio
from types import SimpleNamespace

from common.mongo_storage import CURRENT_CLAIM
from ingestors.webloader.loader.worker_pool import PendingJob, ScrapyWorkerPool


def test_worker_result_callback_uses_submission_claim_context():
  async def scenario():
    pool = ScrapyWorkerPool(max_workers=1)
    pool._running = True
    seen = []

    async def documents(_batch):
      seen.append(CURRENT_CLAIM.get())
      return True

    expected = {"_id": "primary", "token": "example-token"}
    marker = CURRENT_CLAIM.set(expected)
    pool.pending_jobs["primary"] = PendingJob(request=SimpleNamespace(), future=asyncio.get_running_loop().create_future(), worker_id=0, on_documents=documents)
    CURRENT_CLAIM.reset(marker)

    def result(_timeout):
      pool._running = False
      return {"type": "crawl_documents", "payload": {"job_id": "primary", "documents": [], "batch_number": 1, "is_final_batch": True}}

    pool._get_message_timeout = result
    await pool._process_results()
    assert seen == [expected]
    assert CURRENT_CLAIM.get() is None
  asyncio.run(scenario())
