"""Built-in tools for Dynamic Agents.

This module provides wrapper functions for built-in tools that can be
configured per-agent with access controls (e.g., domain restrictions).
"""

import ipaddress
import json
import logging
import os
import shlex
import socket
import subprocess
import time
from datetime import datetime, timezone
from typing import Literal, Optional
from urllib.parse import quote, urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from langchain_core.tools import tool
from langgraph.store.base import GetOp, PutOp

from dynamic_agents.models import BuiltinToolConfigField, BuiltinToolDefinition, InputField, UserContext

logger = logging.getLogger(__name__)

_REDIRECT_STATUS_CODES = {301, 302, 303, 307, 308}
_MAX_FETCH_REDIRECTS = 10
_CURL_BOOLEAN_OPTIONS = {
    "-f",
    "--fail",
    "--fail-with-body",
    "-G",
    "--get",
    "-i",
    "--include",
    "-I",
    "--head",
    "-s",
    "--silent",
    "-S",
    "--show-error",
    "--compressed",
}
_CURL_VALUE_OPTIONS = {
    "-A",
    "--user-agent",
    "--connect-timeout",
    "-d",
    "--data",
    "--data-ascii",
    "--data-binary",
    "--data-raw",
    "--data-urlencode",
    "-e",
    "--referer",
    "-H",
    "--header",
    "--json",
    "--max-time",
    "--retry",
    "--retry-delay",
    "-u",
    "--user",
    "-X",
    "--request",
}
_CURL_FILE_CAPABLE_OPTIONS = {
    "-d",
    "--data",
    "--data-ascii",
    "--data-binary",
    "--data-urlencode",
    "-H",
    "--header",
    "--json",
}


# assisted-by claude code claude-sonnet-4-6
def _is_publicly_routable_ip(ip_address: str) -> bool:
    addr = ipaddress.ip_address(ip_address)
    return addr.is_global and not (
        addr.is_loopback
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_private
        or addr.is_reserved
        or addr.is_unspecified
    )


def _resolve_host_addresses(hostname: str) -> list[str]:
    try:
        return [str(ipaddress.ip_address(hostname))]
    except ValueError:
        pass

    results = socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
    return [sockaddr[0] for _family, _type, _proto, _canonname, sockaddr in results]


def _is_publicly_routable_host(hostname: str) -> tuple[bool, str]:
    if not hostname:
        return False, "missing hostname"

    try:
        addresses = _resolve_host_addresses(hostname)
    except (socket.gaierror, OSError) as e:
        return False, f"hostname could not be resolved: {e}"

    if not addresses:
        return False, "hostname did not resolve to any address"

    for address in addresses:
        try:
            if not _is_publicly_routable_ip(address):
                return False, f"{address} is not publicly routable"
        except ValueError:
            return False, f"{address} is not a valid IP address"

    return True, ""


def _validate_fetch_url(url: str, allowed_domains: str, allow_non_public_urls: bool = False) -> tuple[bool, str, str]:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return False, "Invalid URL - must start with http:// or https://", ""

    domain = (parsed.hostname or "").lower()
    if not allow_non_public_urls:
        is_routable, route_error = _is_publicly_routable_host(domain)
        if not is_routable:
            return False, f"URL host must resolve only to publicly routable IP addresses: {route_error}", domain

    is_allowed, error_msg = is_domain_allowed(domain, allowed_domains)
    if not is_allowed:
        return False, error_msg, domain

    return True, "", domain


def _validate_curl_option_value(option: str, value: str) -> str | None:
    """Reject curl option values that can make curl read local files."""
    if option not in _CURL_FILE_CAPABLE_OPTIONS:
        return None

    stripped_value = value.lstrip()
    if stripped_value.startswith("@") or (option == "--data-urlencode" and "@" in value):
        return f"Option '{option}' cannot read request data from a local file"
    return None


def _prepare_curl_args(
    command: str,
    allowed_domains: str,
    https_only: bool,
    allow_non_public_urls: bool,
) -> tuple[list[str] | None, str | None]:
    """Parse a curl command into a constrained argv and validate every URL."""
    try:
        parsed_args = shlex.split(command)
    except ValueError as e:
        return None, f"Failed to parse command: {e}"

    if parsed_args and parsed_args[0] == "curl":
        parsed_args = parsed_args[1:]

    options: list[str] = []
    urls: list[str] = []
    index = 0
    while index < len(parsed_args):
        token = parsed_args[index]
        if token == "--":
            urls.extend(parsed_args[index + 1 :])
            break
        if not token.startswith("-") or token == "-":
            urls.append(token)
            index += 1
            continue
        if token in _CURL_BOOLEAN_OPTIONS:
            options.append(token)
            index += 1
            continue
        if token.startswith("-") and not token.startswith("--") and len(token) > 2:
            short_option = token[:2]
            if short_option in _CURL_VALUE_OPTIONS:
                value = token[2:]
                error = _validate_curl_option_value(short_option, value)
                if error:
                    return None, error
                options.extend((short_option, value))
                index += 1
                continue
            if all(f"-{flag}" in _CURL_BOOLEAN_OPTIONS for flag in token[1:]):
                options.extend(f"-{flag}" for flag in token[1:])
                index += 1
                continue
        option, separator, inline_value = token.partition("=")
        if separator and option in _CURL_VALUE_OPTIONS:
            error = _validate_curl_option_value(option, inline_value)
            if error:
                return None, error
            options.extend((option, inline_value))
            index += 1
            continue
        if token in _CURL_VALUE_OPTIONS:
            if index + 1 >= len(parsed_args):
                return None, f"Option '{token}' requires a value"
            value = parsed_args[index + 1]
            error = _validate_curl_option_value(token, value)
            if error:
                return None, error
            options.extend((token, value))
            index += 2
            continue
        return None, f"Curl option '{token}' is not supported"

    if not urls:
        return None, "A request URL is required"

    for url in urls:
        parsed_url = urlparse(url)
        if parsed_url.scheme not in ("http", "https"):
            return None, f"The URL scheme '{parsed_url.scheme or '(missing)'}://' is not supported"
        if https_only and parsed_url.scheme != "https":
            return None, "Only https:// URLs are allowed"
        try:
            is_valid, error_msg, _domain = _validate_fetch_url(url, allowed_domains, allow_non_public_urls)
        except Exception as e:
            return None, f"Failed to parse URL: {e}"
        if not is_valid:
            return None, error_msg

    return ["curl", "--globoff", "--max-redirs", "0", *options, "--", *urls], None


