"""Render the release overlays against inherited source-build configuration."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    with TemporaryDirectory() as directory:
        temporary = Path(directory)
        base = temporary / "compose.yaml"
        base.write_text("services:\n" + "".join(
            f"  {name}:\n    image: registry.example.test/{name}:test\n    build:\n      context: .\n"
            for name in ("harness-engine", "dynamic-agents", "caipe-ui", "caipe-mongodb")
        ))
        envfile = temporary / "env"
        envfile.touch()
        domains = temporary / "domains"
        domains.write_text("api.example.com\n")
        environment = {**os.environ, "COMPOSE_PROFILES": "harness-engine", "HARNESS_IMAGE_TAG": "test",
                       "HARNESS_ENGINE_INTERNAL_TOKEN": "test-private-control-token",
                       "CLAUDE_WORKER_ALLOWED_DOMAINS_FILE": str(domains)}
        for key in ("HARNESS_ENGINE_CLAUDE_SDK_PROFILES_JSON", "HARNESS_ENGINE_CLAUDE_WORKER_PROFILES_JSON",
                    "CLAUDE_ACP_PROFILES_JSON", "CLAUDE_CLI_ACP_PROFILES_JSON"):
            environment[key] = "{}"
        for key in ("CLAUDE_WORKER_INTERNAL_TOKEN", "CLAUDE_ACP_WORKER_INTERNAL_TOKEN", "CLAUDE_CLI_ACP_WORKER_INTERNAL_TOKEN"):
            environment[key] = "test-private-worker-token"
        combinations = [("claude-sdk",), ("claude-acp",), ("claude-cli-acp",),
                        ("claude-sdk", "claude-acp", "claude-cli-acp")]
        for combination in combinations:
            command = ["docker", "compose", "--project-directory", str(ROOT), "--env-file", str(envfile),
                       "-f", str(base), "-f", str(ROOT / "deploy/harness-engine/compose.deep-agents.yaml")]
            for worker in combination:
                command.extend(["-f", str(ROOT / f"deploy/harness-engine/compose.{worker}.yaml")])
            result = subprocess.run(command + ["config", "--no-env-resolution", "--format", "json"],
                                    env=environment, capture_output=True, text=True, check=True)
            rendered = json.loads(result.stdout)
            assert rendered["networks"]["harness-workers"]["internal"] is True
            for name in ["harness-engine", "dynamic-agents", "caipe-ui", "worker-egress"] + [w + "-worker" for w in combination]:
                service = rendered["services"][name]
                assert not service.get("build"), f"Unexpected source build: {name}"
                assert service["pull_policy"] == "always", name
            for worker in combination:
                service = rendered["services"][worker + "-worker"]
                assert service["read_only"] and service["cap_drop"] == ["ALL"]
                assert service["pids_limit"] == 256 and not service.get("ports")
                assert set(service["networks"]) == {"harness-workers"}
                assert service["environment"]["AWS_EC2_METADATA_DISABLED"] == "true"
            print("PASS Compose inheritance and worker boundary:", ",".join(combination))


if __name__ == "__main__":
    main()
