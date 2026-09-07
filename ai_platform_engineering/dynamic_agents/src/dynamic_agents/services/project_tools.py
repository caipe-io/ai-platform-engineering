"""Model-visible Project catalog and bounded Project chat-history tools."""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any

from langchain_core.tools import tool
from pymongo.database import Database

from dynamic_agents.services.gridfs_store import MongoDBGridFSStore
from dynamic_agents.services.projects import (
    InvalidProjectNameError,
    ProjectAlreadyExistsError,
    create_project,
    list_projects,
)

_MAX_LIMIT = 50
_MAX_TRANSCRIPT_CHARS = 60_000


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def _limit(value: int) -> int:
    return max(1, min(int(value), _MAX_LIMIT))


def _offset(cursor: str | None) -> int:
    try:
        return max(0, int(cursor or "0"))
    except ValueError:
        return 0


def _iso(value: Any) -> str | None:
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value) if value is not None else None


def _conversation_agent(doc: dict, db: Database) -> tuple[str | None, str | None]:
    participant = next(
        (item for item in doc.get("participants", []) if isinstance(item, dict) and item.get("type") == "agent"),
        {},
    )
    agent_id = participant.get("id")
    if not agent_id:
        return None, None
    agent = db["dynamic_agents"].find_one({"_id": agent_id}, {"name": 1}) or {}
    return str(agent_id), str(agent.get("name") or agent_id)


def _chat_item(doc: dict, db: Database) -> dict[str, Any]:
    agent_id, agent_name = _conversation_agent(doc, db)
    return {
        "conversation_id": str(doc.get("_id")),
        "title": str(doc.get("title") or "Untitled chat"),
        "agent_id": agent_id,
        "agent_name": agent_name,
        "created_at": _iso(doc.get("created_at")),
        "updated_at": _iso(doc.get("updated_at")),
    }


def create_project_tools(
    *,
    store: MongoDBGridFSStore,
    owner_subject: str,
    db: Database,
    project_id: str | None,
    allow_create: bool = False,
) -> list:
    """Create tools whose owner and active Project are closure-bound by runtime."""

    @tool
    def list_projects_tool() -> str:
        """List this user's Projects by immutable ID and display name."""

        items = [project.as_dict() for project in list_projects(store, owner_subject)]
        return _json({"items": items, "actions": [{"type": "start_project_chat", **item} for item in items]})

    list_projects_tool.name = "list_projects"

    @tool
    def create_project_tool(name: str) -> str:
        """Create a named Project after checking list_projects for a suitable existing one."""

        try:
            project = create_project(store, owner_subject, name)
            return _json(
                {
                    "status": "created",
                    "project": project.as_dict(),
                    "action": {"type": "start_project_chat", **project.as_dict()},
                }
            )
        except ProjectAlreadyExistsError as exc:
            return _json(
                {
                    "status": "already_exists",
                    "project": exc.project.as_dict(),
                    "action": {"type": "start_project_chat", **exc.project.as_dict()},
                }
            )
        except InvalidProjectNameError as exc:
            return _json({"status": "invalid", "error": str(exc)})

    create_project_tool.name = "create_project"
    tools = [list_projects_tool]
    if allow_create:
        tools.append(create_project_tool)
    if project_id is None:
        return tools

    scope_filter = {"owner_subject": owner_subject, "metadata.project_id": project_id}

    @tool
    def list_project_chats(limit: int = 20, cursor: str | None = None) -> str:
        """List metadata for this user's chats in the active Project; use cursor to paginate."""

        page_size = _limit(limit)
        offset = _offset(cursor)
        docs = list(
            db["conversations"]
            .find(scope_filter)
            .sort("updated_at", -1)
            .skip(offset)
            .limit(page_size + 1)
        )
        has_more = len(docs) > page_size
        items = [_chat_item(doc, db) for doc in docs[:page_size]]
        return _json({"items": items, "next_cursor": str(offset + page_size) if has_more else None})

    @tool
    def search_project_chats(query: str, limit: int = 20, cursor: str | None = None) -> str:
        """Search titles and user/assistant message text in the active Project's chats."""

        term = query.strip()
        if not term:
            return _json({"items": [], "next_cursor": None})
        pattern = re.compile(re.escape(term), re.IGNORECASE)
        conversation_docs = list(db["conversations"].find(scope_filter))
        by_id = {str(doc["_id"]): doc for doc in conversation_docs}
        matched = {cid for cid, doc in by_id.items() if pattern.search(str(doc.get("title") or ""))}
        if by_id:
            for message in db["messages"].find(
                {
                    "conversation_id": {"$in": list(by_id)},
                    "role": {"$in": ["user", "assistant"]},
                    "content": pattern,
                },
                {"conversation_id": 1},
            ):
                matched.add(str(message.get("conversation_id")))
        ordered = sorted(
            (by_id[cid] for cid in matched if cid in by_id),
            key=lambda doc: _iso(doc.get("updated_at")) or "",
            reverse=True,
        )
        page_size = _limit(limit)
        offset = _offset(cursor)
        page = ordered[offset : offset + page_size]
        return _json(
            {
                "items": [_chat_item(doc, db) for doc in page],
                "next_cursor": str(offset + page_size) if offset + page_size < len(ordered) else None,
            }
        )

    @tool
    def read_project_chat(conversation_id: str, offset: int = 0, limit: int = 50) -> str:
        """Read bounded user/assistant transcript messages from one chat in the active Project."""

        conversation = db["conversations"].find_one({**scope_filter, "_id": conversation_id})
        if conversation is None:
            return _json({"error": "Project chat not found"})
        page_size = _limit(limit)
        safe_offset = max(0, int(offset))
        docs = list(
            db["messages"]
            .find(
                {"conversation_id": conversation_id, "role": {"$in": ["user", "assistant"]}},
                {"role": 1, "content": 1, "created_at": 1},
            )
            .sort("created_at", 1)
            .skip(safe_offset)
            .limit(page_size + 1)
        )
        has_more = len(docs) > page_size
        messages: list[dict[str, Any]] = []
        used = 0
        for item in docs[:page_size]:
            content = str(item.get("content") or "")
            remaining = _MAX_TRANSCRIPT_CHARS - used
            if remaining <= 0:
                has_more = True
                break
            content = content[:remaining]
            used += len(content)
            messages.append(
                {"role": item.get("role"), "content": content, "created_at": _iso(item.get("created_at"))}
            )
        return _json(
            {
                "conversation": _chat_item(conversation, db),
                "messages": messages,
                "next_offset": safe_offset + len(messages) if has_more else None,
            }
        )

    tools.extend([list_project_chats, search_project_chats, read_project_chat])
    return tools
