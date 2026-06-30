# Copyright 2025 CNOE Contributors
# SPDX-License-Identifier: Apache-2.0

"""
DirectoryAgentSource: discovers agents from an AGNTCY Directory instance via
the AI Finder REST API.  No gRPC SDK required — uses httpx (already a CAIPE
dependency) to call GET /v1/agents.

This is a direct integration with the AI Finder REST endpoint, avoiding the
agntcy-dir package whose sub-dependencies (agntcy-dir-grpc-python,
agntcy-dir-protocolbuffers-python) are not published on public PyPI.

Environment variables:
  DIRECTORY_ENABLED=true              enable Directory-based discovery
  DIRECTORY_BASE_URL=http://...:8888  AI Finder base URL
  DIRECTORY_LABEL_FILTER=key=value    optional label filter (e.g., platform=caipe)
  DIRECTORY_TIMEOUT=10.0              HTTP request timeout in seconds
  DIRECTORY_SYNC_INTERVAL=300         sync interval in seconds (default 5 min)
"""

import logging
import os
from typing import Optional

import httpx

logger = logging.getLogger(__name__)


def _extract_a2a_card(record: dict) -> Optional[dict]:
    """Return card_data from modules[name="integration/a2a"].data, or None."""
    agent = record.get("agent", record)
    for mod in agent.get("modules", []):
        if mod.get("name") == "integration/a2a":
            return mod.get("data", {}).get("card_data")
    return None


def _extract_mcp_module(record: dict) -> Optional[dict]:
    """Return the MCP module data from modules[name="integration/mcp"], or None.

    OASF MCP module structure (schema v1.0.0):
      module.data = {
        "name": "server-name",
        "description": "...",
        "connections": [{"type": "streamable-http"|"sse"|"stdio", "url": "...", "command": "...", "args": [...]}],
        "tools": [...],
        "resources": [...],
        "prompts": [...]
      }
    """
    agent = record.get("agent", record)
    for mod in agent.get("modules", []):
        if mod.get("name") == "integration/mcp":
            return mod.get("data")
    return None


def _extract_mcp_endpoint(mcp_data: dict) -> Optional[tuple[str, str]]:
    """Extract (url, transport_type) from MCP module data.

    Returns the first HTTP-based connection (streamable-http or sse).
    Returns None if only stdio connections are available (not remotely callable).
    """
    connections = mcp_data.get("connections", [])
    for conn in connections:
        conn_type = conn.get("type", "")
        url = conn.get("url")
        if url and conn_type in ("streamable-http", "sse"):
            return (url, conn_type)
    return None


def _extract_a2a_url(card: dict) -> Optional[str]:
    """
    Extract the A2A endpoint URL from an A2A card dict.

    A2A 0.2.x puts the URL in supportedInterfaces[0].url; the top-level 'url'
    field on the card is the canonical fallback used by older cards.
    """
    interfaces = card.get("supportedInterfaces", [])
    if interfaces:
        url = interfaces[0].get("url")
        if url:
            return url
    return card.get("url")


def _extract_capabilities(record: dict) -> list[str]:
    """Extract capability/skill tags from the OASF record."""
    agent = record.get("agent", record)
    capabilities: list[str] = []

    # Check for skills module
    for mod in agent.get("modules", []):
        if mod.get("name", "").startswith("skills/"):
            skill_name = mod["name"].split("/", 1)[1]
            capabilities.append(skill_name)

    # Check annotations
    annotations = agent.get("annotations", {})
    if isinstance(annotations, dict):
        skills = annotations.get("skills", [])
        if isinstance(skills, list):
            capabilities.extend(skills)

    return capabilities


def _extract_metadata(record: dict) -> dict:
    """Extract metadata fields from the OASF record."""
    agent = record.get("agent", record)
    metadata: dict = {}

    # CID is the content-addressed identifier
    if "cid" in record:
        metadata["directory_cid"] = record["cid"]

    # Labels
    labels = agent.get("labels", {})
    if labels:
        metadata["directory_labels"] = labels

    # Description
    description = agent.get("description")
    if description:
        metadata["description"] = description

    # Version
    version = agent.get("version")
    if version:
        metadata["version"] = version

    return metadata


