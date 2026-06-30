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
        a2a_card: dict,
        capabilities: list[str],
        metadata: dict,
    ) -> None:
        self.name = name
        self.url = url
        self.a2a_card = a2a_card
        self.capabilities = capabilities
        self.metadata = metadata

    @property
    def directory_id(self) -> str:
        """Stable ID for this record, derived from CID or name."""
        return self.metadata.get("directory_cid", f"dir-{self.name}")


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
        Fetch agent records from Directory.

        Returns a list of DirectoryAgentRecord instances containing the parsed
        agent data with capabilities and metadata.
        """
        try:
            params: dict = {}
            if self._label_filter:
                params["labels"] = self._label_filter
            with httpx.Client(timeout=self._timeout) as client:
                resp = client.get(f"{self._base_url}/v1/agents", params=params)
                resp.raise_for_status()
                payload = resp.json()
        except Exception as exc:
            logger.warning("Directory fetch failed (%s): %s", self._base_url, exc)
            return []

        items = payload if isinstance(payload, list) else payload.get("agents", [])
        results: list[DirectoryAgentRecord] = []
        for record in items:
            agent = record.get("agent", record)
            name: Optional[str] = agent.get("name")
            card = _extract_a2a_card(record)

            if not card:
                logger.debug(
                    "Directory record '%s' skipped: no integration/a2a module",
                    record.get("cid", "<unknown>"),
                )
                continue

            url = _extract_a2a_url(card)
            if not name or not url:
                logger.debug(
                    "Directory record '%s' skipped: name=%s url=%s",
                    record.get("cid", "<unknown>"),
                    name,
                    url,
                )
                continue

            results.append(
                DirectoryAgentRecord(
                    name=name,
                    url=url,
                    a2a_card={**card, "url": url},
                    capabilities=_extract_capabilities(record),
                    metadata=_extract_metadata(record),
                )
            )

        logger.info(
            "Directory discovery: %d agents with A2A integration from %s",
            len(results),
            self._base_url,
        )
        return results
