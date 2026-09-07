"""Platform-wide Projects feature configuration."""

from __future__ import annotations

from pymongo.database import Database

from dynamic_agents.config import Settings

PLATFORM_CONFIG_ID = "platform_settings"


def projects_enabled(db: Database | None, settings: Settings) -> bool:
    """Return the admin override, falling back to deployment configuration."""

    if db is not None:
        document = db["platform_config"].find_one(
            {"_id": PLATFORM_CONFIG_ID},
            {"projects.enabled": 1},
        )
        projects = document.get("projects") if isinstance(document, dict) else None
        enabled = projects.get("enabled") if isinstance(projects, dict) else None
        if isinstance(enabled, bool):
            return enabled
    return settings.projects_enabled


def require_projects_enabled(db: Database | None, settings: Settings) -> None:
    """Raise the API-level disabled response without leaking stored Projects."""

    if not projects_enabled(db, settings):
        from fastapi import HTTPException

        raise HTTPException(status_code=404, detail="Projects are not enabled on this platform")
