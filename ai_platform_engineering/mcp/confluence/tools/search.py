"""Read visible content through the supported Confluence CQL search API."""

import logging
from typing import Any

from api.client import make_api_request

logger = logging.getLogger(__name__)


async def search_content(
    cql: str,
    limit: int = 5,
    start: int = 0,
    include_body: bool = False,
) -> dict[str, Any]:
    """Search content visible to the connected caller using Confluence Query Language.

    Results include titles, excerpts, source URLs and space metadata. Set
    include_body to include the matching content's storage-format HTML body.
    Use start and limit to page through results. This operation is read-only.
    """
    if not cql.strip() or len(cql) > 4096:
        raise ValueError("cql must contain between 1 and 4096 characters")
    if not 1 <= limit <= 50 or start < 0:
        raise ValueError("limit must be between 1 and 50 and start must be non-negative")
    expand = "content.space,content.body.storage" if include_body else "content.space"
    success, response = await make_api_request(
        "/search", method="GET",
        params={"cql": cql.strip(), "limit": limit, "start": start, "expand": expand},
    )
    if not success:
        logger.warning("Confluence content search failed")
        raise RuntimeError(f"Confluence search failed: {response.get('error', 'request failed')}")
    return response
