"""Authorized branching of autonomous runs into private interactive chats."""

import asyncio

from fastapi import APIRouter, Depends, HTTPException

from dynamic_agents.auth.auth import UserContext, get_user_context
from dynamic_agents.auth.authz import require_agent_use_permission, require_autonomous_permission
from dynamic_agents.config import get_settings
from dynamic_agents.services.autonomous_follow_up import create_follow_up_chat
from dynamic_agents.services.mongo import MongoDBService, get_mongo_service

router = APIRouter(prefix="/autonomous", tags=["conversations"])


def _owned_task(mongo: MongoDBService, task_id: str, user: UserContext) -> dict:
    if mongo._db is None:
        raise HTTPException(503, "Database not connected")
    task = mongo._db[get_settings().autonomous_tasks_collection].find_one({"_id": task_id})
    if not task:
        raise HTTPException(404, "Task not found")
    if not user.is_admin and (task.get("owner_id") or "").lower() != user.email.lower():
        raise HTTPException(403, "Access denied")
    return task


@router.get("/tasks/{task_id}/follow-up-chats")
async def list_follow_up_chats(
    task_id: str,
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
) -> dict[str, str]:
    await require_autonomous_permission()
    _owned_task(mongo, task_id, user)
    records = list(mongo._db["autonomous_follow_up_chats"].find({
        "task_id": task_id, "owner_id": user.email.strip().lower(), "state": "ready",
    }))
    if not records:
        return {}
    # Do not link to deleted chats, or to a branch whose publication was
    # interrupted. The create endpoint can finish publishing the latter.
    visible_ids = {chat["_id"] for chat in mongo._db["conversations"].find({
        "_id": {"$in": [record["conversation"]["_id"] for record in records]},
        "deleted_at": None,
    }, {"_id": 1})}
    return {
        record["run_id"]: record["conversation"]["_id"]
        for record in records if record["conversation"]["_id"] in visible_ids
    }


@router.post("/tasks/{task_id}/runs/{run_id}/follow-up-chat")
async def open_follow_up_chat(
    task_id: str,
    run_id: str,
    user: UserContext = Depends(get_user_context),
    mongo: MongoDBService = Depends(get_mongo_service),
) -> dict:
    await require_autonomous_permission()
    task = _owned_task(mongo, task_id, user)
    run = mongo._db[get_settings().autonomous_runs_collection].find_one({"_id": run_id, "task_id": task_id})
    if not run:
        raise HTTPException(404, "Run not found")
    if not user.is_admin and (run.get("owner_id") or "").lower() != user.email.lower():
        raise HTTPException(403, "Access denied")
    if run.get("status") not in {"success", "failed"} or not run.get("finished_at"):
        raise HTTPException(409, "Wait for this run to finish before continuing it.")
    if not run.get("execution_context_id"):
        raise HTTPException(409, "This run has no saved execution context.")
    agent_id = task.get("dynamic_agent_id")
    if not agent_id:
        raise HTTPException(409, "This task has no dynamic agent.")
    await require_agent_use_permission(agent_id)
    agent = mongo.get_agent(agent_id)
    if not agent or not agent.enabled:
        raise HTTPException(409, "This agent is no longer available.")
    return await asyncio.to_thread(create_follow_up_chat, mongo, get_settings(), task, run, agent, user)
