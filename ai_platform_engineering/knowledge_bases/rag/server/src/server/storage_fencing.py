"""Validate worker ownership immediately before external storage mutations."""
from __future__ import annotations

from typing import Any

from langchain_milvus import Milvus

from common.mongo_storage import CURRENT_CLAIM, MongoStorage


async def assert_current_claim(storage: MongoStorage) -> None:
  claim = CURRENT_CLAIM.get()
  if claim:
    await storage.assert_claim(claim["_id"], claim["token"])


class ClaimCheckedClient:
  """Guard mutation calls after the vector wrapper finishes embedding work."""

  def __init__(self, client: Any, storage: MongoStorage) -> None:
    self.client = client
    self.storage = storage

  def __getattr__(self, name: str) -> Any:
    return getattr(self.client, name)

  async def upsert(self, *args: Any, **kwargs: Any) -> Any:
    await assert_current_claim(self.storage)
    return await self.client.upsert(*args, **kwargs)

  async def insert(self, *args: Any, **kwargs: Any) -> Any:
    await assert_current_claim(self.storage)
    return await self.client.insert(*args, **kwargs)


  async def delete(self, *args: Any, **kwargs: Any) -> Any:
    await assert_current_claim(self.storage)
    return await self.client.delete(*args, **kwargs)


class ClaimCheckedMilvus(Milvus):
  """Keep batch upserts fenced even when embedding calls outlast a lease."""

  def __init__(self, *args: Any, storage: MongoStorage, **kwargs: Any) -> None:
    self.rag_storage = storage
    super().__init__(*args, **kwargs)

  @property
  def aclient(self) -> ClaimCheckedClient:
    return ClaimCheckedClient(super().aclient, self.rag_storage)