def get_builtin_tool_definitions() -> list[BuiltinToolDefinition]:
    """Return definitions of all available built-in tools.

    This is used by the /api/v1/builtin-tools endpoint for dynamic UI discovery.
    """
    return [
        BuiltinToolDefinition(
            id="fetch_url",
            name="Fetch URL",
            description="Simple tool to fetch web pages.",
            enabled_by_default=False,
            config_fields=[
                BuiltinToolConfigField(
                    name="allowed_domains",
                    type="string",
                    label="Allowed Domains",
                    description=(
                        "Comma-separated domain patterns. Use * for all, *.domain.com for subdomains, or exact domain."
                    ),
                    default="*",
                    required=False,
                ),
            ],
        ),
        BuiltinToolDefinition(
            id="curl",
            name="Curl",
            description="Uses curl in a shell to execute HTTP requests. Use with caution.",
            enabled_by_default=False,
            config_fields=[
                BuiltinToolConfigField(
                    name="allowed_domains",
                    type="string",
                    label="Allowed Domains",
                    description=(
                        "Comma-separated domain patterns. Use * for all, *.domain.com for subdomains, or exact domain."
                    ),
                    default="*",
                    required=False,
                ),
                BuiltinToolConfigField(
                    name="https_only",
                    type="boolean",
                    label="HTTPS Only",
                    description="If enabled (default), reject non-https:// URLs.",
                    default=True,
                    required=False,
                ),
                BuiltinToolConfigField(
                    name="allow_non_public_urls",
                    type="boolean",
                    label="Allow Non-Public URLs",
                    description=(
                        "If enabled, allow curl to reach URLs that resolve to private/internal IP addresses. "
                        "Disabled by default (SSRF protection). Only enable for agents that need internal network access."
                    ),
                    default=False,
                    required=False,
                ),
            ],
        ),
        BuiltinToolDefinition(
            id="current_datetime",
            name="Current Date/Time",
            description="Returns the current date and time in various formats and timezones",
            enabled_by_default=True,
            config_fields=[],
        ),
        BuiltinToolDefinition(
            id="user_info",
            name="User Info",
            description="Returns information about the current user (email, name, groups)",
            enabled_by_default=True,
            config_fields=[],
        ),
        BuiltinToolDefinition(
            id="wait",
            name="Wait",
            description="Pauses execution for a specified duration",
            enabled_by_default=True,
            config_fields=[
                BuiltinToolConfigField(
                    name="max_seconds",
                    type="number",
                    label="Max Wait Duration",
                    description="Maximum allowed wait duration in seconds (1-3600)",
                    default=300,
                    required=False,
                ),
            ],
        ),
        BuiltinToolDefinition(
            id="request_user_input",
            name="Request User Input",
            description="Requests structured input from the user via a form (HITL)",
            enabled_by_default=True,
            config_fields=[],
        ),
        BuiltinToolDefinition(
            id="self_identity",
            name="Self Identity",
            description="Returns this agent's identity and configuration — the agent MUST use this to know who it is",
            enabled_by_default=True,
            config_fields=[],
        ),
    ]


def is_domain_allowed(url_domain: str, allowed_domains_str: str) -> tuple[bool, str]:
    """Check if a domain is allowed by the pattern string.

    Args:
        url_domain: The domain from the URL (e.g., "docs.cisco.com")
        allowed_domains_str: Comma-separated domain patterns

    Returns:
        Tuple of (is_allowed, error_message). error_message is empty if allowed.

    Examples:
        is_domain_allowed("docs.cisco.com", "*") -> (True, "")
        is_domain_allowed("docs.cisco.com", "*.cisco.com") -> (True, "")
        is_domain_allowed("docs.cisco.com", "cisco.com") -> (False, "...")
        is_domain_allowed("cisco.com", "cisco.com") -> (True, "")
        is_domain_allowed("evil.com", "*.cisco.com,*.google.com") -> (False, "...")
    """
    # Empty or whitespace-only = block all
    if not allowed_domains_str or not allowed_domains_str.strip():
        return False, "No domains are allowed (allowed_domains is empty)"

    patterns = [p.strip().lower() for p in allowed_domains_str.split(",") if p.strip()]
    if not patterns:
        return False, "No domains are allowed (allowed_domains is empty)"

    url_domain = url_domain.lower()

    for pattern in patterns:
        if pattern == "*":
            return True, ""  # Wildcard allows all
        elif pattern.startswith("*."):
            # Wildcard subdomain match: *.cisco.com
            base_domain = pattern[2:]  # Remove "*."
            if url_domain == base_domain or url_domain.endswith("." + base_domain):
                return True, ""
        else:
            # Exact match only
            if url_domain == pattern:
                return True, ""

    # Build helpful error message
    return False, f"Domain '{url_domain}' is not allowed. Allowed patterns: {allowed_domains_str}"


