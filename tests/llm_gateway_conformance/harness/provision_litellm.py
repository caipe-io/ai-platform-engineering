"""Create the test teams and per-agent keys in a local LiteLLM OSS proxy, acting as the operator.

Prints ``export LLM_GW_CONFORMANCE_*=...`` lines for the conformance suite. Local use only.

Usage: python provision_litellm.py http://localhost:4000 "$LITELLM_MASTER_KEY"
"""

import sys
import uuid
from typing import Any

import httpx

TINY_BUDGET = 0.001  # One mock call costs more; LiteLLM ignores a team max_budget of 0.


def main(base_url: str, master_key: str) -> None:
    run = uuid.uuid4().hex[:8]  # Aliases are unique in LiteLLM; keep reruns independent.
    with httpx.Client(base_url=base_url.rstrip("/"), headers={"Authorization": f"Bearer {master_key}"}, timeout=30.0) as admin:

        def post(path: str, body: dict[str, Any]) -> dict[str, Any]:
            response = admin.post(path, json=body)
            response.raise_for_status()
            return response.json()

        def team(alias: str, **limits: float) -> str:
            return post("/team/new", {"team_alias": f"{alias}-{run}", **limits})["team_id"]

        def agent_key(alias: str, team_id: str, **limits: float) -> str:
            return post("/key/generate", {"key_alias": f"{alias}-{run}", "team_id": team_id, "metadata": {"agent_id": alias}, **limits})["key"]

        team_ok = team("conformance-team")
        team_spent = team("conformance-team-limited", max_budget=TINY_BUDGET)
        revoked = agent_key("conformance-agent-revoked", team_ok)
        post("/key/delete", {"keys": [revoked]})
        values = {
            "KEY": agent_key("conformance-agent", team_ok),
            "REVOKED_KEY": revoked,
            "AGENT_LIMIT_KEY": agent_key("conformance-agent-limited", team_ok, max_budget=TINY_BUDGET),
            "TEAM_LIMIT_KEY": agent_key("conformance-agent-in-limited-team", team_spent),
        }
    for name, value in values.items():
        print(f"export LLM_GW_CONFORMANCE_{name}={value}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
