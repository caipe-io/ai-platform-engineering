"""Compatibility boundary for LangGraph's MongoDB checkpoint saver."""

from collections.abc import Sequence
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.mongodb.saver import MongoDBSaver as UpstreamMongoDBSaver


class MongoDBSaver(UpstreamMongoDBSaver):
    """Treat empty pending-write batches as a no-op, retaining upstream storage.

    Compiled local subgraphs can finish a checkpoint step with no pending
    writes. The pinned upstream saver submits bulk_write([]), which PyMongo
    rejects before contacting MongoDB. This also covers inherited aput_writes,
    which dispatches through self.put_writes in its executor.
    """

    def put_writes(
        self,
        config: RunnableConfig,
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        task_path: str = "",
    ) -> None:
        if not writes:
            return
        super().put_writes(config, writes, task_id, task_path)