def _fetch_url_content(url: str, format: Literal["text", "raw"], timeout: int, allowed_domains: str) -> str:
    """Fetch content from a URL (internal implementation).

    Args:
        url: The URL to fetch
        format: 'text' (extract readable content) or 'raw' (raw HTML)
        timeout: Request timeout in seconds

    Returns:
        Fetched content as string, or "ERROR: <message>" on failure
    """
    try:
        current_url = url
        response = None
        for _redirect_count in range(_MAX_FETCH_REDIRECTS + 1):
            is_valid, error_msg, _domain = _validate_fetch_url(current_url, allowed_domains)
            if not is_valid:
                return f"ERROR: {error_msg}"

            response = requests.get(current_url, timeout=timeout, allow_redirects=False)
            if getattr(response, "status_code", None) not in _REDIRECT_STATUS_CODES:
                break

            location = response.headers.get("location")
            if not location:
                break
            current_url = urljoin(current_url, location)
        else:
            return f"ERROR: Too many redirects (>{_MAX_FETCH_REDIRECTS})"

        if response is None:
            return "ERROR: No response received"

        response.raise_for_status()

        content_type = response.headers.get("content-type", "").lower()

        if "application/json" in content_type:
            return response.text
        elif "text/html" in content_type:
            if format == "raw":
                return response.text
            else:
                soup = BeautifulSoup(response.text, "html.parser")
                for script in soup(["script", "style"]):
                    script.decompose()
                return soup.get_text(separator="\n", strip=True)
        else:
            return response.text

    except requests.exceptions.HTTPError as e:
        status_code = e.response.status_code if e.response else "Unknown"
        return f"ERROR: HTTP {status_code}: {e}"
    except requests.exceptions.Timeout:
        return f"ERROR: Request timeout after {timeout} seconds"
    except requests.exceptions.RequestException as e:
        return f"ERROR: Network error: {e}"
    except Exception as e:
        return f"ERROR: {e}"


def create_fetch_url_tool(allowed_domains: str = "*"):
    """Create a fetch_url tool with domain restrictions.

    Args:
        allowed_domains: Comma-separated domain patterns.
            - "*" allows all domains
            - "*.cisco.com" allows any subdomain of cisco.com
            - "cisco.com" allows only the exact domain
            - Empty string blocks all domains

    Returns:
        A LangChain tool that wraps fetch_url with domain ACL.
    """

    @tool
    def fetch_url(
        url: str,
        thought: str = "",
        format: Literal["text", "raw"] = "text",
        timeout: int = 30,
    ) -> str:
        """Fetch content from a URL.

        Use this tool to retrieve content from web pages, APIs, or documentation sites.
        The content is extracted as readable text by default.

        Args:
            url: The URL to fetch (must be http:// or https://)
            thought: Brief reasoning for why you're fetching this URL
            format: 'text' (extract readable content) or 'raw' (raw HTML)
            timeout: Request timeout in seconds (default: 30)

        Returns:
            Fetched content as string, or error message on failure.

        Example:
            content = fetch_url("https://docs.example.com/guide")
        """
        # Validate URL format
        if not url.startswith(("http://", "https://")):
            return "ERROR: Invalid URL - must start with http:// or https://"

        # Check domain ACL
        try:
            is_valid, error_msg, domain = _validate_fetch_url(url, allowed_domains)
            if not is_valid:
                logger.warning(f"fetch_url domain blocked: {domain} (patterns: {allowed_domains})")
                return f"ERROR: {error_msg}"

        except Exception as e:
            return f"ERROR: Failed to parse URL: {e}"

        # Fetch the content
        logger.debug(f"fetch_url: fetching {url} (domain allowed)")
        return _fetch_url_content(url, format, timeout, allowed_domains)

    return fetch_url


