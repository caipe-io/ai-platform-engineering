"""Developer startup must stop before user provisioning if either init fails."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.parametrize("failed_service", ["keycloak-init", "openfga-init", ""])
def test_dev_startup_checks_each_init_exit_status(tmp_path: Path, failed_service: str) -> None:
    make = shutil.which("make")
    if not make:
        pytest.skip("make is unavailable")
    command_log = tmp_path / "commands.jsonl"
    compose = tmp_path / "compose"
    compose.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys\n"
        "from pathlib import Path\n"
        "with Path(os.environ['DEV_AUTH_COMMAND_LOG']).open('a') as output:\n"
        "    output.write(json.dumps(['compose', *sys.argv[1:]]) + '\\n')\n"
        # Model Compose's last reported status when multiple services are waited on.
        "if sys.argv[1] == 'wait':\n"
        "    sys.exit(1 if sys.argv[-1] == os.environ['DEV_AUTH_FAILED_SERVICE'] else 0)\n"
    )
    compose.chmod(0o755)
    python = tmp_path / "python3"
    python.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys\n"
        "from pathlib import Path\n"
        "with Path(os.environ['DEV_AUTH_COMMAND_LOG']).open('a') as output:\n"
        "    output.write(json.dumps(['python', *sys.argv[1:]]) + '\\n')\n"
    )
    python.chmod(0o755)
    env = {
        **os.environ,
        "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
        "DEV_AUTH_COMMAND_LOG": str(command_log),
        "DEV_AUTH_FAILED_SERVICE": failed_service,
    }
    result = subprocess.run(
        [make, "--no-print-directory", "dev-auth-up", f"DEV_AUTH_COMPOSE={compose}", "DOCKER_COMPOSE_BUILD_ENV="],
        cwd=Path(__file__).resolve().parents[1], env=env, capture_output=True, text=True, timeout=15,
    )
    commands = [json.loads(line) for line in command_log.read_text().splitlines()]
    users_started = any(command[0] == "python" for command in commands)
    ui_started = any(command[0] == "compose" and "up" in command and "caipe-ui" in command for command in commands)
    if failed_service:
        assert result.returncode != 0
        assert not users_started
        assert not ui_started
    else:
        assert result.returncode == 0, result.stderr
        assert users_started
        assert ui_started
