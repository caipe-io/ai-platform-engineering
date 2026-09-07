"""Issue operations for Jira MCP"""

import json
import logging
import os
from typing import Annotated, Optional, List, Dict, Any, Union

from pydantic import Field

from api.client import make_api_request
from config import MCP_JIRA_READ_ONLY
from tools.jira.constants import check_read_only, check_issues_delete_protection
from utils.field_discovery import get_field_discovery
from utils.adf import ensure_adf_format
from utils.field_handlers import normalize_field_value


# Configure logging
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger("mcp-jira-issues")


def _coerce_update_fields(
    fields: Union[Dict[str, Any], str]
) -> tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Accept structured fields or JSON object strings from MCP transports."""
    if isinstance(fields, dict):
        return fields, None

    if isinstance(fields, str):
        try:
            parsed_fields = json.loads(fields)
        except json.JSONDecodeError as exc:
            return None, f"fields must be a JSON object string: {exc.msg}"

        if isinstance(parsed_fields, dict):
            return parsed_fields, None

        return None, (
            f"fields JSON must decode to an object, got {type(parsed_fields).__name__}"
        )

    return None, f"fields must be a dictionary or JSON object string, got {type(fields).__name__}"


async def get_issue(
    issue_key: Annotated[str, Field(description="Jira issue key (e.g., 'PROJ-123')")],
    fields: Annotated[
        str,
        Field(
            description=(
                "(Optional) Comma-separated list of fields to return (e.g., 'summary,status,customfield_10010'). "
                "You may also provide a single field as a string (e.g., 'duedate'). "
                "Use '*all' for all fields (including custom fields), or omit for essential fields only."
            ),
            default="",
        ),
    ] = "",
    expand: Annotated[
        str,
        Field(
            description=(
                "(Optional) Fields to expand. Examples: 'renderedFields' (for rendered content), "
                "'transitions' (for available status transitions), 'changelog' (for history)"
            ),
            default="",
        ),
    ] = "",
    comment_limit: Annotated[
        int,
        Field(
            description="Maximum number of comments to include (0 or null for no comments)",
            default=10,
            ge=0,
            le=100,
        ),
    ] = 10,
    properties: Annotated[
        str,
        Field(
            description="(Optional) A comma-separated list of issue properties to return",
            default="",
        ),
    ] = "",
    update_history: Annotated[
        bool,
        Field(
            description="Whether to update the issue view history for the requesting user",
            default=True,
        ),
    ] = True,
) -> str:
    """Fetch details of a specific Jira issue."""
    logger.debug(
        f"get_issue called with issue_key={issue_key}, fields={fields}, expand={expand}, "
        f"comment_limit={comment_limit}, properties={properties}, update_history={update_history}"
    )

    fields_list: Optional[List[str]] = None
    if fields and fields != "*all":
        fields_list = [f.strip() for f in fields.split(",")]

    params = {
        "fields": fields_list,
        "properties": properties.split(",") if properties else None,
        "updateHistory": update_history,
    }

    success, response = await make_api_request(
        path=f"rest/api/3/issue/{issue_key}",
        method="GET",
        params=params,
        expand=expand,
    )

    if not success:
        error_result = {
            "success": False,
            "error": f"Failed to fetch Jira issue: {response}"
        }
        return json.dumps(error_result, indent=2, ensure_ascii=False)

    # Add browse URL to response
    import os
    base_url = os.getenv("ATLASSIAN_API_URL", "").rstrip("/")
    if base_url:
        response["browse_url"] = f"{base_url}/browse/{issue_key}"

    return json.dumps(response, indent=2, ensure_ascii=False)




logger = logging.getLogger("mcp-jira-create-issue")

async def create_issue(
    project_key: str,
    summary: str,
    issue_type: str = "Task",
    description: str = "",
    assignee: str = None,
    components: list = None,
    additional_fields: dict = None,
    use_account_id: bool = True
) -> dict:
    """
    Create a Jira issue using the REST API with automatic field discovery and validation.

    This function now includes:
    - Automatic ADF conversion for description fields
    - Field discovery and normalization for custom fields
    - Schema validation
    - Helpful error messages with field suggestions

    Args:
        project_key: Jira project key (e.g., SCRUM)
        summary: Issue summary/title
        issue_type: Issue type (e.g., Task, Bug)
        description: Issue description (plain text, will be converted to ADF automatically)
        assignee: Username or accountId to assign the issue (optional)
        components: List of components names (optional)
        additional_fields: Additional fields as dict (optional)
            Can use field names or IDs. Values will be automatically normalized.
            Example: {"Epic Link": "PROJ-123", "Story Points": 5}
        use_account_id: If True, use 'accountId' for assignee, else 'name' (default True)

    Returns:
        Response JSON from Jira API or error dict.

    Raises:
        ValueError: If in read-only mode or validation fails.
    """
    check_read_only()

    field_discovery = get_field_discovery()

    # Build base fields
    fields = {
        "project": {"key": project_key},
        "summary": summary,
        "issuetype": {"name": issue_type},
    }

    # Convert description to ADF format
    if description:
        fields["description"] = ensure_adf_format(description)

    if assignee:
        fields["assignee"] = (
            {"accountId": assignee} if use_account_id else {"name": assignee}
        )

    if components:
        fields["components"] = [{"name": c} for c in components]

    # Process additional_fields with field discovery and normalization
    if additional_fields:
        normalized_fields = await _normalize_additional_fields(additional_fields, field_discovery)
        fields.update(normalized_fields)

    payload = {"fields": fields}

    logger.debug(f"Creating issue with normalized fields: {json.dumps(payload, indent=2)}")

    success, response = await make_api_request(
        path="rest/api/3/issue",
        method="POST",
        data=payload
    )

    if success:
        logger.info(f"✅ Successfully created issue: {response.get('key', 'unknown')}")
        # Add browse URL to response
        import os
        base_url = os.getenv("ATLASSIAN_API_URL", "").rstrip("/")
        issue_key = response.get('key')
        if base_url and issue_key:
            response["browse_url"] = f"{base_url}/browse/{issue_key}"
        return response
    else:
        error_msg = response.get("error", "Unknown error")
        error_details = response.get("errors", {})
        error_messages = response.get("errorMessages", [])

        # Provide helpful suggestions for field errors
        if error_details:
            suggestions = []
            for field_key, field_error in error_details.items():
                similar = await field_discovery.suggest_similar_fields(field_key)
                if similar:
                    suggestions.append(f"Field '{field_key}' error: {field_error}. Did you mean: {', '.join(similar[:3])}?")
                else:
                    suggestions.append(f"Field '{field_key}' error: {field_error}")

            enhanced_error = {
                "error": error_msg,
                "field_errors": suggestions,
                "error_messages": error_messages
            }
            logger.error(f"❌ Failed to create issue: {json.dumps(enhanced_error, indent=2)}")
            return enhanced_error

        logger.error(f"❌ Failed to create Jira issue: {response}")
        return response


async def _normalize_additional_fields(
    additional_fields: Dict[str, Any],
    field_discovery
) -> Dict[str, Any]:
    """Normalize additional fields using field discovery.

    Args:
        additional_fields: Dict of field names/IDs to values
        field_discovery: FieldDiscovery instance

    Returns:
        Dict with normalized field IDs and values
    """
    normalized = {}

    for field_name_or_id, value in additional_fields.items():
        # Skip if value is None
        if value is None:
            continue

        # Convert field name to ID if necessary
        field_id = await field_discovery.normalize_field_name_to_id(field_name_or_id)

        if not field_id:
            logger.warning(f"⚠️ Field '{field_name_or_id}' not found, using as-is")
            field_id = field_name_or_id

        # Get field schema for normalization
        field_schema = await field_discovery.get_field_schema(field_id)

        # Normalize the value
        normalized_value, error = await normalize_field_value(field_id, value, field_schema)

        if error:
            logger.warning(f"⚠️ Field normalization warning for '{field_id}': {error}")

        # Special handling for description field (ensure ADF)
        if field_id == "description" and isinstance(normalized_value, str):
            normalized_value = ensure_adf_format(normalized_value)

        normalized[field_id] = normalized_value

    return normalized

async def batch_create_issues(
    issues: Annotated[
        str,
        Field(
            description=(
                "JSON array of issue objects. Each object should contain:\n"
                "- project_key (required): The project key (e.g., 'PROJ')\n"
                "- summary (required): Issue summary/title\n"
                "- issue_type (required): Type of issue (e.g., 'Task', 'Bug')\n"
                "- description (optional): Issue description\n"
                "- assignee (optional): Assignee username or email\n"
                "- components (optional): Array of component names\n"
                "Example: [\n"
                '  {"project_key": "PROJ", "summary": "Issue 1", "issue_type": "Task"},\n'
                '  {"project_key": "PROJ", "summary": "Issue 2", "issue_type": "Bug", "components": ["Frontend"]}\n'
                "]"
            )
        ),
    ],
    validate_only: Annotated[
        bool,
        Field(
            description="If true, only validates the issues without creating them",
            default=False,
        ),
    ] = False,
) -> str:
    """Create multiple Jira issues in a batch.

    Args:
        ctx: The FastMCP context.
        issues: JSON array string of issue objects.
        validate_only: If true, only validates without creating.

    Returns:
        JSON string indicating success and listing created issues (or validation result).

    Raises:
        ValueError: If in read-only mode, Jira client unavailable, or invalid JSON.
    """
    # Check read-only mode
    if MCP_JIRA_READ_ONLY:
        error_result = {
            "success": False,
            "error": "Jira MCP is in read-only mode. Write operations are disabled."
        }
        return json.dumps(error_result, indent=2, ensure_ascii=False)

    # Parse issues from JSON string
    try:
        issues_list = json.loads(issues)
        if not isinstance(issues_list, list):
            error_result = {
                "success": False,
                "error": "Input 'issues' must be a JSON array string."
            }
            return json.dumps(error_result, indent=2, ensure_ascii=False)
    except json.JSONDecodeError:
        error_result = {
            "success": False,
            "error": "Invalid JSON in issues"
        }
        return json.dumps(error_result, indent=2, ensure_ascii=False)
    except Exception as e:
        error_result = {
            "success": False,
            "error": f"Invalid input for issues: {e}"
        }
        return json.dumps(error_result, indent=2, ensure_ascii=False)

    # Convert issues to format expected by the API with field discovery
    field_discovery = get_field_discovery()
    formatted_issues = []

    for idx, issue in enumerate(issues_list):
        # Basic validation
        if not all(key in issue for key in ['project_key', 'summary', 'issue_type']):
            error_result = {
                "success": False,
                "error": f"Issue {idx}: Each issue must contain project_key, summary, and issue_type"
            }
            return json.dumps(error_result, indent=2, ensure_ascii=False)

        # Build base fields
        fields = {
            "project": {"key": issue['project_key']},
            "summary": issue['summary'],
            "issuetype": {"name": issue['issue_type']}
        }

        # Add description with ADF conversion
        if 'description' in issue and issue['description']:
            fields['description'] = ensure_adf_format(issue['description'])

        # Add assignee if provided
        if 'assignee' in issue and issue['assignee']:
            fields['assignee'] = {"accountId": issue['assignee']}

        # Add components if provided
        if 'components' in issue and issue['components']:
            fields['components'] = [{"name": c} for c in issue['components']]

        # Process any additional fields with normalization
        additional_fields = {k: v for k, v in issue.items()
                            if k not in ['project_key', 'summary', 'issue_type', 'description', 'assignee', 'components']}

        if additional_fields:
            normalized_fields = await _normalize_additional_fields(additional_fields, field_discovery)
            fields.update(normalized_fields)

        formatted_issues.append({"fields": fields})

    # Prepare the API request payload
    payload = {
        "issueUpdates": formatted_issues,
        "validateOnly": validate_only
    }

    success, response = await make_api_request(
        path="rest/api/3/issue/bulk",
        method="POST",
        data=payload
    )

    if success:
        message = "Issues validated successfully" if validate_only else "Issues created successfully"
        result = {
            "message": message,
            "issues": response.get("issues", [])
        }
        return json.dumps(result, indent=2, ensure_ascii=False)
    else:
        logger.error(f"Failed to create Jira issues in batch: {response}")
        return json.dumps(response, indent=2, ensure_ascii=False)


async def update_issue(
    issue_key: Annotated[str, Field(description="Jira issue key (e.g., 'PROJ-123')")],
    fields: Annotated[
        Union[Dict[str, Any], str],
        Field(
            description=(
                "Dictionary of fields to update. Can use field names or IDs.\n"
                "If your MCP client serializes object parameters, "
                "a JSON object string is also accepted.\n"
                "Values will be automatically normalized based on field type.\n"
                "Examples:\n"
                "- {'summary': 'New title'}\n"
                '- "{\\"summary\\": \\"New title\\"}"\n'
                "- {'description': 'Plain text description'} (auto-converted to ADF)\n"
                "- {'Epic Link': 'PROJ-100'}\n"
                "- {'Story Points': 5}\n"
                "- {'assignee': {'accountId': '...'}} or just {'assignee': 'account-id-string'}"
            )
        ),
    ],
    notify_users: Annotated[
        bool,
        Field(
            description="Whether to send email notifications to users (default: True)",
            default=True,
        ),
    ] = True,
) -> str:
    """Update a Jira issue with automatic field discovery and validation.

    This function includes:
    - Automatic ADF conversion for description fields
    - Field name to ID resolution
    - Field value normalization based on schema
    - Helpful error messages with suggestions

    Args:
        issue_key: The issue key to update
        fields: Dictionary of fields to update (can use names or IDs)
        notify_users: Whether to send email notifications

    Returns:
        JSON string indicating success or error details

    Raises:
        ValueError: If in read-only mode or validation fails.
    """
    # Check read-only mode
    if MCP_JIRA_READ_ONLY:
        error_result = {
            "success": False,
            "error": "Jira MCP is in read-only mode. Write operations are disabled."
        }
        return json.dumps(error_result, indent=2, ensure_ascii=False)

    if not fields:
        error_result = {
            "success": False,
            "error": "At least one field must be provided for update"
        }
        return json.dumps(error_result, indent=2, ensure_ascii=False)

    fields, fields_error = _coerce_update_fields(fields)
    if fields_error:
        error_result = {
            "success": False,
            "error": fields_error
        }
        return json.dumps(error_result, indent=2, ensure_ascii=False)

    field_discovery = get_field_discovery()

    # Normalize all fields
    normalized_fields = await _normalize_additional_fields(fields, field_discovery)

    # Special handling for description - ensure it's in ADF format
    if "description" in normalized_fields:
        if isinstance(normalized_fields["description"], str):
            normalized_fields["description"] = ensure_adf_format(normalized_fields["description"])

    payload = {
        "fields": normalized_fields
    }

    params = {
        "notifyUsers": notify_users
    }

    logger.debug(f"Updating issue {issue_key} with normalized fields: {json.dumps(payload, indent=2)}")

    success, response = await make_api_request(
        path=f"rest/api/3/issue/{issue_key}",
        method="PUT",
        data=payload,
        params=params
    )

    if success:
        # Add browse URL to response
        import os
        base_url = os.getenv("ATLASSIAN_API_URL", "").rstrip("/")
        result = {
            "message": f"✅ Successfully updated issue {issue_key}",
            "updated_fields": list(normalized_fields.keys())
        }
        if base_url:
            result["browse_url"] = f"{base_url}/browse/{issue_key}"
        logger.info(f"✅ Successfully updated issue {issue_key}")
        return json.dumps(result, indent=2, ensure_ascii=False)
    else:
        error_msg = response.get("error", "Unknown error")
        error_details = response.get("errors", {})
        error_messages = response.get("errorMessages", [])

        # Provide helpful suggestions for field errors
        if error_details:
            suggestions = []
            for field_key, field_error in error_details.items():
                similar = await field_discovery.suggest_similar_fields(field_key)
                if similar:
                    suggestions.append(f"Field '{field_key}' error: {field_error}. Did you mean: {', '.join(similar[:3])}?")
                else:
                    suggestions.append(f"Field '{field_key}' error: {field_error}")

            enhanced_error = {
                "error": error_msg,
                "field_errors": suggestions,
                "error_messages": error_messages
            }
            logger.error(f"❌ Failed to update issue {issue_key}: {json.dumps(enhanced_error, indent=2)}")
            return json.dumps(enhanced_error, indent=2, ensure_ascii=False)

        logger.error(f"❌ Failed to update issue {issue_key}: {response}")
        return json.dumps(response, indent=2, ensure_ascii=False)


async def assign_issue(
    issue_key: Annotated[str, Field(description="Jira issue key (e.g., 'PROJ-123')")],
    account_id: Annotated[
        str,
        Field(
            description=(
                "The accountId of the user to assign. "
                "Pass null or empty string to unassign the issue."
            )
        ),
    ] = "",
) -> str:
    """Assign a Jira issue to a user via the dedicated assignee endpoint.

    Uses PUT /rest/api/3/issue/{key}/assignee, which only requires the
    'Assign Issues' permission and bypasses screen field restrictions.
    Prefer this over update_issue for assignee changes on JSM/FAST projects.

    Args:
        issue_key: The issue key to assign
        account_id: The accountId of the assignee, or empty string to unassign

    Returns:
        JSON string indicating success or error details
    """
    if MCP_JIRA_READ_ONLY:
        return json.dumps({
            "success": False,
            "error": "Jira MCP is in read-only mode. Write operations are disabled."
        }, indent=2, ensure_ascii=False)

    payload = {"accountId": account_id if account_id else None}

    success, response = await make_api_request(
        path=f"rest/api/3/issue/{issue_key}/assignee",
        method="PUT",
        data=payload,
    )

    if success:
        # assisted-by Codex Codex-sonnet-4-6
        base_url = os.getenv("ATLASSIAN_API_URL", "").rstrip("/")
        result: Dict[str, Any] = {
            "message": f"✅ Successfully assigned issue {issue_key}" if account_id
                       else f"✅ Successfully unassigned issue {issue_key}",
        }
        if base_url:
            result["browse_url"] = f"{base_url}/browse/{issue_key}"
        logger.info(result["message"])
        return json.dumps(result, indent=2, ensure_ascii=False)
    else:
        logger.error(f"❌ Failed to assign issue {issue_key}: {response}")
        return json.dumps(response, indent=2, ensure_ascii=False)


async def create_issue_link(
    link_type: Annotated[
        str,
        Field(
            description="The type of link to create (e.g., 'Duplicate', 'Blocks', 'Relates to')"
        ),
    ],
    inward_issue_key: Annotated[
        str, Field(description="The key of the inward issue (e.g., 'PROJ-123')")
    ],
    outward_issue_key: Annotated[
        str, Field(description="The key of the outward issue (e.g., 'PROJ-456')")
    ],
    comment: Annotated[
        str, Field(description="(Optional) Comment to add to the link")
    ] = "",
    comment_visibility: dict[str, str] = Field(
        default_factory=dict,
        description="(Optional) Visibility settings for the comment (e.g., {'type': 'group', 'value': 'jira-users'})",
    ),
) -> str:
    """Create a link between two Jira issues.

    Args:
        ctx: The FastMCP context.
        link_type: The type of link (e.g., 'Blocks').
        inward_issue_key: The key of the source issue.
        outward_issue_key: The key of the target issue.
        comment: Optional comment text.
        comment_visibility: Optional dictionary for comment visibility.

    Returns:
        JSON string indicating success or failure.

    Raises:
        ValueError: If required fields are missing, invalid input, or in read-only mode.
    """
    # Check read-only mode
    if MCP_JIRA_READ_ONLY:
        error_result = {
            "success": False,
            "error": "Jira MCP is in read-only mode. Write operations are disabled."
        }
        return json.dumps(error_result, indent=2, ensure_ascii=False)

    if not all([link_type, inward_issue_key, outward_issue_key]):
        error_result = {
            "success": False,
            "error": "link_type, inward_issue_key, and outward_issue_key are required."
        }
        return json.dumps(error_result, indent=2, ensure_ascii=False)

    link_data = {
        "type": {"name": link_type},
        "inwardIssue": {"key": inward_issue_key},
        "outwardIssue": {"key": outward_issue_key},
    }

    if comment:
        comment_obj = {"body": comment}
        if comment_visibility and isinstance(comment_visibility, dict):
            if "type" in comment_visibility and "value" in comment_visibility:
                comment_obj["visibility"] = comment_visibility
            else:
                logger.warning("Invalid comment_visibility dictionary structure.")
        link_data["comment"] = comment_obj

    success, response = await make_api_request(
        path="rest/api/3/issueLink",
        method="POST",
        data=link_data
    )

    if success:
        result = {"message": "Issue link created successfully"}
        return json.dumps(result, indent=2, ensure_ascii=False)
    else:
        logger.error(f"Failed to create issue link: {response}")
        return json.dumps(response, indent=2, ensure_ascii=False)

async def remove_issue_link(
    link_id: Annotated[str, Field(description="The ID of the link to remove")],
) -> str:
    """Remove a link between two Jira issues.

    Args:
        ctx: The FastMCP context.
        link_id: The ID of the link to remove.

    Returns:
        JSON string indicating success.

    Raises:
        ValueError: If link_id is missing or in read-only mode.
    """
    # Check read-only mode
    if MCP_JIRA_READ_ONLY:
        error_result = {
            "success": False,
            "error": "Jira MCP is in read-only mode. Write operations are disabled."
        }
        return json.dumps(error_result, indent=2, ensure_ascii=False)

    if not link_id:
        error_result = {
            "success": False,
            "error": "link_id is required"
        }
        return json.dumps(error_result, indent=2, ensure_ascii=False)

    success, response = await make_api_request(
        path=f"rest/api/3/issueLink/{link_id}",
        method="DELETE"
    )

    if success:
        result = {"message": "Issue link removed successfully"}
        return json.dumps(result, indent=2, ensure_ascii=False)
    else:
        logger.error(f"Failed to remove issue link: {response}")
        return json.dumps(response, indent=2, ensure_ascii=False)

async def batch_get_changelogs(
    issue_ids_or_keys: Annotated[
        list[str],
        Field(
            description="List of Jira issue IDs or keys, e.g. ['PROJ-123', 'PROJ-124']"
        ),
    ],
    fields: Annotated[
        list[str],
        Field(
            description="(Optional) Filter the changelogs by fields, e.g. ['status', 'assignee']. Default to [] for all fields.",
            default_factory=list,
        ),
    ] = [],  # noqa: B006
    limit: Annotated[
        int,
        Field(
            description=(
                "Maximum number of changelogs to return in result for each issue. "
                "Default to -1 for all changelogs. "
                "Notice that it only limits the results in the response, "
                "the function will still fetch all the data."
            ),
            default=-1,
        ),
    ] = -1,
) -> str:
    """Get changelogs for multiple Jira issues (Cloud only).

    Args:
        ctx: The FastMCP context.
        issue_ids_or_keys: List of issue IDs or keys.
        fields: List of fields to filter changelogs by. None for all fields.
        limit: Maximum changelogs per issue (-1 for all).

    Returns:
        JSON string representing a list of issues with their changelogs.

    Raises:
        ValueError: If issues list is empty or invalid.
    """
    if not issue_ids_or_keys:
        error_result = {
            "success": False,
            "error": "At least one issue ID or key is required"
        }
        return json.dumps(error_result, indent=2, ensure_ascii=False)

    # Prepare API request payload
    payload = {
        "issueIds": issue_ids_or_keys,
        "expand": ["changelog"]
    }

    # Add fields filter if provided
    if fields:
        payload["fields"] = fields

    success, response = await make_api_request(
        path="rest/api/3/issue/bulk",
        method="POST",
        data=payload
    )

    if not success:
        logger.error(f"Failed to batch get changelogs: {response}")
        return json.dumps(response, indent=2, ensure_ascii=False)

    # Format the response
    results = []
    limit_val = None if limit == -1 else limit

    issues = response.get("issues", [])
    for issue in issues:
        issue_id = issue.get("id")
        changelogs = issue.get("changelog", {}).get("histories", [])

        # Apply limit if specified
        if limit_val is not None:
            changelogs = changelogs[:limit_val]

        results.append({
            "issue_id": issue_id,
            "changelogs": changelogs
        })

    return json.dumps(results, indent=2, ensure_ascii=False)

async def delete_issue(
    issue_key: str,
    delete_subtasks: bool = False
) -> dict:
    """
    Delete a Jira issue using the REST API.

    Args:
        issue_key: The key of the issue to delete (e.g., PROJ-123)
        delete_subtasks: Whether to delete subtasks as well (default: False)

    Returns:
        Response JSON indicating success or containing error details

    Raises:
        ValueError: If in read-only mode or delete protection is enabled.
    """
    check_read_only()
    check_issues_delete_protection()

    if not issue_key:
        return {"error": "Issue key is required"}

    logger.info(f"Deleting Jira issue {issue_key} (with subtasks: {delete_subtasks})")

    params = {"deleteSubtasks": str(delete_subtasks).lower()}

    success, response = await make_api_request(
        path=f"rest/api/3/issue/{issue_key}",
        method="DELETE",
        params=params
    )

    if success or getattr(response, "status", None) == 204:
        return {"success": True, "message": f"Issue {issue_key} deleted successfully"}

    try:
        error_details = await response.json()
    except Exception:
        error_details = getattr(response, "text", str(response))

    logger.error(f"Failed to delete Jira issue {issue_key}: {error_details}")
    return {"error": error_details}
