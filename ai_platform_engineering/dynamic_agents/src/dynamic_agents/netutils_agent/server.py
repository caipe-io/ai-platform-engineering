"""Thin A2A server that exposes the netutils MCP tools through a LangGraph agent."""

from __future__ import annotations

import logging
import os
import uuid
from contextlib import asynccontextmanager
from typing import Any

from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes
from a2a.server.tasks import InMemoryTaskStore
from a2a.types import AgentCapabilities, AgentCard, AgentInterface, AgentSkill, Message, Part, Role
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.prebuilt import create_react_agent

from dynamic_agents.services.llm_clients import get_llm

logger = logging.getLogger(__name__)
NETUTILS_MCP_URL = os.getenv("NETUTILS_MCP_URL", "http://mcp-netutils:8000/mcp")
AGENT_URL = os.getenv("NETUTILS_AGENT_URL", "http://netutils-agent:8120/")


class NetutilsExecutor(AgentExecutor):
    """Delegate A2A requests to the netutils LangGraph agent."""

    def __init__(self, agent: Any) -> None:
        self._agent = agent

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        result = await self._agent.ainvoke({"messages": [{"role": "user", "content": context.get_user_input()}]})
        messages = result.get("messages", [])
        content = messages[-1].content if messages else "Netutils agent returned no response."
        if isinstance(content, list):
            content = "\n".join(str(part.get("text", "")) for part in content if isinstance(part, dict))
        await event_queue.enqueue_event(
            Message(message_id=str(uuid.uuid4()), role=Role.ROLE_AGENT, parts=[Part(text=str(content))])
        )

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        logger.info("Ignoring cancellation for netutils task %s", context.task_id)


async def _health(_: Any) -> JSONResponse:
    return JSONResponse({"status": "healthy"})


def create_app(agent: Any | None = None, agent_url: str | None = None) -> FastAPI:
    """Create the A2A app; injection keeps the protocol contract test offline."""

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        active_url = agent_url or AGENT_URL
        if agent is not None:
            active_agent = agent
        else:
            mcp_client = MultiServerMCPClient(
                {"netutils": {"transport": "streamable_http", "url": NETUTILS_MCP_URL}},
                tool_name_prefix=True,
            )
            tools = await mcp_client.get_tools()
            if not tools:
                raise RuntimeError(f"No netutils MCP tools discovered at {NETUTILS_MCP_URL}")
            model = get_llm(os.getenv("LLM_PROVIDER", ""), "")
            active_agent = create_react_agent(model, tools)

        card = AgentCard(
            name="Netutils Agent",
            description="Network diagnostics, DNS lookup, and network utility tools.",
            version="1.0.0",
            capabilities=AgentCapabilities(streaming=False),
            default_input_modes=["text/plain"],
            default_output_modes=["text/plain"],
            skills=[
                AgentSkill(
                    id="netutils",
                    name="Network utilities",
                    description="Run network diagnostics and utility operations.",
                    tags=["network", "dns", "diagnostics"],
                    examples=["Resolve example.com", "Check whether port 443 is reachable on example.com"],
                )
            ],
            supported_interfaces=[AgentInterface(url=active_url, protocol_binding="JSONRPC", protocol_version="1.0")],
        )
        handler = DefaultRequestHandler(
            agent_executor=NetutilsExecutor(active_agent),
            task_store=InMemoryTaskStore(),
            agent_card=card,
        )
        app.state.agent_card = card
        app.state.request_handler = handler
        app.router.routes.extend(create_agent_card_routes(card))
        app.router.routes.extend(create_jsonrpc_routes(handler, rpc_url="/"))
        yield

    app = FastAPI(lifespan=lifespan)
    app.add_api_route("/healthz", _health, methods=["GET"])

    return app


app = create_app()
