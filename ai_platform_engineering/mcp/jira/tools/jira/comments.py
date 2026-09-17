"""Comment operations for Jira MCP"""

import json
import logging
from typing import Annotated, Optional, Dict, Any, Literal, Union

from pydantic import Field
from api.client import make_api_request
from config import MCP_JIRA_READ_ONLY
from utils.adf import is_adf_format

# Configure logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger("mcp-jira-comments")


async def get_comments(
    issue_key: Annotated[str, Field(description="Jira issue key (e.g., 'PROJ-123')")],
    start_at: Annotated[
        int,
        Field(
            description="The index of the first comment to return (0-based)",
            default=0,
            ge=0,
        ),
    ] = 0,
    max_results: Annotated[
        int,
        Field(
            description="Maximum number of comments to return (max 5000)",
            default=50,
            ge=1,
            le=5000,
        ),
    ] = 50,
    order_by: Annotated[
        str,
        Field(
            description="Order comments by 'created' or '-created' (descending)",
            default="created",
        ),
    ] = "created",
) -> str:
    """Get all comments for a Jira issue.

    Args:
        issue_key: Jira issue key.
        start_at: Starting index for pagination.
        max_results: Maximum number of comments to return.
        order_by: Sort order (created or -created for descending).

    Returns:
        JSON string containing the comments list.

    Raises:
        ValueError: If the API request fails.
    """
    logger.debug(
        f"get_comments called with issue_key={issue_key}, "
        f"start_at={start_at}, max_results={max_results}, order_by={order_by}"
    )

    params = {
        "startAt": start_at,
        "maxResults": max_results,
        "orderBy": order_by,
    }

    success, response = await make_api_request(
        path=f"rest/api/3/issue/{issue_key}/comment",
        method="GET",
        params=params,
    )

    if not success:
        error_result = {
            "success": False,
            "error": f"Failed to fetch comments for issue {issue_key}: {response}"
        }
        return json.dumps(error_result, indent=2, ensure_ascii=False)

    return json.dumps(response, indent=2, ensure_ascii=False)


async def add_comment(
    issue_key: Annotated[str, Field(description="Jira issue key (e.g., 'PROJ-123')")],
    body: Annotated[
        Union[str, Dict[str, Any]],
        Field(
            description=(
                "The comment body. Pass a string when body_format is 'text'. "
                "For rich Jira Cloud comments, pass a complete Atlassian Document "
                "Format (ADF) document object and set body_format to 'adf'."
            )
        ),
    ],
    visibility: Annotated[
        Optional[Dict[str, str]],
        Field(
            description=(
                "(Optional) Visibility restriction for the comment. "
                "Example: {'type': 'role', 'value': 'Administrators'} or "
                "{'type': 'group', 'value': 'jira-developers'}"
            ),
        ),
    ] = None,
    body_format: Annotated[
        Literal["text", "adf"],
        Field(
            description=(
                "Format of body. Use 'text' (default) for backward-compatible plain "
                "text conversion. Use 'adf' to preserve native Jira formatting such "
                "as headings, marks, links, lists, code blocks, and tables."
            ),
        ),
    ] = "text",
) -> str:
    """Add a comment to a Jira issue.

    Args:
        issue_key: Jira issue key.
        body: Plain text or a complete ADF document object.
        visibility: Optional visibility restriction.
        body_format: ``text`` for plain text or ``adf`` for native rich content.

    Returns:
        JSON string representing the created comment.

    Raises:
        ValueError: If required fields missing, invalid input, in read-only mode, or API request fails.
    """
    # Check read-only mode
    if MCP_JIRA_READ_ONLY:
        error_result = {
            "success": False,
            "error": "Jira MCP is in read-only mode. Write operations are disabled."
        }
        return json.dumps(error_result, indent=2, ensure_ascii=False)

    logger.debug(
        "add_comment called with issue_key=%s, body_format=%s, body_type=%s",
        issue_key,
        body_format,
        type(body).__name__,
    )

    if body_format == "text":
        if not isinstance(body, str):
            return json.dumps(
                {
                    "success": False,
                    "error": "body must be a string when body_format is 'text'.",
                },
                indent=2,
                ensure_ascii=False,
            )
        # Preserve the existing plain-text payload exactly for compatibility.
        adf_body = {
            "type": "doc",
            "version": 1,
            "content": [
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": body}],
                }
            ],
        }
    elif body_format == "adf":
        if not is_adf_format(body):
            return json.dumps(
                {
                    "success": False,
                    "error": (
                        "body must be a valid ADF document object when body_format "
                        "is 'adf'. Expected type='doc', version=1, and a content list."
                    ),
                },
                indent=2,
                ensure_ascii=False,
            )
        adf_body = body
    else:
        return json.dumps(
            {
                "success": False,
                "error": "body_format must be either 'text' or 'adf'.",
            },
            indent=2,
            ensure_ascii=False,
        )

    comment_data: Dict[str, Any] = {
        "body": adf_body,
    }

    if visibility:
        if not isinstance(visibility, dict) or "type" not in visibility or "value" not in visibility:
            error_result = {
                "success": False,
                "error": "visibility must be a dict with 'type' and 'value' keys. Example: {'type': 'role', 'value': 'Administrators'}"
            }
            return json.dumps(error_result, indent=2, ensure_ascii=False)
        comment_data["visibility"] = visibility

    logger.debug(f"Comment data to send: {json.dumps(comment_data, indent=2)}")

    success, response = await make_api_request(
        path=f"rest/api/3/issue/{issue_key}/comment",
        method="POST",
        data=comment_data,
    )

    if not success:
        error_result = {
            "success": False,
            "error": f"Failed to add comment to issue {issue_key}: {response}"
        }
        return json.dumps(error_result, indent=2, ensure_ascii=False)

    return json.dumps(response, indent=2, ensure_ascii=False)


