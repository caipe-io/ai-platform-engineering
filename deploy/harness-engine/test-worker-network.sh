#!/usr/bin/env bash
# Live Docker boundary checks; no model credentials or inference are used.
set -euo pipefail
image=${1:?proxy image required}
probe=${2:-python:3.13-slim-bookworm}
name="worker-network-test-$$"
work=$(mktemp -d)
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
  rm -f "$work/domains"
  rmdir "$work"
}
trap cleanup EXIT
printf 'api.anthropic.com\nprivate.example.test\n169.254.169.254\n' > "$work/domains"
chmod 644 "$work/domains"
docker network create --internal "$name" >/dev/null
docker run --detach --init --name "$name" --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --memory 256m --cpus 0.5 --pids-limit 64 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m,mode=1777 \
  --add-host private.example.test:127.0.0.1 \
  -v "$work/domains:/etc/squid/allowed-domains.txt:ro" "$image" >/dev/null
docker network connect --alias worker-egress "$name" "$name"
docker run --rm -i --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 256m --cpus 1 --pids-limit 64 --network "$name" \
  --entrypoint python "$probe" - <<'PY'
import socket
import time
import urllib.error
import urllib.request

for attempt in range(50):
    try:
        with socket.create_connection(("worker-egress", 3128), timeout=1):
            break
    except OSError:
        time.sleep(0.1)
else:
    raise AssertionError("egress proxy did not become ready")
for host in ("1.1.1.1", "169.254.169.254"):
    try:
        connection = socket.create_connection((host, 443), timeout=2)
    except OSError:
        print(f"PASS direct route blocked: {host}")
    else:
        connection.close()
        raise AssertionError(f"direct network escaped: {host}")
opener = urllib.request.build_opener(urllib.request.ProxyHandler({"https": "http://worker-egress:3128"}))
for host in ("example.org", "169.254.169.254", "private.example.test"):
    try:
        opener.open(f"https://{host}/", timeout=10)
    except urllib.error.URLError as error:
        assert "403" in str(error), error
        print(f"PASS forbidden proxy destination: {host}")
    else:
        raise AssertionError(f"forbidden destination allowed: {host}")
for attempt in range(3):
    try:
        with opener.open("https://api.anthropic.com/v1/models", timeout=20) as response:
            assert 200 <= response.status < 600
        break
    except urllib.error.HTTPError as response:
        # An authenticated TLS response proves connectivity; no model key is sent.
        assert 400 <= response.code < 600
        break
    except urllib.error.URLError as error:
        # Retry only transport timeouts on this read-only probe. Policy denials
        # and certificate failures remain immediate failures.
        if not isinstance(error.reason, TimeoutError) or attempt == 2:
            raise
        time.sleep(attempt + 1)
print("PASS approved model host reached over TLS without credentials")
PY