def create_curl_tool(allowed_domains: str = "*", https_only: bool = True, allow_non_public_urls: bool = False):
    """Create a curl tool with domain restrictions.

    Supports all HTTP methods (GET, POST, PUT, PATCH, DELETE). Use this
    when agents need to call write APIs that fetch_url cannot handle.

    Args:
        allowed_domains: Comma-separated domain patterns (same ACL as fetch_url).
        https_only: If True (default), reject non-https URLs.
        allow_non_public_urls: If True, skip SSRF IP routing validation so the tool can
            reach private/internal addresses. Off by default.

    Returns:
        A LangChain tool that wraps curl with domain ACL and optional https-only enforcement.
    """
    CURL_TIMEOUT = 300

    @tool
    def curl(
        command: str,
        thought: str = "",
        timeout: int = CURL_TIMEOUT,
        strip_html: bool = False,
    ) -> str:
        """Execute an HTTP request via curl (https:// only).

        Use this for all HTTP operations that require a method other than GET,
        or when you need fine-grained control over headers and request body:
        POST, PUT, PATCH, DELETE, and file downloads.

        Args:
            command: Curl command to run (e.g., "curl -s -X PUT https://api.example.com/resource -d '{}'")
            thought: Brief reasoning for why you're making this request
            timeout: Command timeout in seconds (default: 300)
            strip_html: If True, strip HTML tags and return plain text

        Returns:
            Command output as string, or "ERROR: <message>" on failure.

        Examples:
            # PUT request with JSON body
            curl("curl -s -X PUT https://api.example.com/resource -H 'Content-Type: application/json' -d '{\"status\":\"done\"}'")

            # POST with auth header
            curl("curl -s -X POST https://api.example.com/items -H 'Authorization: Bearer TOKEN' -d '{\"name\":\"test\"}'")

            # GET request (alternative to fetch_url)
            curl("curl -s https://api.example.com/data")
        """
        args, validation_error = _prepare_curl_args(
            command,
            allowed_domains,
            https_only,
            allow_non_public_urls,
        )
        if validation_error or args is None:
            logger.warning("curl command blocked: %s", validation_error)
            return f"ERROR: {validation_error}"

        # Detect write method for post-execution warning
        write_method = None
        args_upper = [a.upper() for a in args]
        for flag in ("-X", "--request"):
            if flag.upper() in args_upper:
                idx = args_upper.index(flag.upper())
                if idx + 1 < len(args_upper):
                    method = args_upper[idx + 1]
                    if method in ("PUT", "PATCH", "DELETE"):
                        write_method = method
                        break

        try:
            result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
            output = result.stdout
            if result.stderr:
                output = (output + "\n" + result.stderr) if output else result.stderr
            if result.returncode != 0:
                return f"ERROR: {output}" if output else "ERROR: Command failed"
            if not output:
                output = "Success (no output)"
            if write_method:
                output = (
                    f"⚠️ WARNING: This request used {write_method}, which may have modified or deleted server-side data. "
                    "Verify the result carefully before proceeding.\n\n"
                ) + output
            if strip_html:
                try:
                    soup = BeautifulSoup(output, "html.parser")
                    for tag in soup(["script", "style"]):
                        tag.decompose()
                    return soup.get_text(separator="\n", strip=True)
                except Exception:
                    pass
            return output
        except subprocess.TimeoutExpired:
            logger.warning(f"curl timed out after {timeout}s: {command[:100]}")
            return f"ERROR: Command timed out after {timeout} seconds"
        except FileNotFoundError:
            logger.error("curl binary not found — ensure curl is installed in the container")
            return "ERROR: curl command not found — ensure curl is installed"
        except Exception as e:
            logger.error(f"curl unexpected error: {e}")
            return f"ERROR: {e}"

    return curl


def create_current_datetime_tool():
    """Create a current_datetime tool.

    Returns:
        A LangChain tool that returns the current date and time.
    """

    @tool
    def current_datetime(
        thought: str = "",
        timezone_name: str = "UTC",
        format: str = "iso",
    ) -> str:
        """Get the current date and time.

        Use this tool when you need to know the current time or date,
        for scheduling, logging, or time-sensitive operations.

        Args:
            thought: Brief reasoning for why you need the current time
            timezone_name: Timezone name (e.g., 'UTC', 'US/Eastern', 'Europe/London').
                         Defaults to 'UTC'.
            format: Output format - 'iso' (ISO 8601), 'human' (readable), or 'unix' (timestamp).
                   Defaults to 'iso'.

        Returns:
            Current date/time in the requested format.

        Example:
            current_datetime()  # Returns ISO format in UTC
            current_datetime(timezone_name="US/Pacific", format="human")
        """
        try:
            import zoneinfo

            try:
                tz = zoneinfo.ZoneInfo(timezone_name)
            except Exception:
                # Fall back to UTC if timezone is invalid
                tz = timezone.utc
                logger.warning(f"Invalid timezone '{timezone_name}', using UTC")

            now = datetime.now(tz)

            if format == "unix":
                return str(int(now.timestamp()))
            elif format == "human":
                return now.strftime("%A, %B %d, %Y at %I:%M:%S %p %Z")
            else:  # iso
                return now.isoformat()

        except Exception as e:
            return f"ERROR: Failed to get current datetime: {e}"

    return current_datetime


def create_user_info_tool(user: UserContext, client_context: dict | None = None):
    """Create a user_info tool with the current user's information.

    Returns all fields present on the ``UserContext`` instance, including
    any opaque extra fields injected by the gateway (``is_admin``,
    ``is_authorized``, ``can_view_admin``, etc.).  The tool output adapts
    automatically when the gateway adds or removes fields — no code
    changes needed here.

    When ``client_context`` is provided, it is included under the
    ``client_context`` key so the agent can see which client (Slack, web UI,
    etc.) is being used and adapt its behavior accordingly.

    Args:
        user: User context (email required, everything else opaque).
        client_context: Optional client context dict (source, channel_type, etc.).

    Returns:
        A LangChain tool that returns user information.
    """

    # Snapshot once — UserContext is immutable for the lifetime of a request.
    _user_data = user.model_dump(exclude={"raw_claims"})
    if client_context:
        _user_data["client_context"] = client_context

    @tool
    def user_info(thought: str = "") -> dict:
        """Get information about the current user and client context.

        Use this tool when you need to personalize responses, check user identity,
        access user metadata for authorization decisions, or determine which client
        (e.g. Slack, web UI) the user is interacting from.

        Args:
            thought: Brief reasoning for why you need user information

        Returns:
            Dictionary with user information.  Always includes ``email``.
            Other fields (``name``, ``is_admin``, ``groups``, etc.) depend
            on how the user was authenticated.  May include ``client_context``
            with the client source and metadata (e.g. ``source``, ``channel_type``,
            ``overthink``).

        Example:
            info = user_info()
            print(f"Hello, {info.get('name') or info['email']}!")
            source = info.get('client_context', {}).get('source', 'unknown')
        """
        return _user_data

    return user_info