async def add_internal_comment(
    issue_key: Annotated[str, Field(description="Jira Service Management issue key (e.g., 'PROJ-123')")],
    body: Annotated[
        str,
        Field(
            description=(
                "The internal note text in plain text or markdown format. "
                "This tool creates a Jira Service Management internal note that is not customer-visible."
            )
        ),
    ],
) -> str:
    """Add an internal note to a Jira Service Management request.

    Use this tool for private/internal JSM notes only. It calls the Jira Platform
    comment API with the Jira Service Management ``sd.public.comment`` entity
    property set to ``internal=true``. This is different from Jira Platform's
    issue comment ``visibility`` field, which restricts comments by Jira
    role/group and does not mean "internal note" versus "reply to customer".

    Args:
        issue_key: Jira Service Management issue key.
        body: Internal note text (plain text or markdown).

    Returns:
        JSON string representing the created internal note.

    Raises:
        ValueError: If required fields missing, in read-only mode, or API request fails.
    """
    if MCP_JIRA_READ_ONLY:
        error_result = {
            "success": False,
            "error": "Jira MCP is in read-only mode. Write operations are disabled."
        }
        return json.dumps(error_result, indent=2, ensure_ascii=False)

    logger.debug(
        f"add_internal_comment called with issue_key={issue_key}, body length={len(body)}"
    )

    adf_body = {
        "type": "doc",
        "version": 1,
        "content": [
            {
                "type": "paragraph",
                "content": [
                    {
                        "type": "text",
                        "text": body
                    }
                ]
            }
        ]
    }

    comment_data: Dict[str, Any] = {
        "body": adf_body,
        "properties": [
            {
                "key": "sd.public.comment",
                "value": {
                    "internal": True,
                },
            }
        ],
    }

    # JSM also supports `public=false` on `/rest/servicedeskapi`, but that path
    # can fail for issues without portal-origin request context. Atlassian's
    # platform comment API supports internal notes through this entity property.
    success, response = await make_api_request(
        path=f"rest/api/3/issue/{issue_key}/comment",
        method="POST",
        data=comment_data,
    )

    if not success:
        error_result = {
            "success": False,
            "error": f"Failed to add internal comment to issue {issue_key}: {response}"
        }
        return json.dumps(error_result, indent=2, ensure_ascii=False)

    return json.dumps(response, indent=2, ensure_ascii=False)


