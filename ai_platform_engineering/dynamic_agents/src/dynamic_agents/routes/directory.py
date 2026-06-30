# Copyright 2025 CNOE Contributors
# SPDX-License-Identifier: Apache-2.0

"""Directory sync API endpoints.

Exposes status and manual trigger for AGNTCY Directory synchronization.
"""

import logging

from fastapi import APIRouter, Depends

from dynamic_agents.auth.auth import UserContext, get_user_context, require_admin
from dynamic_agents.services.directory_sync import get_directory_sync

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/directory", tags=["directory"])


@router.get("/status")
async def directory_status(_user: UserContext = Depends(get_user_context)):
    """Get the current status of Directory sync."""
    sync = get_directory_sync()
    if sync is None:
        return {"enabled": False, "message": "Directory sync is disabled (DIRECTORY_ENABLED != true)"}
    return sync.status


@router.post("/sync")
async def directory_sync_now(_user: UserContext = Depends(require_admin)):
    """Trigger an immediate Directory sync. Requires admin role.

    Returns a summary of what was synced.
    """
    sync = get_directory_sync()
    if sync is None:
        return {"enabled": False, "message": "Directory sync is disabled (DIRECTORY_ENABLED != true)"}

    result = await sync.sync_once()
    return {"success": True, **result}
