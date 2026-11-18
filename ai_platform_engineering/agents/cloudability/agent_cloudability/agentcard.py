# Copyright 2025 CNOE Contributors
# SPDX-License-Identifier: Apache-2.0

from dotenv import load_dotenv

from a2a.types import AgentCapabilities, AgentCard, AgentSkill

load_dotenv()

AGENT_NAME = "cloudability"
AGENT_DESCRIPTION = (
    "An AI agent that provides Cloudability FinOps capabilities for cloud cost, "
    "budget, portfolio, and allocation analysis."
)

agent_skill = AgentSkill(
    id="cloudability_agent_skill",
    name="Cloudability FinOps",
    description=(
        "Queries Cloudability budgets, views, portfolio resources, and other "
        "Cloudability API endpoints for cloud cost analysis."
    ),
    tags=[
        "cloudability",
        "apptio",
        "finops",
        "cloud cost",
        "budgets",
        "portfolio",
    ],
    examples=[
        "Show current Cloudability budgets.",
        "List Cloudability views.",
        "Get EC2 portfolio data sorted by end date.",
        "Query Cloudability cost data with a filter.",
    ],
)

SUPPORTED_CONTENT_TYPES = ["text", "text/plain"]
capabilities = AgentCapabilities(streaming=True, pushNotifications=True)


def create_agent_card(agent_url):
    print("===================================")
    print(f"       {AGENT_NAME.upper()} AGENT CONFIG      ")
    print("===================================")
    print(f"AGENT_URL: {agent_url}")
    print("===================================")

    return AgentCard(
        name=AGENT_NAME,
        id=f"{AGENT_NAME.lower()}-tools-agent",
        description=AGENT_DESCRIPTION,
        url=agent_url,
        version="0.1.0",
        defaultInputModes=SUPPORTED_CONTENT_TYPES,
        defaultOutputModes=SUPPORTED_CONTENT_TYPES,
        capabilities=capabilities,
        skills=[agent_skill],
        security=[{"public": []}],
    )