async def update_comment(
    issue_key: Annotated[str, Field(description="Jira issue key (e.g., 'PROJ-123')")],
    comment_id: Annotated[
        str,
        Field(description="The ID of the comment to update")
    ],
    body: Annotated[
        str,
        Field(
            description=(
                "The updated comment text in plain text or markdown format. "
                "The text will be automatically converted to Jira's ADF (Atlassian Document Format)."
            )
        ),
    ],
    visibility: Annotated[
        Optional[Dict[str, str]],
        Field(
            description=(
                "(Optional) Visibility restriction for the comment. "
                "Example: {'type': 'role', 'value': 'Administrators'} or "
                "{'type': 'group', 'value': 'jira-developers'}"
            ),
        ),
    ] = None,
) -> str:
    """Update an existing comment on a Jira issue.

    Args:
        issue_key: Jira issue key.
        comment_id: ID of the comment to update.
        body: Updated comment text (plain text or markdown).
        visibility: Optional visibility restriction.

    Returns:
        JSON string representing the updated comment.

    Raises:
        ValueError: If required fields missing, invalid input, in read-only mode, or API request fails.
    """
    # Check read-only mode
    if MCP_JIRA_READ_ONLY:
        error_result = {
            "success": False,
            "error": "Jira MCP is in read-only mode. Write operations are disabled."
        }
        return json.dumps(error_result, indent=2, ensure_ascii=False)

    logger.debug(
        f"update_comment called with issue_key={issue_key}, "
        f"comment_id={comment_id}, body length={len(body)}"
    )

    # Convert plain text to ADF format
    adf_body = {
        "type": "doc",
        "version": 1,
        "content": [
            {
                "type": "paragraph",
                "content": [
                    {
                        "type": "text",
                        "text": body
                    }
                ]
            }
        ]
    }

    comment_data: Dict[str, Any] = {
        "body": adf_body,
    }

    if visibility:
        if not isinstance(visibility, dict) or "type" not in visibility or "value" not in visibility:
            error_result = {
                "success": False,
                "error": "visibility must be a dict with 'type' and 'value' keys. Example: {'type': 'role', 'value': 'Administrators'}"
            }
            return json.dumps(error_result, indent=2, ensure_ascii=False)
        comment_data["visibility"] = visibility

    logger.debug(f"Comment data to send: {json.dumps(comment_data, indent=2)}")

    success, response = await make_api_request(
        path=f"rest/api/3/issue/{issue_key}/comment/{comment_id}",
        method="PUT",
        data=comment_data,
    )

    if not success:
        error_result = {
            "success": False,
            "error": f"Failed to update comment {comment_id} on issue {issue_key}: {response}"
        }
        return json.dumps(error_result, indent=2, ensure_ascii=False)

    return json.dumps(response, indent=2, ensure_ascii=False)


async def delete_comment(
    issue_key: Annotated[str, Field(description="Jira issue key (e.g., 'PROJ-123')")],
    comment_id: Annotated[
        str,
        Field(description="The ID of the comment to delete")
    ],
) -> str:
    """Delete a comment from a Jira issue.

    Args:
        issue_key: Jira issue key.
        comment_id: ID of the comment to delete.

    Returns:
        JSON string confirming deletion.

    Raises:
        ValueError: If in read-only mode or API request fails.
    """
    # Check read-only mode
    if MCP_JIRA_READ_ONLY:
        error_result = {
            "success": False,
            "error": "Jira MCP is in read-only mode. Write operations are disabled."
        }
        return json.dumps(error_result, indent=2, ensure_ascii=False)

    logger.debug(f"delete_comment called with issue_key={issue_key}, comment_id={comment_id}")

    success, response = await make_api_request(
        path=f"rest/api/3/issue/{issue_key}/comment/{comment_id}",
        method="DELETE",
    )

    if not success:
        error_result = {
            "success": False,
            "error": f"Failed to delete comment {comment_id} from issue {issue_key}: {response}"
        }
        return json.dumps(error_result, indent=2, ensure_ascii=False)

    return json.dumps(
        {
            "success": True,
            "message": f"Comment {comment_id} successfully deleted from issue {issue_key}",
        },
        indent=2,
        ensure_ascii=False,
    )


async def get_comment(
    issue_key: Annotated[str, Field(description="Jira issue key (e.g., 'PROJ-123')")],
    comment_id: Annotated[
        str,
        Field(description="The ID of the comment to retrieve")
    ],
) -> str:
    """Get a specific comment from a Jira issue.

    Args:
        issue_key: Jira issue key.
        comment_id: ID of the comment to retrieve.

    Returns:
        JSON string representing the comment.

    Raises:
        ValueError: If the API request fails.
    """
    logger.debug(f"get_comment called with issue_key={issue_key}, comment_id={comment_id}")

    success, response = await make_api_request(
        path=f"rest/api/3/issue/{issue_key}/comment/{comment_id}",
        method="GET",
    )

    if not success:
        error_result = {
            "success": False,
            "error": f"Failed to fetch comment {comment_id} from issue {issue_key}: {response}"
        }
        return json.dumps(error_result, indent=2, ensure_ascii=False)

    return json.dumps(response, indent=2, ensure_ascii=False)
