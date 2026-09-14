from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from common.graph_db.neo4j.graph_db import Neo4jDB


def test_close_closes_async_and_sync_drivers() -> None:
  async_driver = SimpleNamespace(close=AsyncMock())
  sync_driver = SimpleNamespace(close=Mock())
  db = Neo4jDB.__new__(Neo4jDB)
  db.driver = async_driver
  db.non_async_driver = sync_driver

  asyncio.run(db.close())

  async_driver.close.assert_awaited_once_with()
  sync_driver.close.assert_called_once_with()


def test_close_still_closes_sync_driver_when_async_close_fails() -> None:
  async_driver = SimpleNamespace(close=AsyncMock(side_effect=RuntimeError("async driver failure")))
  sync_driver = SimpleNamespace(close=Mock())
  db = Neo4jDB.__new__(Neo4jDB)
  db.driver = async_driver
  db.non_async_driver = sync_driver

  with pytest.raises(RuntimeError, match="async driver failure"):
    asyncio.run(db.close())

  sync_driver.close.assert_called_once_with()
