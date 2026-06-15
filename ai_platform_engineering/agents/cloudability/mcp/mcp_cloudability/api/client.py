# Copyright 2025 CNOE
# SPDX-License-Identifier: Apache-2.0

"""Cloudability API client."""

import logging
import os
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urljoin

import httpx
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger("mcp_cloudability")

REGION_BASE_URLS = {
    "us": "https://api.cloudability.com",
    "usgov": "https://api.usgov.cloudability.com",
    "gov": "https://api.usgov.cloudability.com",
    "apac": "https://api-au.cloudability.com",
    "au": "https://api-au.cloudability.com",
    "eu": "https://api-eu.cloudability.com",
    "europe": "https://api-eu.cloudability.com",
    "me": "https://api-me.cloudability.com",
    "ca": "https://api-ca.cloudability.com",
    "in": "https://api-in.cloudability.com",
    "jp": "https://api-jp.cloudability.com",
    "sg": "https://api-sg.cloudability.com",
}


def _base_url_from_env() -> str:
    configured_url = os.getenv("CLOUDABILITY_API_URL")
    if configured_url:
        base_url = configured_url.rstrip("/")
    else:
        region = os.getenv("CLOUDABILITY_REGION", "us").lower()
        base_url = REGION_BASE_URLS.get(region, REGION_BASE_URLS["us"])

    if not base_url.endswith("/v3"):
        base_url = f"{base_url}/v3"
    return base_url


def _auth_headers() -> Tuple[Dict[str, str], Optional[httpx.BasicAuth], Optional[str]]:
    headers = {"Accept": "application/json"}
    api_key = os.getenv("CLOUDABILITY_API_KEY")
    open_token = os.getenv("APPTIO_OPENTOKEN") or os.getenv("CLOUDABILITY_APPTIO_OPENTOKEN")
    environment_id = os.getenv("APPTIO_ENVIRONMENT_ID") or os.getenv("CLOUDABILITY_ENVIRONMENT_ID")

    if open_token:
        headers["apptio-opentoken"] = open_token
        if environment_id:
            headers["apptio-environmentid"] = environment_id
        return headers, None, "apptio-opentoken"

    if api_key:
        return headers, httpx.BasicAuth(api_key, ""), "api-key"

    return headers, None, None


def _sanitize_path(path: str) -> str:
    clean_path = path.strip()
    if clean_path.startswith("http://") or clean_path.startswith("https://"):
        raise ValueError("Pass only Cloudability API paths, not full URLs.")
    if clean_path.startswith("/v3/"):
        clean_path = clean_path[3:]
    if not clean_path.startswith("/"):
        clean_path = f"/{clean_path}"
    return clean_path


async def make_api_request(
    path: str,
    method: str = "GET",
    params: Optional[Dict[str, Any]] = None,
    data: Optional[Dict[str, Any]] = None,
    timeout: int = 30,
    accept: str = "application/json",
) -> Tuple[bool, Dict[str, Any]]:
    """Make a request to the Cloudability API."""
    params = params or {}
    data = data or {}
    method = method.upper()

    headers, auth, auth_mode = _auth_headers()
    headers["Accept"] = accept

    if method in {"POST", "PUT", "PATCH"}:
        headers["Content-Type"] = "application/json"

    if auth_mode is None:
        return (
            False,
            {
                "error": (
                    "Cloudability authentication is not configured. Set "
                    "CLOUDABILITY_API_KEY or APPTIO_OPENTOKEN."
                )
            },
        )

    try:
        clean_path = _sanitize_path(path)
    except ValueError as e:
        return False, {"error": str(e)}

    base_url = _base_url_from_env()
    url = urljoin(f"{base_url}/", clean_path.lstrip("/"))
    logger.debug("Making %s request to Cloudability path %s using %s", method, clean_path, auth_mode)

    try:
        async with httpx.AsyncClient(timeout=timeout, auth=auth) as client:
            method_map = {
                "GET": client.get,
                "POST": client.post,
                "PUT": client.put,
                "PATCH": client.patch,
                "DELETE": client.delete,
            }
            if method not in method_map:
                return False, {"error": f"Unsupported HTTP method: {method}"}

            request_kwargs = {"headers": headers, "params": params}
            if method in {"POST", "PUT", "PATCH"}:
                request_kwargs["json"] = data

            response = await method_map[method](url, **request_kwargs)

            if response.status_code in {200, 201, 202, 204}:
                if response.status_code == 204:
                    return True, {"status": "success"}
                if accept == "text/csv":
                    return True, {"csv": response.text}
                try:
                    return True, response.json()
                except ValueError:
                    return True, {"status": "success", "raw_response": response.text}

            try:
                details = response.json()
            except ValueError:
                details = {"raw_response": response.text[:500] if response.text else ""}
            return (
                False,
                {
                    "error": f"Cloudability API request failed: {response.status_code}",
                    "details": details,
                },
            )

    except httpx.TimeoutException:
        return False, {"error": f"Request timed out after {timeout} seconds"}
    except httpx.RequestError as e:
        return False, {"error": f"Request error: {str(e)}"}