def create_wait_tool(max_seconds: int = 300):
    """Create a wait tool with configurable max duration.

    Args:
        max_seconds: Maximum allowed wait duration in seconds (default: 300)

    Returns:
        A LangChain tool that pauses execution.
    """

    @tool
    def wait(seconds: float, thought: str = "") -> str:
        """Pause execution for a specified duration.

        Use this tool when you need to wait between operations, implement
        rate limiting, or add delays for timing-sensitive workflows.

        Args:
            seconds: Duration to wait in seconds. Must be positive and
                    not exceed the configured maximum.
            thought: Brief reasoning for why you need to wait

        Returns:
            Confirmation message with actual wait duration.

        Example:
            wait(5)  # Pause for 5 seconds
        """
        if seconds <= 0:
            return "ERROR: Wait duration must be positive"

        if seconds > max_seconds:
            return f"ERROR: Wait duration {seconds}s exceeds maximum allowed ({max_seconds}s)"

        try:
            import time

            time.sleep(seconds)
            return f"Waited for {seconds} seconds"
        except Exception as e:
            return f"ERROR: Wait failed: {e}"

    return wait


def create_request_user_input_tool():
    """Create a request_user_input tool for HITL forms.

    This tool works with HumanInTheLoopMiddleware via interrupt_on configuration.
    When the agent calls this tool, the middleware intercepts it and pauses execution.
    The agent runtime detects the interrupt, sends an SSE event with form metadata,
    and waits for the user to submit or dismiss the form.

    When resumed, the middleware re-invokes the tool with edited args that have
    field values populated by the user. The tool then extracts and returns those values.

    Returns:
        A LangChain tool for collecting structured user input.
    """

    @tool
    def request_user_input(
        prompt: str,
        fields: list[dict],
        thought: str = "",
    ) -> str:
        """Request structured input from the user via a form.

        Use this tool when you need specific information from the user that
        would benefit from a structured form interface (e.g., configuration values,
        approval decisions, multi-field input).

        The execution will pause until the user submits or dismisses the form.

        Args:
            prompt: Message explaining what information is needed and why.
            fields: List of field definitions. Each field should have:
                - field_name: Unique identifier (snake_case)
                - field_label: Display label (optional, auto-generated from field_name)
                - field_description: Help text (optional)
                - field_type: One of "text", "select", "multiselect", "boolean", "number", "url", "email"
                - field_values: Options for select/multiselect (required for those types)
                - required: Whether field is required (default: false)
                - default_value: Pre-populated value (optional)
                - placeholder: Placeholder text (optional)
                - value: User-provided value (populated when form is submitted)

        Returns:
            JSON string of submitted values ({"field_name": "value", ...}),
            or "Waiting for user input" if fields don't have values yet,
            or error message if validation fails.

        Example:
            result = request_user_input(
                prompt="Please provide deployment configuration:",
                fields=[
                    {"field_name": "environment", "field_type": "select",
                     "field_values": ["dev", "staging", "prod"], "required": True},
                    {"field_name": "replicas", "field_type": "number", "default_value": "3"},
                    {"field_name": "confirm_deploy", "field_type": "boolean",
                     "field_label": "Confirm Deployment", "required": True}
                ]
            )
        """
        # Validate fields against InputField model
        validated_fields = []
        for field_dict in fields:
            try:
                validated = InputField(**field_dict)
                validated_fields.append(validated.model_dump())
            except Exception as e:
                logger.warning(f"Invalid field definition: {field_dict}, error: {e}")
                return f"ERROR: Invalid field definition: {e}"

        # Check if any fields have values (user has submitted the form)
        fields_with_values = [f for f in validated_fields if f.get("value") is not None]

        if not fields_with_values:
            # No values yet - this is the initial call, middleware will intercept
            # and pause execution. Return a placeholder that won't be seen.
            return "Waiting for user input"

        # Check required fields have values
        required_missing = [f["field_name"] for f in validated_fields if f.get("required") and f.get("value") is None]
        if required_missing:
            return f"ERROR: Missing required fields: {', '.join(required_missing)}"

        # Extract values and return as JSON
        result = {}
        for f in validated_fields:
            field_name = f.get("field_name", "")
            value = f.get("value")
            if value is not None:
                result[field_name] = value

        return json.dumps(result)

    return request_user_input


def create_self_identity_tool(
    agent_id: str,
    name: str,
    description: str | None,
    model_id: str,
    model_provider: str,
    gradient_theme: str | None,
):
    """Create a self_identity tool with the agent's own metadata.

    Exposes non-sensitive agent configuration so the agent can identify itself.
    Deliberately excludes the system prompt, owner ID, and execution/session IDs.

    Args:
        agent_id: Unique agent ID.
        name: Agent display name.
        description: Agent description.
        model_id: LLM model identifier.
        model_provider: LLM provider.
        gradient_theme: UI gradient theme, or None.

    Returns:
        A LangChain tool that returns agent metadata.
    """

    @tool
    def self_identity(thought: str = "") -> dict:
        """Get this agent's identity. You MUST call this tool whenever you need
        to know who you are or what your name is. Never guess or assume your
        identity — always call this tool first.

        Args:
            thought: Brief reasoning for why you need identity information

        Returns:
            Dictionary with agent identity:
            - id: Unique agent ID
            - name: Agent display name
            - description: Agent description (may be null)
            - model_id: LLM model identifier
            - model_provider: LLM provider
            - gradient_theme: UI theme (may be null)
        """
        return {
            "id": agent_id,
            "name": name,
            "description": description,
            "model_id": model_id,
            "model_provider": model_provider,
            "gradient_theme": gradient_theme,
        }

    return self_identity


