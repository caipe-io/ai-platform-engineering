"""Authenticated tools for a currently admitted Harness Engine producer."""

from __future__ import annotations

import asyncio
import hmac
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request

from dynamic_agents.auth.token_context import current_user_token
from dynamic_agents.models import UserContext
from dynamic_agents.services.harness_resources import HarnessResourceService
from dynamic_agents.services.mongo import MongoDBService, get_mongo_service

router = APIRouter(prefix="/harness-resources", tags=["harness-resources"])


async def resource_service(
    request: Request,
    run_id: str,
    x_harness_producer: Annotated[str, Header(min_length=16, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")],
    mongo: MongoDBService = Depends(get_mongo_service),
) -> HarnessResourceService:
    claims = getattr(request.state, "verified_bearer_claims", None)
    bearer = current_user_token.get()
    authorization = request.headers.get("authorization", "")
    if not isinstance(claims, dict) or not bearer or not hmac.compare_digest(authorization, f"Bearer {bearer}"):
        raise HTTPException(401, "A middleware-verified user OBO bearer is required")
    subject = claims.get("sub")
    preferred = claims.get("preferred_username", "")
    if not isinstance(subject, str) or not subject or (isinstance(preferred, str) and preferred.startswith("service-account-")):
        raise HTTPException(403, "The admitted owner's user identity is required")
    email = claims.get("email")
    if not isinstance(email, str) or not email:
        if mongo._db is None:
            raise HTTPException(503, "Canonical identity storage is unavailable")
        user = await asyncio.to_thread(mongo._db.users.find_one, {"keycloak_sub": subject}, {"email": 1})
        email = (user or {}).get("email")
    if not isinstance(email, str) or not email:
        raise HTTPException(403, "The admitted user has no canonical platform identity")
    context = UserContext(email=email, name=claims.get("name"), sub=subject)
    return HarnessResourceService(mongo, run_id, subject, x_harness_producer, context)


@router.get("/{run_id}")
async def platform_catalog(service: HarnessResourceService = Depends(resource_service)) -> dict:
    return await service.catalog()


@router.post("/{run_id}/calls/{request_id}")
async def platform_call(request_id: str, service: HarnessResourceService = Depends(resource_service)) -> dict:
    # Tool name, arguments and human decisions come exclusively from the
    # already admitted canonical request/run documents, never this HTTP body.
    return await service.call(request_id)
