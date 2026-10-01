"""Health check endpoint."""

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import APIRouter

from autonomous_agents.services.scheduler import get_scheduler

router = APIRouter()


@router.get("/health")
async def health() -> dict:
    scheduler: AsyncIOScheduler = get_scheduler()
    return {
        "status": "ok",
        "scheduler": scheduler.state,
        "jobs": len(scheduler.get_jobs()),
    }
