#!/usr/bin/env bash
set -euo pipefail
image=${1:?image reference required}
target=${2:?image target required}
restrictions=(--rm --init --read-only --cap-drop ALL --security-opt no-new-privileges:true
  --pids-limit 128 --memory 1g --cpus 1 --network none
  --tmpfs "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777")
if [[ "$target" == worker-egress ]]; then
  domains=$(mktemp)
  trap 'rm -f "$domains"' EXIT
  printf 'api.example.com\n' > "$domains"
  chmod 644 "$domains"
  docker run "${restrictions[@]}" -v "$domains:/etc/squid/allowed-domains.txt:ro" \
    "$image" squid -k parse -f /etc/squid/squid.conf
  exit
fi
uid=65532
if [[ "$target" == harness-engine-deep ]]; then uid=1001; fi
restrictions+=(--tmpfs "/workspace:rw,nosuid,nodev,size=64m,uid=$uid,gid=$uid,mode=700")
docker run "${restrictions[@]}" --entrypoint python "$image" -c '
import os
from pathlib import Path
from harness_engine.config import Settings
assert os.geteuid() != 0
assert os.statvfs("/").f_flag & os.ST_RDONLY
status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines())
assert int(status["CapEff"].strip(), 16) == 0
assert status["NoNewPrivs"].strip() == "1"
assert Settings().port == 8010
Path("/workspace/smoke").write_text("writable workspace")
try:
    Path("/app/forbidden").touch()
except OSError:
    pass
else:
    raise AssertionError("application root is writable")
import harness_engine.main
import harness_engine.claude_worker
'
if [[ "$target" == harness-engine-deep ]]; then
  docker run "${restrictions[@]}" --entrypoint python "$image" -c 'import dynamic_agents.main'
fi
if [[ "$target" == claude-cli-acp-worker ]]; then
  docker run "${restrictions[@]}" --entrypoint claude "$image" --version
  # Test the actual kernel policy and CLI/MCP path on each native build runner.
  # Requires Landlock ABI 6; unsupported hosts must fail rather than skip.
  tests_dir=$(cd "$(dirname "$0")/../../ai_platform_engineering/harness_engine/tests" && pwd)
  for test in claude_isolation_linux.py claude_isolation_integration.py; do
    docker run "${restrictions[@]}" -v "$tests_dir:/tests:ro" --entrypoint python "$image" "/tests/$test"
  done
fi
if [[ "$target" == claude-cli-acp-worker || "$target" == claude-acp-worker ]]; then
  docker run "${restrictions[@]}" -i --entrypoint python "$image" - <<'PY'
import asyncio
import os
from pathlib import Path
from harness_engine.adapters.claude_acp import ACPEventClient
from harness_engine.claude_acp_process import managed_acp_process
from harness_engine.config import Settings

async def main() -> None:
    async with managed_acp_process(
        ACPEventClient(), Settings().claude_acp_command,
        env={"PATH": os.environ["PATH"], "HOME": "/workspace", "PYTHONPATH": "/app/src"},
        cwd=Path("/workspace"), run_id="startup-check",
    ) as connection:
        assert (await connection.initialize(protocol_version=1)).protocol_version == 1

asyncio.run(main())
PY
fi
