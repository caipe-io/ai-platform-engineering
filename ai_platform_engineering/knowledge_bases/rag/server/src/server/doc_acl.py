"""Hybrid ACL: per-document ACL tag filtering on top of datasource-level RBAC.

Design
------

The existing RAG RBAC stack (``server.rbac``) already gates queries at
the **datasource** (``datasource_id``) granularity via OpenFGA. That
works well for component-level access inside a knowledge base.

Hybrid ACL adds a second, **finer** filter applied at query time:
``metadata.acl_tags`` IN <user's tag set>.

Concretely, every document indexed into Milvus may carry a list of
``acl_tags`` (strings) on its ``metadata`` dict. Common pattern:

- ``["__public__"]`` — readable by every authenticated user.

Non-public tag vocabularies must be backed by explicit authorization logic
rather than static IdP or AD group claims.

Resolution at query time:

1. The caller's tag-set is computed from the literal ``__public__``.
2. The Milvus filter ``metadata.acl_tags in [<user tags>]`` is
   AND-merged into the existing filter expression.

Feature flag
------------

This module is **off by default** (``RBAC_DOC_ACL_TAGS_ENABLED=false``)
so deployments that haven't migrated their indexes don't suddenly
return empty results.

When OFF:
  - ``derive_user_acl_tags`` returns []
  - ``apply_doc_acl_filter`` is a no-op
  - the query path does not add document ACL filters.

When ON:
  - ``apply_doc_acl_filter`` injects the metadata.acl_tags filter on
    every authenticated query.
  - Documents with no acl_tags are **invisible**. Backfill existing
    collections before enabling the filter.

Why a flag rather than a hard cutover: Milvus does not support
"missing-key" filters cleanly (you'd have to scan), so we cannot
"fall through to allow" for un-tagged docs. The migration step is
mandatory before flipping the flag.

Extension points:
  - UI for assigning acl_tags to documents at ingest time.
  - Per-tenant tag dictionary / validation in the BFF.
  - Connector-side doc tagging during ingestion.
"""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover — import-time circular avoidance
    from common.models.rbac import UserContext
    from common.models.server import QueryRequest

logger = logging.getLogger(__name__)


# Feature flag. Default OFF.
DOC_ACL_TAGS_ENABLED = os.environ.get(
    "RBAC_DOC_ACL_TAGS_ENABLED", "false"
).strip().lower() in ("true", "1", "yes")

# The "everyone-can-read" tag. Migration step backfills this onto
# every existing document.
PUBLIC_TAG = "__public__"

# Filter key the query layer expects (existing Milvus schema supports
# arbitrary metadata.<key> filters — see query_service.py).
ACL_FILTER_KEY = "metadata.acl_tags"


def derive_user_acl_tags(user_context: "UserContext") -> list[str]:
    """Derive the set of ACL tags the user is authorized to see.

    Returns an empty list when the feature flag is off so callers can
    short-circuit without an extra branch.

    Resolution rules:
      - Always include ``__public__`` (every authenticated user).
      - No IdP/AD group-derived tags are emitted.
    """
    if not DOC_ACL_TAGS_ENABLED:
        return []

    return [PUBLIC_TAG]


def merge_acl_filter(
    filters: "dict[str, Any] | None",
    user_context: "UserContext",
) -> "dict[str, Any] | None":
    """Merge the ``metadata.acl_tags`` filter into a raw filters dict.

    Shared core of :func:`apply_doc_acl_filter`. Callers that build a plain
    filters dict directly (the FastMCP tool path in ``server.tools``, which
    has no ``QueryRequest`` to mutate) can call this instead. Returns
    ``filters`` unchanged (same object) when the feature flag is off or no
    tags apply, so callers
    can compare identity to detect a no-op if needed.

    Merge semantics:

      - If no existing ``metadata.acl_tags`` filter, set it to the
        user's tag set (Milvus will treat a list as ``IN``).
      - If a string was already passed in (caller-supplied
        constraint), keep it ONLY if it's also in the user's tag
        set; otherwise the result will be empty.
      - If a list was passed, intersect it with the user's tag set;
        if the intersection is empty, set the filter to a sentinel
        value (``["__noresults__"]``) so the vector search returns
        nothing rather than silently widening to the user's full set.

    The third rule prevents a subtle escalation where a malicious or
    buggy caller could pass an ACL tag they are not authorized to use.
    """
    if not DOC_ACL_TAGS_ENABLED:
        return filters
    user_tags = derive_user_acl_tags(user_context)
    if not user_tags:
        return filters

    merged: dict[str, Any] = dict(filters) if filters else {}
    existing = merged.get(ACL_FILTER_KEY)

    if existing is None:
        merged[ACL_FILTER_KEY] = list(user_tags)
    elif isinstance(existing, str):
        merged[ACL_FILTER_KEY] = [existing] if existing in user_tags else [
            "__noresults__"
        ]
    elif isinstance(existing, list):
        intersection = [t for t in existing if t in user_tags]
        merged[ACL_FILTER_KEY] = intersection or ["__noresults__"]
    else:
        # Unexpected type — fail closed: deny everything.
        logger.warning(
            "doc_acl: unexpected type %s for %s filter; failing closed",
            type(existing).__name__,
            ACL_FILTER_KEY,
        )
        merged[ACL_FILTER_KEY] = ["__noresults__"]

    return merged


def apply_doc_acl_filter(
    query_request: "QueryRequest",
    user_context: "UserContext",
) -> None:
    """Inject the ``metadata.acl_tags`` filter into ``query_request.filters``.

    No-op when the feature flag is off.
    See :func:`merge_acl_filter` for the merge semantics.
    """
    merged = merge_acl_filter(query_request.filters, user_context)
    if merged is not query_request.filters:
        query_request.filters = merged


__all__ = [
    "DOC_ACL_TAGS_ENABLED",
    "PUBLIC_TAG",
    "ACL_FILTER_KEY",
    "derive_user_acl_tags",
    "merge_acl_filter",
    "apply_doc_acl_filter",
]
