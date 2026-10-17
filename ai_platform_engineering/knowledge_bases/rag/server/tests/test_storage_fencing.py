from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from common.mongo_storage import CURRENT_CLAIM
from server.storage_fencing import ClaimCheckedClient


def test_vector_batch_checks_lease_after_embedding_and_before_mutation():
  async def scenario():
    storage = AsyncMock(assert_claim=AsyncMock(return_value=None))
    backend = AsyncMock()
    client = ClaimCheckedClient(backend, storage)
    marker = CURRENT_CLAIM.set({"_id": "primary", "token": "first"})
    try:
      # The embedding provider can outlast the lease before the vector wrapper
      # invokes its client. No network mutation is allowed after that expiry.
      storage.assert_claim.side_effect = RuntimeError("lease expired")
      for method in (client.upsert, client.insert, client.delete):
        with pytest.raises(RuntimeError, match="lease expired"):
          await method("example", [{"id": "primary"}])
      backend.upsert.assert_not_awaited()
      backend.insert.assert_not_awaited()
      backend.delete.assert_not_awaited()
      storage.assert_claim.side_effect = None
      await client.upsert("example", [{"id": "primary"}])
      backend.upsert.assert_awaited_once()
    finally:
      CURRENT_CLAIM.reset(marker)
  asyncio.run(scenario())
