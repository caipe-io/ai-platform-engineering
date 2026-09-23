"""MCP tools backed by the CAIPE platform change API."""

from __future__ import annotations

import functools
import logging
import os
from typing import Annotated, Any, Literal

import httpx
from fastmcp.server.dependencies import get_http_request
from mcp.shared.exceptions import McpError
from mcp.types import INTERNAL_ERROR, INVALID_PARAMS, ErrorData
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

ResourceKind = Literal["agent", "skill", "workflow", "schedule"]
ChangeOperation = Literal["create", "update"]


def _api_url() -> str:
  return os.environ.get("CAIPE_API_URL", "http://caipe-ui:3000").rstrip("/")


def _initiator_token() -> str:
  """Resolve the human initiating the control-plane request."""
  try:
    request = get_http_request()
  except Exception as exc:
    token = os.environ.get("CAIPE_ACCESS_TOKEN", "").strip()
    if token:
      return token
    raise ValueError("Platform tools require an authenticated user token") from exc

  for name in (
    "x-caipe-initiator-token",
    "x-caipe-caller-token",
    "authorization",
  ):
    token = request.headers.get(name, "").strip()
    if token.lower().startswith("bearer "):
      token = token[7:].strip()
    if token:
      return token
  raise ValueError("Platform tools require an authenticated user token")


def _headers() -> dict[str, str]:
  return {
    "Authorization": f"Bearer {_initiator_token()}",
    "Content-Type": "application/json",
    "X-Client-Source": "platform-mcp",
  }


def _handle_errors(func):
  @functools.wraps(func)
  async def wrapper(*args, **kwargs):
    try:
      return await func(*args, **kwargs)
    except McpError:
      raise
    except httpx.HTTPStatusError as exc:
      try:
        detail = exc.response.json()
      except ValueError:
        detail = exc.response.text[:500]
      raise McpError(
        ErrorData(
          code=INVALID_PARAMS if exc.response.status_code < 500 else INTERNAL_ERROR,
          message=f"Platform API returned HTTP {exc.response.status_code}: {detail}",
        )
      ) from exc
    except (ValueError, TypeError) as exc:
      raise McpError(ErrorData(code=INVALID_PARAMS, message=str(exc))) from exc
    except httpx.TimeoutException as exc:
      raise McpError(ErrorData(code=INTERNAL_ERROR, message="Platform API timed out")) from exc
    except Exception as exc:  # noqa: BLE001
      logger.exception("Unhandled platform MCP error")
      raise McpError(ErrorData(code=INTERNAL_ERROR, message=f"{type(exc).__name__}: {exc}")) from exc

  return wrapper


async def _request(method: str, path: str, *, json: dict[str, Any] | None = None) -> dict[str, Any]:
  timeout = float(os.environ.get("HTTP_TIMEOUT", "30"))
  async with httpx.AsyncClient(timeout=timeout) as client:
    response = await client.request(method, f"{_api_url()}{path}", headers=_headers(), json=json)
    response.raise_for_status()
    payload = response.json()
    if isinstance(payload, dict) and payload.get("success") is True and "data" in payload:
      data = payload["data"]
      return data if isinstance(data, dict) else {"data": data}
    return payload


class InspectResourceArgs(BaseModel):
  kind: ResourceKind
  resource_id: Annotated[str, Field(min_length=1)]


class CheckAccessArgs(InspectResourceArgs):
  operation: ChangeOperation = "update"


class ProposeChangeArgs(BaseModel):
  kind: ResourceKind
  operation: ChangeOperation = "update"
  resource_id: str | None = None
  changes: dict[str, Any]
  reason: Annotated[str, Field(min_length=1, max_length=2000)]


class DomainProposalArgs(BaseModel):
  operation: ChangeOperation = "update"
  resource_id: str | None = None
  changes: dict[str, Any]
  reason: Annotated[str, Field(min_length=1, max_length=2000)]


class ChangeIdArgs(BaseModel):
  change_id: Annotated[str, Field(min_length=1)]


class ApplyChangeArgs(ChangeIdArgs):
  confirmed: Annotated[
    bool,
    Field(description="Must be true only after the human explicitly approves the rendered proposal."),
  ]


def register_tools(server) -> None:
  @server.tool(
    name="get_platform_resource",
    description="Inspect an agent, skill, workflow, or schedule using the initiating user's current read access.",
  )
  @_handle_errors
  async def get_platform_resource(args: InspectResourceArgs) -> dict[str, Any]:
    return await _request("POST", "/api/platform/resources/inspect", json=args.model_dump())

  @server.tool(
    name="check_platform_access",
    description=(
      "Check whether the initiating user may create or update a platform resource. "
      "Use this before drafting a change and explain any denial to the user."
    ),
  )
  @_handle_errors
  async def check_platform_access(args: CheckAccessArgs) -> dict[str, Any]:
    return await _request("POST", "/api/platform/resources/access", json=args.model_dump())

  @server.tool(
    name="propose_platform_change",
    description=(
      "Create a durable, non-applied proposal for an agent, skill, workflow, or schedule. "
      "Show the returned diff and ask the human to approve before calling apply_platform_change."
    ),
  )
  @_handle_errors
  async def propose_platform_change(args: ProposeChangeArgs) -> dict[str, Any]:
    return await _request("POST", "/api/platform/changes", json=args.model_dump())

  def register_domain_proposal(kind: ResourceKind) -> None:
    @server.tool(
      name=f"propose_{kind}_change",
      description=(
        f"Create a durable, non-applied {kind} change proposal. "
        "Never treat proposal creation as approval; show the diff to the human first."
      ),
    )
    @_handle_errors
    async def propose(args: DomainProposalArgs) -> dict[str, Any]:
      payload = args.model_dump()
      payload["kind"] = kind
      return await _request("POST", "/api/platform/changes", json=payload)

  for kind in ("agent", "skill", "workflow", "schedule"):
    register_domain_proposal(kind)  # type: ignore[arg-type]

  @server.tool(
    name="get_platform_change",
    description="Fetch a pending or completed platform change proposal and its reviewable diff.",
  )
  @_handle_errors
  async def get_platform_change(args: ChangeIdArgs) -> dict[str, Any]:
    return await _request("GET", f"/api/platform/changes/{args.change_id}")

  @server.tool(
    name="apply_platform_change",
    description=(
      "Apply a pending proposal. This is a mutating operation and is always human-approval gated. "
      "Call it only after the human explicitly approves the exact proposal diff."
    ),
  )
  @_handle_errors
  async def apply_platform_change(args: ApplyChangeArgs) -> dict[str, Any]:
    if not args.confirmed:
      raise ValueError("The human must explicitly confirm this proposal before it can be applied")
    return await _request("POST", f"/api/platform/changes/{args.change_id}/apply", json={"confirmed": True})

  @server.tool(
    name="cancel_platform_change",
    description="Cancel the initiating user's pending proposal without changing the target resource.",
  )
  @_handle_errors
  async def cancel_platform_change(args: ChangeIdArgs) -> dict[str, Any]:
    return await _request("POST", f"/api/platform/changes/{args.change_id}/cancel", json={})
