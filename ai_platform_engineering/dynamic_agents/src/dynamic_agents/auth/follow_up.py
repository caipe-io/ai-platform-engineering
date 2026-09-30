"""Bearer-bound identity for private autonomous follow-up copies."""

import asyncio

from fastapi import Depends, HTTPException, Request
from pymongo.errors import PyMongoError

from dynamic_agents.models import UserContext
from dynamic_agents.services.mongo import MongoDBService, get_mongo_service


async def get_follow_up_user(
    request: Request,
    mongo: MongoDBService = Depends(get_mongo_service),
) -> UserContext:
    """Never use X-User-Context identity or privileges for copying private data."""
    claims = getattr(request.state, "verified_bearer_claims", None)
    if not claims or not isinstance(claims.get("sub"), str) or not claims["sub"].strip():
        raise HTTPException(401, "A verified user bearer is required.")
    if str(claims.get("preferred_username", "")).startswith("service-account-"):
        raise HTTPException(403, "Manual follow-ups require an interactive user.")

    email = claims.get("email")
    if not isinstance(email, str) or not email.strip():
        # Some user tokens omit email. Resolve only by the verified subject,
        # using the same directory fields as the UI's user-identity-directory.
        if mongo._db is None:
            raise HTTPException(503, "Database not connected")
        try:
            rows = await asyncio.to_thread(lambda: list(mongo._db["users"].find({"$or": [
                {"keycloak_sub": claims["sub"]}, {"metadata.keycloak_sub": claims["sub"]},
            ]}, {"email": 1, "keycloak_sub": 1, "metadata.keycloak_sub": 1}).limit(2)))
        except PyMongoError as exc:
            raise HTTPException(503, "User identity lookup unavailable.") from exc
        if len(rows) != 1:
            raise HTTPException(403, "Cannot resolve the verified user's identity.")
        row = rows[0]
        if (row.get("keycloak_sub") or row.get("metadata", {}).get("keycloak_sub")) != claims["sub"]:
            raise HTTPException(403, "Cannot resolve the verified user's identity.")
        email = row.get("email")
    if not isinstance(email, str) or not email.strip():
        raise HTTPException(403, "The verified user has no email identity.")
    return UserContext(email=email.strip().lower(), sub=claims["sub"])
