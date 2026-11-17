# Copyright 2025 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Cloudability MCP tool functions."""

from typing import Any, Dict, Literal, Optional

from mcp_cloudability.api.client import make_api_request


def _compact(success: bool, response: Dict[str, Any]) -> Dict[str, Any]:
    if success:
        return response
    return {"error": response.get("error", "Cloudability API request failed"), **response}


async def get_version() -> Dict[str, str]:
    """Return Cloudability MCP server version and supported API family."""
    return {
        "server": "mcp-cloudability",
        "version": "0.1.0",
        "api": "Cloudability API v3",
    }


async def cloudability_request(
    path: str,
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"] = "GET",
    params: Optional[Dict[str, Any]] = None,
    body: Optional[Dict[str, Any]] = None,
    accept: Literal["application/json", "text/csv"] = "application/json",
) -> Dict[str, Any]:
    """
    Call any Cloudability API v3 endpoint.

    Use this for Cloudability endpoints that do not have a dedicated tool.
    Pass paths relative to /v3, such as /budgets, /views, or /portfolio/ec2.
    """
    success, response = await make_api_request(
        path=path,
        method=method,
        params=params,
        data=body,
        accept=accept,
    )
    return _compact(success, response)


async def get_budgets(
    limit: Optional[int] = None,
    offset: Optional[int] = None,
    sort: Optional[str] = None,
    filter: Optional[str] = None,
) -> Dict[str, Any]:
    """List Cloudability budgets."""
    params: Dict[str, Any] = {}
    if limit is not None:
        params["limit"] = limit
    if offset is not None:
        params["offset"] = offset
    if sort:
        params["sort"] = sort
    if filter:
        params["filter"] = filter

    success, response = await make_api_request("/budgets", params=params)
    return _compact(success, response)


async def get_views(
    limit: Optional[int] = None,
    offset: Optional[int] = None,
    sort: Optional[str] = None,
    filter: Optional[str] = None,
) -> Dict[str, Any]:
    """List Cloudability views with optional pagination, sorting, and filtering."""
    params: Dict[str, Any] = {}
    if limit is not None:
        params["limit"] = limit
    if offset is not None:
        params["offset"] = offset
    if sort:
        params["sort"] = sort
    if filter:
        params["filter"] = filter

    success, response = await make_api_request("/views", params=params)
    return _compact(success, response)


async def get_portfolio(
    resource_type: str,
    limit: Optional[int] = None,
    offset: Optional[int] = None,
    sort: Optional[str] = None,
    filter: Optional[str] = None,
    accept: Literal["application/json", "text/csv"] = "application/json",
) -> Dict[str, Any]:
    """
    Get Cloudability portfolio resource data.

    The resource_type maps to /portfolio/{resource_type}; for example, use
    resource_type="ec2" for /portfolio/ec2.
    """
    params: Dict[str, Any] = {}
    if limit is not None:
        params["limit"] = limit
    if offset is not None:
        params["offset"] = offset
    if sort:
        params["sort"] = sort
    if filter:
        params["filter"] = filter

    clean_resource = resource_type.strip().strip("/")
    success, response = await make_api_request(
        f"/portfolio/{clean_resource}",
        params=params,
        accept=accept,
    )
    return _compact(success, response)


async def get_cloudability_api_help() -> Dict[str, Any]:
    """Describe supported Cloudability MCP tools and API request patterns."""
    return {
        "auth": [
            "CLOUDABILITY_API_PUBLIC_KEY and CLOUDABILITY_API_PRIVATE_KEY for Cloudability API key basic authentication",
            "CLOUDABILITY_API_KEY for legacy single-value Cloudability API key basic authentication",
            "APPTIO_OPENTOKEN and APPTIO_ENVIRONMENT_ID for Apptio OpenToken authentication",
        ],
        "regions": {
            "us": "https://api.cloudability.com",
            "usgov": "https://api.usgov.cloudability.com",
            "eu": "https://api-eu.cloudability.com",
            "apac": "https://api-au.cloudability.com",
            "me": "https://api-me.cloudability.com",
            "ca": "https://api-ca.cloudability.com",
            "in": "https://api-in.cloudability.com",
            "jp": "https://api-jp.cloudability.com",
            "sg": "https://api-sg.cloudability.com",
        },
        "tools": [
            "get_budgets",
            "get_views",
            "get_portfolio",
            "cloudability_request",
        ],
        "examples": [
            {"tool": "get_budgets", "arguments": {"limit": 50, "offset": 0}},
            {"tool": "get_views", "arguments": {"limit": 5, "offset": 20}},
            {"tool": "get_portfolio", "arguments": {"resource_type": "ec2", "sort": "-end"}},
            {"tool": "cloudability_request", "arguments": {"path": "/views", "params": {"limit": 5}}},
        ],
    }
