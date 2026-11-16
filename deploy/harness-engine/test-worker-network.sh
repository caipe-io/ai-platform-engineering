#!/usr/bin/env bash
# Deterministic Docker boundary checks with a verified, test-only TLS endpoint.
set -euo pipefail
image=${1:?proxy image required}
probe=${2:-python:3.13-slim-bookworm}
name="worker-network-test-$$"
work=$(mktemp -d)
offset=$(( ($$ % 16) * 8 ))
fixture_ip="203.0.113.$((offset + 2))"
cleanup() {
  status=$?
  if [[ "$status" -ne 0 ]]; then
    docker logs "$name" >&2 2>/dev/null || true
    docker logs "$name-model" >&2 2>/dev/null || true
  fi
  docker rm -f "$name" "$name-model" >/dev/null 2>&1 || true
  docker network rm "$name" "$name-egress" >/dev/null 2>&1 || true
  rm -f "$work/domains" "$work/cert.pem" "$work/key.pem" "$work/tls.cnf" "$work/server.py"
  rmdir "$work"
}
trap cleanup EXIT
printf 'approved.example.test\nprivate.example.test\n169.254.169.254\n' > "$work/domains"
cat > "$work/tls.cnf" <<'CONF'
[req]
prompt = no
distinguished_name = subject
x509_extensions = extensions
[subject]
CN = approved.example.test
[extensions]
subjectAltName = DNS:approved.example.test
basicConstraints = critical,CA:TRUE
keyUsage = critical,digitalSignature,keyEncipherment,keyCertSign
extendedKeyUsage = serverAuth
CONF
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -config "$work/tls.cnf" \
  -keyout "$work/key.pem" -out "$work/cert.pem" >/dev/null 2>&1
chmod 644 "$work/domains" "$work/cert.pem"
cat > "$work/server.py" <<'PY'
import ssl
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        self.send_response(204)
        self.end_headers()
    def log_message(self, *_args: object) -> None:
        pass

server = HTTPServer(("0.0.0.0", 443), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain("/fixture/cert.pem", "/fixture/key.pem")
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
PY
# TEST-NET addresses belong only to this disposable fixture network.
docker network create --internal "$name" >/dev/null
docker network create --subnet "203.0.113.$offset/29" "$name-egress" >/dev/null
docker run --detach --init --name "$name-model" --network "$name-egress" --ip "$fixture_ip" \
  --user "$(id -u):$(id -g)" --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --sysctl net.ipv4.ip_unprivileged_port_start=0 --memory 128m --cpus 0.5 --pids-limit 32 \
  -v "$work:/fixture:ro" --entrypoint python "$probe" /fixture/server.py >/dev/null
docker run --detach --init --name "$name" --network "$name-egress" --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --memory 256m --cpus 0.5 --pids-limit 64 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m,mode=1777 \
  --add-host private.example.test:127.0.0.1 --add-host "approved.example.test:$fixture_ip" \
  -v "$work/domains:/etc/squid/allowed-domains.txt:ro" "$image" >/dev/null
docker network connect --alias worker-egress "$name" "$name"
docker run --rm -i --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 256m --cpus 1 --pids-limit 64 --network "$name" -e "FIXTURE_IP=$fixture_ip" \
  -v "$work/cert.pem:/fixture-cert.pem:ro" --entrypoint python "$probe" - <<'PY'
import os
import socket
import ssl
import time
import urllib.error
import urllib.request
from pathlib import Path

assert not any(line.split()[1] == "00000000" for line in Path("/proc/net/route").read_text().splitlines()[1:])
for attempt in range(50):
    try:
        with socket.create_connection(("worker-egress", 3128), timeout=1):
            break
    except OSError:
        time.sleep(0.1)
else:
    raise AssertionError("egress proxy did not become ready")
for host, port in (("1.1.1.1", 443), ("169.254.169.254", 80), (os.environ["FIXTURE_IP"], 443)):
    try:
        connection = socket.create_connection((host, port), timeout=2)
    except OSError:
        print(f"PASS direct route blocked: {host}:{port}")
    else:
        connection.close()
        raise AssertionError(f"direct network escaped: {host}")
context = ssl.create_default_context(cafile="/fixture-cert.pem")
assert context.check_hostname and context.verify_mode == ssl.CERT_REQUIRED
opener = urllib.request.build_opener(
    urllib.request.ProxyHandler({"https": "http://worker-egress:3128"}), urllib.request.HTTPSHandler(context=context),
)
for host in ("example.org", "169.254.169.254", "private.example.test"):
    try:
        opener.open(f"https://{host}/", timeout=10)
    except urllib.error.URLError as error:
        assert "403" in str(error), error
        print(f"PASS forbidden proxy destination: {host}")
    else:
        raise AssertionError(f"forbidden destination allowed: {host}")
with opener.open("https://approved.example.test/", timeout=10) as response:
    assert response.status == 204
print("PASS approved TLS fixture reached with certificate and hostname verification")
PY