class DirectoryAgentRecord:
    """Parsed agent record from the Directory."""

    def __init__(
        self,
        name: str,
        url: str,
        a2a_card: Optional[dict],
        capabilities: list[str],
        metadata: dict,
        protocol: str = "a2a",
        transport: str = "http",
        mcp_tools: Optional[list[dict]] = None,
    ) -> None:
        self.name = name
        self.url = url
        self.a2a_card = a2a_card
        self.capabilities = capabilities
        self.metadata = metadata
        self.protocol = protocol  # "mcp" or "a2a"
        self.transport = transport  # "streamable-http", "sse", or "http" (a2a fallback)
        self.mcp_tools = mcp_tools  # Pre-declared tools from MCP module (optional)

    @property
    def directory_id(self) -> str:
        """Stable ID for this record, derived from CID or name."""
        return self.metadata.get("directory_cid", f"dir-{self.name}")

    @property
    def is_mcp(self) -> bool:
        """Whether this record speaks MCP protocol (can be auto-enabled)."""
        return self.protocol == "mcp"


class DirectoryAgentSource:
    """
    Queries the AGNTCY Directory AI Finder HTTP endpoint to discover agents.

    Only records that contain a valid 'integration/a2a' module are returned,
    so results can be consumed directly by the dynamic agents runtime.
    """

    def __init__(
        self,
        base_url: str,
        label_filter: Optional[str] = None,
        timeout: float = 10.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._label_filter = label_filter
        self._timeout = timeout

    @classmethod
    def from_env(cls) -> Optional["DirectoryAgentSource"]:
        """Return a configured instance when DIRECTORY_ENABLED=true, else None."""
        if os.getenv("DIRECTORY_ENABLED", "").lower() != "true":
            return None
        return cls(
            base_url=os.getenv("DIRECTORY_BASE_URL", "http://dir-apiserver:8888"),
            label_filter=os.getenv("DIRECTORY_LABEL_FILTER"),
            timeout=float(os.getenv("DIRECTORY_TIMEOUT", "10.0")),
        )

    def fetch_agents(self) -> list[DirectoryAgentRecord]:
        """
        Fetch agent records from the Directory AI Finder catalog endpoint.

        The AI Finder returns CatalogEntry objects (not raw OASF records).
        Each CatalogEntry has:
          - identifier: stable unique ID (URI/URN)
          - display_name: human-readable name
          - media_type: content type (e.g., "application/oasf-agent-record+json",
            "application/a2a-agent-card+json", "application/mcp-server-card+json")
          - url OR data: reference to artifact or inline content

        For entries with inline OASF data, we parse modules directly.
        For entries with only a URL, we call /v1/agents/{cid}/export?format=oasf
        to get the full record.

        Records are typed by protocol:
        - Records with an integration/mcp module → protocol="mcp"
        - Records with only integration/a2a module → protocol="a2a"
        - Records with both → treated as MCP (preferred for direct invocation)
        All are stored as enabled=False (catalog-only until admin activates).
        """
        try:
            params: dict = {}
            if self._label_filter:
                params["filter"] = self._label_filter
            with httpx.Client(timeout=self._timeout) as client:
                resp = client.get(f"{self._base_url}/v1/agents", params=params)
                resp.raise_for_status()
                payload = resp.json()
        except Exception as exc:
            logger.warning("Directory fetch failed (%s): %s", self._base_url, exc)
            return []

        items = payload if isinstance(payload, list) else payload.get("results", [])
        results: list[DirectoryAgentRecord] = []
        for entry in items:
            record = self._resolve_catalog_entry(entry)
            if record is None:
                continue
            parsed = self._parse_oasf_record(record, entry)
            if parsed:
                results.append(parsed)

        logger.info(
            "Directory discovery: %d agents (%d MCP, %d A2A) from %s",
            len(results),
            sum(1 for r in results if r.is_mcp),
            sum(1 for r in results if not r.is_mcp),
            self._base_url,
        )
        return results

    def _resolve_catalog_entry(self, entry: dict) -> Optional[dict]:
        """Resolve a CatalogEntry to its full OASF record dict.

        Handles three cases:
        1. Entry has inline 'data' with OASF content → use directly
        2. Entry has 'agent' field (raw OASF-style response) → use as-is
        3. Entry has only a 'url' → fetch the export endpoint for OASF
        4. Entry has 'identifier'/'cid' → call /v1/agents/{cid}/export
        """
        # Case: raw OASF record (for test compatibility and older API versions)
        if "agent" in entry:
            return entry

        # Case: CatalogEntry with inline data
        data = entry.get("data")
        if data and isinstance(data, dict):
            # The inline data IS the OASF record (or A2A card, depending on media_type)
            media_type = entry.get("media_type", "")
            if "oasf" in media_type or "modules" in data:
                # OASF record embedded inline
                return {"agent": data, "cid": entry.get("identifier", "")}
            elif "a2a" in media_type:
                # A2A card embedded inline — wrap as OASF-like structure
                return {
                    "agent": {
                        "name": entry.get("display_name", data.get("name", "")),
                        "description": data.get("description", ""),
                        "modules": [{
                            "name": "integration/a2a",
                            "data": {"card_data": data},
                        }],
                    },
                    "cid": entry.get("identifier", ""),
                }
            elif "mcp" in media_type:
                # MCP server card embedded inline
                return {
                    "agent": {
                        "name": entry.get("display_name", data.get("name", "")),
                        "description": data.get("description", ""),
                        "modules": [{
                            "name": "integration/mcp",
                            "id": 202,
                            "data": data,
                        }],
                    },
                    "cid": entry.get("identifier", ""),
                }
            else:
                # Unknown media type with data — try to parse as OASF
                return {"agent": data, "cid": entry.get("identifier", "")}

        # Case: CatalogEntry with URL reference — try url first, then cid export
        identifier = entry.get("identifier", entry.get("cid", ""))
        url = entry.get("url")

        # Prefer the explicit artifact URL when present
        if url:
            try:
                with httpx.Client(timeout=self._timeout) as client:
                    resp = client.get(url)
                    resp.raise_for_status()
                    data = resp.json()
                    return {"agent": data, "cid": identifier}
            except Exception as exc:
                logger.debug("Failed to fetch artifact URL %s: %s", url, exc)

        # Fall back to /v1/agents/{cid}/export only if identifier looks like a CID
        # (CIDs are base32/base58 encoded, typically starting with 'ba' or 'Qm')
        if identifier and self._looks_like_cid(identifier):
            result = self._fetch_export(identifier)
            if result:
                return result

        logger.debug("CatalogEntry skipped: no resolvable data (entry=%s)", identifier or "<unknown>")
        return None

    @staticmethod
    def _looks_like_cid(identifier: str) -> bool:
        """Heuristic check: CIDs are base32/base58 strings (ba*, Qm*) without URI schemes."""
        if "://" in identifier or identifier.startswith("urn:"):
            return False
        # IPFS/IPLD CIDs start with 'ba' (base32) or 'Qm' (base58 v0)
        return identifier.startswith(("ba", "Qm")) and len(identifier) > 10

    def _fetch_export(self, cid: str) -> Optional[dict]:
        """Fetch the full OASF record via /v1/agents/{cid}/export."""
        try:
            with httpx.Client(timeout=self._timeout) as client:
                resp = client.get(
                    f"{self._base_url}/v1/agents/{cid}/export",
                    params={"format": "oasf"},
                )
                resp.raise_for_status()
                data = resp.json()
                # Export returns the bare OASF record
                if "agent" in data:
                    return {**data, "cid": cid}
                return {"agent": data, "cid": cid}
        except Exception as exc:
            logger.debug("Failed to export CID %s: %s", cid, exc)
            return None

    def _parse_oasf_record(self, record: dict, entry: dict) -> Optional[DirectoryAgentRecord]:
        """Parse a resolved OASF record into a DirectoryAgentRecord."""
        agent = record.get("agent", record)
        name: Optional[str] = agent.get("name") or entry.get("display_name")

        if not name:
            logger.debug(
                "Directory record '%s' skipped: no name",
                record.get("cid", entry.get("identifier", "<unknown>")),
            )
            return None

        # Check for MCP module first (preferred — directly callable)
        mcp_data = _extract_mcp_module(record)
        card = _extract_a2a_card(record)

        if mcp_data:
            # MCP-typed agent — extract endpoint from connections
            endpoint_info = _extract_mcp_endpoint(mcp_data)
            if endpoint_info:
                url, transport = endpoint_info
                mcp_tools = mcp_data.get("tools", [])
                return DirectoryAgentRecord(
                    name=name,
                    url=url,
                    a2a_card=card,  # May be None if only MCP module
                    capabilities=_extract_capabilities(record),
                    metadata=_extract_metadata(record),
                    protocol="mcp",
                    transport=transport,
                    mcp_tools=mcp_tools if mcp_tools else None,
                )
            else:
                logger.debug(
                    "Directory record '%s': MCP module present but no HTTP connection, falling through to A2A",
                    name,
                )

        # Fall back to A2A module
        if card:
            url = _extract_a2a_url(card)
            if not url:
                logger.debug(
                    "Directory record '%s' skipped: A2A card but no URL",
                    name,
                )
                return None
            return DirectoryAgentRecord(
                name=name,
                url=url,
                a2a_card={**card, "url": url},
                capabilities=_extract_capabilities(record),
                metadata=_extract_metadata(record),
                protocol="a2a",
                transport="http",
            )

        # Neither MCP nor A2A — skip
        logger.debug(
            "Directory record '%s' skipped: no integration/mcp or integration/a2a module",
            record.get("cid", entry.get("identifier", "<unknown>")),
        )
        return None
