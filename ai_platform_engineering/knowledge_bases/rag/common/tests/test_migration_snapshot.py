from __future__ import annotations

import asyncio
import stat
from unittest.mock import AsyncMock

from common.migrations.redis_to_mongo import snapshot_redis, write_snapshot


def test_expiration_during_snapshot_cannot_resurrect_record():
  class Redis:
    type = AsyncMock(return_value="string")
    get = AsyncMock(return_value=None)
    pexpiretime = AsyncMock(return_value=-2)

    async def scan_iter(self, match):
      if match == "rag/*":
        yield "rag/ingestor:primary"

  assert asyncio.run(snapshot_redis(Redis())) == []


def test_snapshot_is_private_on_creation_and_atomic_replacement(tmp_path):
  target = tmp_path / "snapshot.json"
  write_snapshot(target, [{"key": "example", "value": "first"}])
  assert stat.S_IMODE(target.stat().st_mode) == 0o600
  write_snapshot(target, [{"key": "example", "value": "second"}])
  assert stat.S_IMODE(target.stat().st_mode) == 0o600
  assert "second" in target.read_text()