def create_format_file_tool(store, namespace_factory):
    """Create a format_file tool that reformats single-line files into multi-line.

    This tool detects JSON and pretty-prints it, or chunks non-JSON content
    into fixed-width lines. Useful when grep returns entire file contents
    because the file is a single massive line.

    Args:
        store: The MongoDBGridFSStore instance.
        namespace_factory: Callable(agent_id, session_id) -> namespace tuple.
    """

    @tool
    def format_file(
        file_path: str,
    ) -> str:
        """Reformat a single-line file into multiple lines for easier searching.

        Use this tool when grep returns an entire file's content because the file
        is stored as one massive line (e.g., minified JSON). This creates a new
        formatted copy that grep can search line-by-line.

        For JSON files: pretty-prints with indentation.
        For other files: splits into fixed-width lines of 200 characters.

        Args:
            file_path: Absolute path to the file to format (e.g., /large_tool_results/tooluse_abc123)

        Returns:
            The path to the newly created formatted file, or an error message.
        """
        namespace = namespace_factory()

        # Read the file from the store
        items = store.batch([GetOp(namespace=namespace, key=file_path)])
        item = items[0] if items else None
        if item is None:
            return f"Error: file not found at {file_path}"

        content_lines = item.value.get("content", [])
        if not content_lines:
            return f"Error: file at {file_path} has no content"

        if len(content_lines) > 1:
            return f"File already has {len(content_lines)} lines — no reformatting needed."

        line = content_lines[0]
        if len(line) < 1000:
            return f"File is only {len(line)} characters — no reformatting needed."

        # Try JSON pretty-print
        stripped = line.lstrip()
        is_json = False
        if stripped and stripped[0] in ("{", "["):
            try:
                parsed = json.loads(line)
                formatted_lines = json.dumps(parsed, indent=2, ensure_ascii=False).split("\n")
                is_json = True
            except (json.JSONDecodeError, ValueError):
                pass  # Not valid JSON — fall through to fixed-width chunking

        if not is_json:
            # Chunk into fixed-width lines
            chunk_size = 200
            formatted_lines = [line[i : i + chunk_size] for i in range(0, len(line), chunk_size)]

        # Determine output filename
        if is_json:
            output_path = f"{file_path}_formatted.json"
        else:
            output_path = f"{file_path}_formatted"

        # Write the formatted file
        now = datetime.now(timezone.utc).isoformat()
        value = {
            "content": formatted_lines,
            "created_at": now,
            "modified_at": now,
        }
        store.batch([PutOp(namespace=namespace, key=output_path, value=value)])

        return f"Created formatted file at {output_path} ({len(formatted_lines)} lines). Use grep or read_file on this path instead."

    return format_file


# ═══════════════════════════════════════════════════════════════════════════════
# Workflow tools — list runs, get run status, start a workflow run
# ═══════════════════════════════════════════════════════════════════════════════


def _format_bearer_authorization(token: str | None) -> str | None:
    """Normalize a raw JWT or ``Bearer …`` value for outbound Authorization headers."""
    if not token or not str(token).strip():
        return None
    raw = str(token).strip()
    if raw.lower().startswith("bearer "):
        return raw
    return f"Bearer {raw}"


