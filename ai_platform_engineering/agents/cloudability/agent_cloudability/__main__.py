# Copyright 2025 CNOE
# SPDX-License-Identifier: Apache-2.0

# ruff: noqa: E402

from cnoe_agent_utils.tracing import disable_a2a_tracing

disable_a2a_tracing()

import asyncio
import logging
import os

import click
import httpx
import uvicorn
from agntcy_app_sdk.factory import AgntcyFactory
from dotenv import load_dotenv

from a2a.server.apps import A2AStarletteApplication
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.tasks import (
    BasePushNotificationSender,
    InMemoryPushNotificationConfigStore,
    InMemoryTaskStore,
)
from agent_cloudability.agentcard import create_agent_card
from agent_cloudability.protocol_bindings.a2a_server.agent_executor import (
    CloudabilityAgentExecutor,
)
from ai_platform_engineering.utils.metrics import PrometheusMetricsMiddleware
from starlette.middleware.cors import CORSMiddleware

load_dotenv()

A2A_TRANSPORT = os.getenv("A2A_TRANSPORT", "p2p").lower()
SLIM_ENDPOINT = os.getenv("SLIM_ENDPOINT", "http://slim-dataplane:46357")
METRICS_ENABLED = os.getenv("METRICS_ENABLED", "false").lower() == "true"


@click.command()
@click.option("--host", "host", default="localhost")
@click.option("--port", "port", default=10000)
def main(host: str, port: int):
    asyncio.run(async_main(host, port))


async def async_main(host: str, port: int):
    client = httpx.AsyncClient()
    push_config_store = InMemoryPushNotificationConfigStore()
    push_sender = BasePushNotificationSender(
        httpx_client=client,
        config_store=push_config_store,
    )
    request_handler = DefaultRequestHandler(
        agent_executor=CloudabilityAgentExecutor(),
        task_store=InMemoryTaskStore(),
        push_config_store=push_config_store,
        push_sender=push_sender,
    )

    agent_url = SLIM_ENDPOINT if A2A_TRANSPORT == "slim" else f"http://{host}:{port}"

    server = A2AStarletteApplication(
        agent_card=create_agent_card(agent_url),
        http_handler=request_handler,
    )

    if A2A_TRANSPORT == "slim":
        print("Running A2A server in SLIM mode.")
        factory = AgntcyFactory()
        transport = factory.create_transport("SLIM", endpoint=agent_url)
        bridge = factory.create_bridge(server, transport=transport)
        await bridge.start(blocking=True)
        return

    print("Running A2A server in p2p mode.")
    app = server.build()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    if METRICS_ENABLED:
        app.add_middleware(
            PrometheusMetricsMiddleware,
            excluded_paths=[
                "/.well-known/agent.json",
                "/.well-known/agent-card.json",
                "/health",
                "/ready",
            ],
            metrics_path="/metrics",
            agent_name="cloudability",
        )

    access_logger = logging.getLogger("uvicorn.access")
    access_logger.setLevel(logging.DEBUG)

    config = uvicorn.Config(app, host=host, port=port, access_log=True)
    uvicorn_server = uvicorn.Server(config=config)
    await uvicorn_server.serve()


if __name__ == "__main__":
    main()
