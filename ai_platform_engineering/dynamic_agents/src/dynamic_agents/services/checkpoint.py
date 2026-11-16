"""MongoDB checkpoint compatibility for delegated LangGraph executions."""

from collections.abc import Sequence
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.mongodb.saver import MongoDBSaver


class MongoDBCheckpointSaver(MongoDBSaver):
    """Accept empty intermediate-write batches emitted by child graphs.

    The pinned MongoDB saver forwards an empty batch to PyMongo's bulk_write,
    which raises InvalidOperation after an otherwise successful delegation.
    Inherited aput_writes dispatches through this override as well.
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
