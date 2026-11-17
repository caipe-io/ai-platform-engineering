"""Adapt the shared A2A transport to Deep Agents' public subagent interface."""

import logging

from deepagents import CompiledSubAgent
from langchain_core.messages import AIMessage
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, MessagesState, StateGraph

from dynamic_agents.services.remote_agent_tool import RemoteAgentTool

logger = logging.getLogger(__name__)


def create_remote_agent_subagent(transport: RemoteAgentTool) -> CompiledSubAgent:
    """Delegate one isolated task without an extra model or protocol stack.

    LangChain owns task selection, isolated state, tracing and graph events.
    Authentication, deadlines and destination/size limits use the same A2A
    transport as existing agents. No caller token enters graph state.
    """

    async def delegate(state: MessagesState) -> dict[str, list[AIMessage]]:
        message = state["messages"][-1]
        writer = get_stream_writer()
        try:
            result = await transport.invoke_agent(
                message.text,
                lambda text: writer({"type": "remote_agent_output", "result": text}),
                require_completed=True,
            )
        except Exception as exc:
            # A parent tool-retry middleware must not blindly resubmit a remote
            # command whose outcome is unknown. Cancellation still propagates.
            logger.warning("Remote subagent %s failed (%s)", transport.name, type(exc).__name__)
            result = f"ERROR: Remote agent execution failed ({type(exc).__name__}); do not automatically retry."

        return {"messages": [AIMessage(content=result)]}

    name = f"remote_{(transport.metadata or {}).get('remote_agent_id', transport.name)}"
    graph = StateGraph(MessagesState)
    graph.add_node("delegate", delegate)
    graph.add_edge(START, "delegate")
    graph.add_edge("delegate", END)
    return {"name": name, "description": transport.description, "runnable": graph.compile(name=name)}