class WorkflowApiClient:
    """HTTP client for calling the CAIPE UI workflow API.

    Prefers the end-user bearer captured at request entry (Webex/Slack OBO,
    browser session JWT) so workflow start/run authz matches the invoking user.
    Falls back to OAuth2 client credentials for system-only triggers with no user
    token (scheduled jobs, background automation).
    """

    def __init__(
        self,
        base_url: str,
        token_url: str = "",
        client_id: str = "",
        client_secret: str = "",
        scope: str = "",
        audience: str = "",
        user_bearer: str | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.token_url = token_url
        self.client_id = client_id
        self.client_secret = client_secret
        self.scope = scope
        self.audience = audience
        self.user_bearer = user_bearer
        self._caipe_api_auth_enabled = bool(token_url and client_id and client_secret)
        self._cached_token: Optional[str] = None
        self._token_expires_at: float = 0

        if _format_bearer_authorization(user_bearer):
            logger.info("WorkflowApiClient: using delegated user bearer for BFF workflow calls")
        elif self._caipe_api_auth_enabled:
            logger.info(f"WorkflowApiClient: OAuth2 configured (token_url={token_url})")
        else:
            logger.warning("WorkflowApiClient: No OAuth2 credentials configured, requests will be unauthenticated")

    def _get_token(self) -> Optional[str]:
        """Get a valid access token, refreshing if needed."""
        if not self._caipe_api_auth_enabled:
            return None

        if self._cached_token and time.time() < (self._token_expires_at - 60):
            return self._cached_token

        payload = {
            "grant_type": "client_credentials",
            "client_id": self.client_id,
            "client_secret": self.client_secret,
        }
        if self.scope:
            payload["scope"] = self.scope
        if self.audience:
            payload["audience"] = self.audience

        resp = requests.post(
            self.token_url,
            data=payload,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=10,
        )
        if not resp.ok:
            logger.error(f"OAuth2 token fetch failed: {resp.status_code} {resp.text}")
            raise RuntimeError(f"OAuth2 token fetch failed: HTTP {resp.status_code}")

        data = resp.json()
        self._cached_token = data["access_token"]
        self._token_expires_at = time.time() + data.get("expires_in", 3600)
        logger.info("Workflow API: OAuth2 token acquired (expires in %ds)", data.get("expires_in", 3600))
        return self._cached_token

    def _headers(self) -> dict[str, str]:
        """Build request headers with optional auth."""
        headers = {"Content-Type": "application/json"}
        user_auth = _format_bearer_authorization(self.user_bearer)
        if user_auth:
            headers["Authorization"] = user_auth
            return headers
        token = self._get_token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return headers

    def get(self, path: str, params: dict | None = None) -> requests.Response:
        """Make an authenticated GET request."""
        url = f"{self.base_url}{path}"
        return requests.get(url, params=params, headers=self._headers(), timeout=30)

    def post(self, path: str, json_data: dict | None = None) -> requests.Response:
        """Make an authenticated POST request."""
        url = f"{self.base_url}{path}"
        return requests.post(url, json=json_data, headers=self._headers(), timeout=30)


def _workflow_display_name(config_id: str, labels: dict[str, str]) -> str:
    return labels.get(config_id, config_id)


def _truncate_workflow_text(value: str | None, *, max_len: int = 4000) -> str | None:
    if not value or not str(value).strip():
        return None
    text = str(value).strip()
    if len(text) <= max_len:
        return text
    return f"{text[: max_len - 3]}..."


_TERMINAL_WORKFLOW_STATUSES = frozenset({"completed", "failed", "cancelled"})
_WORKFLOW_STATUS_POLL_INTERVAL_SECONDS = 3.0
_WORKFLOW_STATUS_MAX_WAIT_SECONDS = 300


def _workflow_ui_public_base_url(api_base_url: str) -> str:
    """Resolve a browser-reachable Grid base URL for workflow run links."""
    for env_key in ("CAIPE_UI_PUBLIC_URL", "CAIPE_UI_BASE_URL", "NEXTAUTH_URL"):
        candidate = os.environ.get(env_key, "").strip().rstrip("/")
        if candidate:
            return candidate
    return api_base_url.rstrip("/")


def _workflow_run_detail_url(ui_base_url: str, run_id: object) -> str | None:
    """Build the Grid workflow run detail page URL for end users."""
    rid = str(run_id or "").strip()
    if not rid:
        return None
    return f"{ui_base_url.rstrip('/')}/workflows/run/{quote(rid, safe='')}"


def _build_workflow_run_status_payload(
    run: dict,
    *,
    labels: dict[str, str],
    ui_public_base_url: str,
) -> dict[str, object]:
    """Build agent-facing workflow status JSON including per-step outputs."""
    config_id = run.get("workflow_config_id", "")
    run_id = run.get("_id")
    steps_summary = []
    final_output_parts: list[str] = []
    for s in run.get("steps", []):
        step_info = {
            "index": s.get("index"),
            "display_text": s.get("display_text"),
            "agent_id": s.get("agent_id"),
            "status": s.get("status"),
            "started_at": s.get("started_at"),
            "completed_at": s.get("completed_at"),
        }
        if s.get("error"):
            step_info["error"] = s["error"]
        output = _truncate_workflow_text(s.get("response"))
        if output:
            step_info["output"] = output
            label = s.get("display_text") or f"Step {s.get('index')}"
            final_output_parts.append(f"**{label}**\n{output}")
        steps_summary.append(step_info)

    payload: dict[str, object] = {
        "run_id": run_id,
        "workflow_config_id": config_id,
        "workflow_name": _workflow_display_name(config_id, labels),
        "status": run.get("status"),
        "started_at": run.get("started_at"),
        "completed_at": run.get("completed_at"),
        "steps": steps_summary,
    }
    run_url = _workflow_run_detail_url(ui_public_base_url, run_id)
    if run_url:
        payload["run_url"] = run_url
    if final_output_parts:
        payload["final_output_summary"] = "\n\n".join(final_output_parts)
    return payload


def create_workflow_tools(
    client: WorkflowApiClient,
    allowed_config_ids: list[str],
    trigger_context: dict | None = None,
    workflow_labels: dict[str, str] | None = None,
) -> list:
    """Create the 3 workflow built-in tools.

    Args:
        client: WorkflowApiClient for making authenticated HTTP calls.
        allowed_config_ids: Workflow config IDs this agent is allowed to interact with.
        trigger_context: Optional dict with agent/user context for trigger_info.
        workflow_labels: Optional map of workflow_config_id → human-readable name.
    Returns:
        List of 3 LangChain tools: list_workflow_runs, get_workflow_run_status, start_workflow_run.
    """

    allowed_set = set(allowed_config_ids)
    labels = workflow_labels or {}
    ui_public_base_url = _workflow_ui_public_base_url(client.base_url)

    @tool
    def list_workflow_runs(
        thought: str = "",
        workflow_config_id: str = "",
    ) -> str:
        """List recent runs for a specific workflow.

        Use this tool to check the history of a workflow — see past runs,
        their statuses, and how many steps completed.

        Args:
            thought: Brief reasoning for why you want to list runs.
            workflow_config_id: The workflow config ID to list runs for.
                Must be one of the workflow IDs described in your system prompt.

        Returns:
            JSON array of recent runs with status, step progress, and timestamps.
        """
        if not workflow_config_id:
            return "ERROR: workflow_config_id is required"
        if workflow_config_id not in allowed_set:
            return (
                f"ERROR: You are not allowed to access workflow '{workflow_config_id}'. Allowed: {sorted(allowed_set)}"
            )

        try:
            resp = client.get(
                "/api/workflow-runs",
                params={"workflow_config_id": workflow_config_id},
            )
            if not resp.ok:
                return f"ERROR: Failed to list runs: HTTP {resp.status_code} - {resp.text[:200]}"

            runs = resp.json()
            # Return a simplified summary
            summaries = []
            for run in runs[:20]:  # cap at 20
                completed = sum(1 for s in run.get("steps", []) if s.get("status") == "completed")
                total = len(run.get("steps", []))
                summaries.append(
                    {
                        "run_id": run.get("_id"),
                        "status": run.get("status"),
                        "steps": f"{completed}/{total}",
                        "started_at": run.get("started_at"),
                        "completed_at": run.get("completed_at"),
                    }
                )
            return json.dumps(summaries, indent=2)
        except Exception as e:
            return f"ERROR: Failed to list workflow runs: {e}"

    @tool
    def get_workflow_run_status(
        thought: str = "",
        run_id: str = "",
        wait_for_completion: bool = False,
        max_wait_seconds: int = 120,
    ) -> str:
        """Get the detailed status of a specific workflow run.

        Use this when the user asks for workflow status, progress, summary, or output.
        Call again on every follow-up — do not assume earlier results still apply.
        Set wait_for_completion=true to poll until the run finishes (or times out)
        so you can return final_output_summary in one reply.
        Summarize the returned JSON for the user in plain language — do not
        tell them to call tools themselves.

        Args:
            thought: Brief reasoning for why you want to check this run.
            run_id: The ID of the workflow run to check.
            wait_for_completion: When true, poll until the run reaches a terminal
                status (completed, failed, cancelled) or max_wait_seconds elapses.
            max_wait_seconds: Maximum seconds to poll when wait_for_completion
                is true (capped at 300).

        Returns:
            JSON object with run status, step details, step outputs, errors, timestamps,
            and run_url (Grid UI link to open the run detail page).
        """
        if not run_id:
            return "ERROR: run_id is required"

        wait_seconds = max(0, min(int(max_wait_seconds), _WORKFLOW_STATUS_MAX_WAIT_SECONDS))
        deadline = time.monotonic() + wait_seconds if wait_for_completion else time.monotonic()

        try:
            while True:
                resp = client.get(
                    "/api/workflow-runs",
                    params={"run_id": run_id},
                )
                if not resp.ok:
                    return f"ERROR: Failed to get run status: HTTP {resp.status_code} - {resp.text[:200]}"

                run = resp.json()
                config_id = run.get("workflow_config_id", "")
                if config_id not in allowed_set:
                    return (
                        f"ERROR: This run belongs to workflow '{config_id}' which you are not allowed to access."
                    )

                payload = _build_workflow_run_status_payload(
                    run,
                    labels=labels,
                    ui_public_base_url=ui_public_base_url,
                )
                status = str(run.get("status") or "")

                if not wait_for_completion or status in _TERMINAL_WORKFLOW_STATUSES:
                    return json.dumps(payload, indent=2)

                if time.monotonic() >= deadline:
                    payload["wait_timed_out"] = True
                    payload["message"] = (
                        "Workflow still running after wait. Call get_workflow_run_status again "
                        "with wait_for_completion=true for more updates."
                    )
                    return json.dumps(payload, indent=2)

                time.sleep(_WORKFLOW_STATUS_POLL_INTERVAL_SECONDS)
        except Exception as e:
            return f"ERROR: Failed to get workflow run status: {e}"

    @tool
    def start_workflow_run(
        thought: str = "",
        workflow_config_id: str = "",
        user_context: str = "",
    ) -> str:
        """Start a new workflow run.

        Use this tool to trigger a workflow. Pick workflow_config_id from the
        Available Workflows section by matching the user's requested name.
        After starting, call get_workflow_run_status with wait_for_completion=true
        when the user wants progress or final output.

        Args:
            thought: Brief reasoning for why you want to start this workflow.
            workflow_config_id: The workflow config ID to run.
                Must be one of the workflow IDs described in your system prompt.
            user_context: Optional free-text context to pass to the workflow.
                This will be available to each step as {{ user_context }}.

        Returns:
            JSON object with run_id, workflow name, and initial status.
        """
        if not workflow_config_id:
            return "ERROR: workflow_config_id is required"
        if workflow_config_id not in allowed_set:
            return f"ERROR: You are not allowed to run workflow '{workflow_config_id}'. Allowed: {sorted(allowed_set)}"

        try:
            body: dict = {"workflow_config_id": workflow_config_id}
            if user_context:
                body["user_context"] = user_context
            body["trigger_info"] = {
                "triggered_by": "agent",
                "context": trigger_context or {},
            }

            resp = client.post("/api/workflow-runs", json_data=body)
            if not resp.ok:
                return f"ERROR: Failed to start workflow: HTTP {resp.status_code} - {resp.text[:200]}"

            result = resp.json()
            workflow_name = _workflow_display_name(workflow_config_id, labels)
            run_id = result.get("run_id")
            start_payload: dict[str, object] = {
                "run_id": run_id,
                "workflow_config_id": workflow_config_id,
                "workflow_name": workflow_name,
                "status": result.get("status", "running"),
                "message": (
                    f"Started workflow '{workflow_name}'. "
                    "Call get_workflow_run_status with this run_id and "
                    "wait_for_completion=true when the user wants progress or final output."
                ),
            }
            run_url = _workflow_run_detail_url(ui_public_base_url, run_id)
            if run_url:
                start_payload["run_url"] = run_url
            return json.dumps(start_payload, indent=2)
        except Exception as e:
            return f"ERROR: Failed to start workflow run: {e}"

    return [list_workflow_runs, get_workflow_run_status, start_workflow_run]


__all__ = [
    "create_fetch_url_tool",
    "create_curl_tool",
    "create_current_datetime_tool",
    "create_user_info_tool",
    "create_wait_tool",
    "create_request_user_input_tool",
    "create_self_identity_tool",
    "create_format_file_tool",
    "create_workflow_tools",
    "WorkflowApiClient",
    "is_domain_allowed",
    "get_builtin_tool_definitions",
]
