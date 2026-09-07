"""GridFS-backed BaseStore for persistent file storage outside checkpoints."""

import asyncio
import json
import logging
import re
from collections.abc import Iterable
from datetime import datetime, timedelta, timezone

from gridfs import GridFS
from langgraph.store.base import (
    BaseStore,
    GetOp,
    Item,
    ListNamespacesOp,
    MatchCondition,
    Op,
    PutOp,
    Result,
    SearchItem,
    SearchOp,
)
from pymongo.database import Database
from pymongo.errors import DuplicateKeyError, OperationFailure

logger = logging.getLogger(__name__)


def _coerce_namespace(namespace: Iterable[object]) -> list[str]:
    """Coerce namespace components to plain strings before use in a Mongo query.

    Callers ultimately source namespace components from external input (e.g.
    request path/query params). Forcing each component to `str` before it
    reaches a query dict prevents NoSQL operator injection ($ne, $where, ...)
    if a component were ever an unvalidated dict instead of a string.
    """
    return [str(component) for component in namespace]


class MongoDBGridFSStore(BaseStore):
    """BaseStore implementation backed by MongoDB GridFS.

    Stores file content in GridFS (no 16MB document limit). Each file is
    identified by (namespace, key) stored in GridFS file metadata.

    Args:
        db: A pymongo Database instance.
        bucket_name: GridFS bucket/collection prefix.
        ttl_seconds: Per-document TTL in seconds. 0 means infinite (no expiry).
    """

    def __init__(
        self,
        *,
        db: Database,
        bucket_name: str = "agent_files",
        ttl_seconds: int = 0,
    ) -> None:
        self._db = db
        self._bucket_name = bucket_name
        self._ttl_seconds = ttl_seconds
        self._fs = GridFS(db, collection=bucket_name)
        self._files_collection = db[f"{bucket_name}.files"]

    def batch(self, ops: Iterable[Op]) -> list[Result]:
        results: list[Result] = []
        for op in ops:
            if isinstance(op, GetOp):
                results.append(self._handle_get(op))
            elif isinstance(op, PutOp):
                self._handle_put(op)
                results.append(None)
            elif isinstance(op, SearchOp):
                results.append(self._handle_search(op))
            elif isinstance(op, ListNamespacesOp):
                results.append(self._handle_list_namespaces(op))
            else:
                results.append(None)
        return results

    async def abatch(self, ops: Iterable[Op]) -> list[Result]:
        return await asyncio.to_thread(self.batch, ops)

    def _handle_get(self, op: GetOp) -> Item | None:
        namespace = _coerce_namespace(op.namespace)
        logger.debug(f"[gridfs] GET namespace={op.namespace} key={op.key}")
        doc = self._files_collection.find_one({"metadata.namespace": namespace, "metadata.key": op.key})
        if doc is None:
            logger.debug(f"[gridfs] GET not found: namespace={op.namespace} key={op.key}")
            return None
        grid_out = self._fs.get(doc["_id"])
        content = grid_out.read().decode("utf-8")
        value = _deserialize_value(content)
        upload_date = doc.get("uploadDate", datetime.now(timezone.utc))
        logger.debug(f"[gridfs] GET found: namespace={op.namespace} key={op.key} size={len(content)}")
        return Item(
            value=value,
            key=op.key,
            namespace=op.namespace,
            created_at=upload_date,
            updated_at=upload_date,
        )

    def _handle_put(self, op: PutOp) -> None:
        namespace = _coerce_namespace(op.namespace)
        # Delete existing file(s) with same namespace+key
        for doc in self._files_collection.find({"metadata.namespace": namespace, "metadata.key": op.key}):
            self._fs.delete(doc["_id"])

        # value=None means delete only
        if op.value is None:
            logger.debug(f"[gridfs] DELETE namespace={op.namespace} key={op.key}")
            return

        content = _serialize_value(op.value)
        metadata = {"namespace": namespace, "key": op.key}
        if self._ttl_seconds > 0:
            metadata["expireAt"] = datetime.now(timezone.utc) + timedelta(seconds=self._ttl_seconds)
        self._fs.put(
            content.encode("utf-8"),
            filename=op.key,
            metadata=metadata,
        )
        logger.debug(f"[gridfs] PUT namespace={op.namespace} key={op.key} size={len(content)}")

    def _handle_search(self, op: SearchOp) -> list[SearchItem]:
        namespace_prefix = _coerce_namespace(op.namespace_prefix)
        logger.debug(f"[gridfs] SEARCH namespace_prefix={op.namespace_prefix} limit={op.limit} offset={op.offset}")
        prefix_len = len(namespace_prefix)

        # Query: namespace starts with the prefix
        if prefix_len == 0:
            query = {}
        else:
            # Each element at position i must match
            query = {f"metadata.namespace.{i}": namespace_prefix[i] for i in range(prefix_len)}

        cursor = self._files_collection.find(query).sort("uploadDate", -1)

        items: list[SearchItem] = []
        skipped = 0
        for doc in cursor:
            # Apply filter on value if specified
            if op.filter:
                grid_out = self._fs.get(doc["_id"])
                content = grid_out.read().decode("utf-8")
                value = _deserialize_value(content)
                if not _matches_filter(value, op.filter):
                    continue
            else:
                value = None  # lazy load

            if skipped < op.offset:
                skipped += 1
                continue

            if len(items) >= op.limit:
                break

            # Load value if not already loaded
            if value is None:
                grid_out = self._fs.get(doc["_id"])
                content = grid_out.read().decode("utf-8")
                value = _deserialize_value(content)

            ns = tuple(doc["metadata"]["namespace"])
            upload_date = doc.get("uploadDate", datetime.now(timezone.utc))
            items.append(
                SearchItem(
                    namespace=ns,
                    key=doc["metadata"]["key"],
                    value=value,
                    created_at=upload_date,
                    updated_at=upload_date,
                )
            )

        return items

    def _handle_list_namespaces(self, op: ListNamespacesOp) -> list[tuple[str, ...]]:
        # Aggregate distinct namespaces
        pipeline: list[dict] = []

        # Match conditions
        if op.match_conditions:
            match_filters = []
            for cond in op.match_conditions:
                if cond.match_type == "prefix":
                    for i, component in enumerate(cond.path):
                        if component != "*":
                            match_filters.append({f"metadata.namespace.{i}": str(component)})
                elif cond.match_type == "suffix":
                    # Suffix matching requires post-filtering
                    pass
            if match_filters:
                pipeline.append({"$match": {"$and": match_filters}})

        pipeline.append({"$group": {"_id": "$metadata.namespace"}})
        pipeline.append({"$sort": {"_id": 1}})

        results: list[tuple[str, ...]] = []
        for doc in self._files_collection.aggregate(pipeline):
            ns = tuple(doc["_id"])

            # Apply max_depth truncation
            if op.max_depth is not None:
                ns = ns[: op.max_depth]

            # Apply suffix filtering
            if op.match_conditions:
                if not _matches_suffix_conditions(ns, op.match_conditions):
                    continue

            if ns not in results:
                results.append(ns)

        # Apply offset and limit
        return results[op.offset : op.offset + op.limit]

    def delete_by_namespace(self, namespace: tuple[str, ...]) -> int:
        """Delete all files in a namespace. Returns count of deleted files."""
        namespace_list = _coerce_namespace(namespace)
        count = 0
        for doc in self._files_collection.find({"metadata.namespace": namespace_list}):
            self._fs.delete(doc["_id"])
            count += 1
        return count

    def put_if_absent(self, namespace: tuple[str, ...], key: str, value: dict) -> bool:
        """Create one file without replacing an existing namespace/key identity."""

        namespace_list = _coerce_namespace(namespace)
        content = _serialize_value(value)
        metadata = {"namespace": namespace_list, "key": key}
        if self._ttl_seconds > 0:
            metadata["expireAt"] = datetime.now(timezone.utc) + timedelta(seconds=self._ttl_seconds)
        try:
            self._fs.put(content.encode("utf-8"), filename=key, metadata=metadata)
        except DuplicateKeyError:
            return False
        return True

    def delete_by_key_prefix(self, namespace: tuple[str, ...], prefix: str) -> int:
        """Delete all files in a namespace whose key starts with prefix."""
        namespace_list = _coerce_namespace(namespace)
        query = {
            "metadata.namespace": namespace_list,
            "metadata.key": {"$regex": f"^{re.escape(prefix)}"},
        }
        count = 0
        for doc in self._files_collection.find(query):
            self._fs.delete(doc["_id"])
            count += 1
        return count

    def ensure_ttl_index(self) -> None:
        """Create TTL index on metadata.expireAt for automatic per-document expiry.

        Documents with expireAt=null or missing never expire.
        If an index with the same key already exists but with different
        options, drop it first and recreate.
        """
        # Remove legacy uploadDate-based TTL index if present
        try:
            self._files_collection.drop_index("uploadDate_1")
            logger.info("Dropped legacy uploadDate TTL index")
        except OperationFailure:
            pass  # Index doesn't exist

        try:
            self._files_collection.create_index("metadata.expireAt", expireAfterSeconds=0)
        except OperationFailure as e:
            if e.code == 85:  # IndexOptionsConflict
                self._files_collection.drop_index("metadata.expireAt_1")
                self._files_collection.create_index("metadata.expireAt", expireAfterSeconds=0)
            else:
                raise

    def ensure_identity_index(self) -> None:
        """Ensure every store namespace/key pair has at most one GridFS file."""

        self._files_collection.create_index(
            [("metadata.namespace", 1), ("metadata.key", 1)],
            unique=True,
            name="namespace_key_unique",
        )


def _serialize_value(value: dict) -> str:
    """Serialize a value dict to JSON string for GridFS storage."""
    return json.dumps(value, ensure_ascii=False)


def _deserialize_value(content: str) -> dict:
    """Deserialize JSON string from GridFS back to a value dict."""
    return json.loads(content)


def _matches_filter(value: dict, filter_dict: dict) -> bool:
    """Check if a value matches the filter criteria."""
    for key, expected in filter_dict.items():
        actual = value.get(key)
        if actual != expected:
            return False
    return True


def _matches_suffix_conditions(
    namespace: tuple[str, ...],
    conditions: tuple[MatchCondition, ...],
) -> bool:
    """Check if namespace matches all suffix conditions."""
    for cond in conditions:
        if cond.match_type != "suffix":
            continue
        path = cond.path
        if len(namespace) < len(path):
            return False
        suffix = namespace[-len(path) :]
        for i, component in enumerate(path):
            if component != "*" and suffix[i] != component:
                return False
    return True
