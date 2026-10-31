"""Smoke-test canonical Compose services in an isolated, disposable CI checkout."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable


ROOT = Path(__file__).resolve().parents[3]
MINIMAL = "mcp-servers,caipe-ui-prod,rbac,dynamic-agents,rag,caipe-mongodb,web_ingestor"
AUTH = ["keycloak", "keycloak-init", "openfga", "openfga-init"]
LANES = {
    "platform": ("caipe-ui-prod,rbac,caipe-mongodb,dynamic-agents,autonomous-agents", [
        "caipe-mongodb", "audit-service", "dynamic-agents", "autonomous-agents",
        *AUTH, "keycloak-init-token-exchange", "openfga-authz-bridge",
        "agentgateway-config-bridge", "agentgateway",
    ]),
    "rag": ("rag,web_ingestor,rbac", [
        *AUTH, "audit-service", "rag-redis", "etcd", "milvus-minio",
        "milvus-standalone", "rag-server", "web_ingestor",
    ]),
    "graph": ("graph_rag", ["neo4j"]),
    "tracing": ("tracing", ["langfuse-web", "langfuse-worker"]),
}
ONESHOTS = {"keycloak-init", "keycloak-init-token-exchange", "openfga-init", "openfga-migrate"}


def command(args: list[str], *, check: bool = True) -> str:
    result = subprocess.run(args, cwd=ROOT, text=True, stdout=subprocess.PIPE, check=False, timeout=2400)
    if check and result.returncode:
        raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(args)}\n{result.stdout}")
    return result.stdout


class OOMKilledError(RuntimeError):
    """A container was OOM-killed; retrying cannot recover it."""


def eventually(check: Callable[[], object], label: str, timeout: int = 300) -> object:
    deadline = time.monotonic() + timeout
    error = None
    while time.monotonic() < deadline:
        try:
            result = check()
            if result:
                print(f"PASS: {label}", flush=True)
                return result
        except OOMKilledError:
            raise
        # A starting service can return HTML or a partial payload; keep polling.
        except (RuntimeError, urllib.error.URLError, TimeoutError, ConnectionError, ValueError, KeyError) as exc:
            error = exc
        time.sleep(3)
    raise RuntimeError(f"Timed out: {label}; last error: {error}")


class Smoke:
    def __init__(self, file: str, lane: str) -> None:
        self.lane = lane
        self.artifacts = ROOT / "test-results" / "compose-smoke"
        self.artifacts.mkdir(parents=True, exist_ok=True)
        self.base = ["docker", "compose", "--project-name", "compose-smoke", "--env-file", ".env", "-f", file]
        self.services: list[str] = []

    def compose(self, *args: str, check: bool = True) -> str:
        return command([*self.base, *args], check=check)

    def configure(self) -> None:
        os.environ["COMPOSE_PROFILES"] = MINIMAL
        self.compose("config", "--quiet")
        self.compose("--profile", "*", "config", "--quiet")
        if self.lane == "config":
            return
        profiles, selected = LANES[self.lane]
        os.environ["COMPOSE_PROFILES"] = profiles
        self.services = list(selected)
        model = json.loads(self.compose("--profile", "*", "config", "--format", "json"))
        if self.lane == "platform":
            self.services.append("caipe-ui-prod" if "caipe-ui-prod" in model["services"] else "caipe-ui")
        if self.lane == "graph" and "neo4j-ontology" in model["services"]:
            self.services.append("neo4j-ontology")
        if self.lane == "rag":
            # Only the embedding provider changes; keep real DB initialization and auth.
            overlay = self.artifacts / "fixture.json"
            overlay.write_text(json.dumps({"services": {
                "smoke-embeddings": {
                    "image": "python:3.13-alpine",
                    "command": ["python", "/fixture/embeddings.py"],
                    "volumes": [f"{Path(__file__).parent / 'embeddings.py'}:/fixture/embeddings.py:ro"],
                },
                "rag-server": {"environment": {
                    "EMBEDDINGS_PROVIDER": "ollama", "EMBEDDINGS_MODEL": "example-embedding",
                    "OLLAMA_BASE_URL": "http://smoke-embeddings:11434", "SKIP_INIT_TESTS": "false",
                }},
            }}))
            self.base += ["-f", str(overlay)]
            self.services.append("smoke-embeddings")
        self.compose("config", "--quiet")

    def exec(self, service: str, *args: str) -> str:
        return self.compose("exec", "-T", service, *args).strip()

    def url(self, service: str, port: int, path: str) -> str:
        address = self.compose("port", service, str(port)).strip().splitlines()[0]
        return f"http://127.0.0.1:{address.rsplit(':', 1)[1]}{path}"

    def http(self, service: str, port: int, path: str, data: bytes | None = None, headers: dict | None = None) -> dict:
        request = urllib.request.Request(self.url(service, port, path), data=data, headers=headers or {})
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)

    def states(self) -> dict:
        ids = self.compose("ps", "--all", "--quiet").split()
        if not ids:
            raise RuntimeError("No containers started")
        return {item["Config"]["Labels"]["com.docker.compose.service"]: item
                for item in json.loads(command(["docker", "inspect", *ids]))}

    def healthy(self) -> bool:
        states = self.states()
        if not set(self.services).issubset(states):
            return False
        for name, item in states.items():
            state = item["State"]
            if state.get("OOMKilled"):
                raise OOMKilledError(f"{name} was OOM-killed")
            if name in ONESHOTS:
                if state["Status"] != "exited" or state["ExitCode"] != 0:
                    return False
            elif state["Status"] != "running" or state.get("Health", {}).get("Status", "healthy") != "healthy":
                return False
        return True

    def storage(self, service: str, user: str, password: str, persisted: bool) -> None:
        self.exec(service, "mc", "alias", "set", "smoke", "http://127.0.0.1:9000", user, password)
        if not persisted:
            self.exec(service, "mc", "mb", "--ignore-existing", "smoke/example")
            self.exec(service, "sh", "-c", "printf 'example-payload' | mc pipe smoke/example/smoke.txt")
        assert self.exec(service, "mc", "cat", "smoke/example/smoke.txt") == "example-payload"

    def probes(self, persisted: bool = False) -> None:
        if self.lane in {"platform", "rag"}:
            discovery = self.http("keycloak", 7080, "/realms/caipe/.well-known/openid-configuration")
            assert discovery["issuer"].endswith("/realms/caipe")
            token = self.http("keycloak", 7080, "/realms/caipe/protocol/openid-connect/token",
                              urllib.parse.urlencode({"grant_type": "client_credentials", "client_id": "caipe-platform",
                                                      "client_secret": "caipe-platform-dev-secret"}).encode(),
                              {"Content-Type": "application/x-www-form-urlencoded"})
            assert token.get("access_token"), "Keycloak client-credentials grant failed"
            stores = self.http("openfga", 8080, "/stores")["stores"]
            store = next(store for store in stores if store["name"] == "caipe-openfga")
            assert self.http("openfga", 8080, f"/stores/{store['id']}/authorization-models")["authorization_models"]
        if self.lane == "platform":
            ui = "caipe-ui-prod" if "caipe-ui-prod" in self.services else "caipe-ui"
            eventually(lambda: self.http(ui, 3000, "/api/health").get("status") == "ok", "UI readiness")
            eventually(lambda: self.http("dynamic-agents", 8001, "/readyz").get("ready"), "Dynamic Agents MongoDB readiness")
            eventually(lambda: self.http("audit-service", 8010, "/readyz").get("status") == "ready", "audit readiness")
            eventually(lambda: self.http("autonomous-agents", 8002, "/health").get("status") == "ok", "scheduler readiness")
            assert self.http("agentgateway", 15000, "/config"), "Gateway admin API has no configuration"
            mongo_write = '' if persisted else 'c.updateOne({_id:"example"},{$set:{value:"ok"}},{upsert:true});'
            self.exec("caipe-mongodb", "mongosh", "--quiet", "-u", "admin", "-p", "changeme", "--authenticationDatabase", "admin", "--eval",
                      'const c=db.getSiblingDB("smoke").checks;' + mongo_write + 'if(c.findOne({_id:"example"})?.value!=="ok") quit(1)')
            if not persisted:
                response = self.http("audit-service", 8010, "/v1/audit/events",
                                     json.dumps({"events": [{"type": "auth", "outcome": "deny", "correlation_id": "smoke-example"}]}).encode(),
                                     {"Content-Type": "application/json"})
                assert response["accepted"] == 1
            eventually(lambda: any(row.get("correlation_id") == "smoke-example" for row in
                       self.http("audit-service", 8010, "/v1/audit/events?correlation_id=smoke-example")["records"]), "audit write/read persistence")
        elif self.lane == "rag":
            if not persisted:
                assert self.exec("rag-redis", "redis-cli", "SET", "smoke:example", "ok") == "OK"
            assert self.exec("rag-redis", "redis-cli", "GET", "smoke:example") == "ok"
            self.storage("milvus-minio", "minioadmin", "minioadmin", persisted)
            eventually(lambda: self.http("rag-server", 9446, "/healthz").get("status") == "healthy", "RAG initialized with real Milvus and Redis")
            eventually(lambda: "Ingestor initialized with ID:" in self.compose("logs", "--no-color", "web_ingestor"), "authenticated web ingestor registration")
            assert self.exec("rag-redis", "redis-cli", "--scan", "--pattern", "rag/ingestor:*")
        elif self.lane == "graph":
            for service in self.services:
                query = "MATCH (n:Smoke {id: 'example'}) RETURN n.id;" if persisted else "MERGE (n:Smoke {id: 'example'}) RETURN n.id;"
                eventually(lambda: "example" in self.exec(service, "cypher-shell", "-u", "neo4j", "-p", "dummy_password",
                           query), f"{service} Cypher write/read")
        elif self.lane == "tracing":
            self.storage("langfuse-minio", "minio", "miniosecret", persisted)
            eventually(lambda: self.http("langfuse-web", 3000, "/api/public/health"), "Langfuse readiness")
            assert "1" in self.exec("langfuse-postgres", "psql", "-U", "postgres", "-tAc", "SELECT 1")
            assert self.exec("langfuse-redis", "redis-cli", "-a", "myredissecret", "PING") == "PONG"
            assert self.exec("langfuse-clickhouse", "clickhouse-client", "--user", "clickhouse", "--password", "clickhouse", "--query", "SELECT 1") == "1"

    def run(self) -> None:
        self.configure()
        if self.lane == "config":
            return
        # Build from the PR wherever Compose declares a build; pull published dependencies.
        self.compose("build", *self.services)
        self.compose("pull", "--ignore-buildable", *self.services)
        self.compose("up", "-d", "--no-build", *self.services)
        eventually(self.healthy, "all services healthy and init jobs successful", 600)
        self.probes()
        before = {name: item["RestartCount"] for name, item in self.states().items()}
        time.sleep(30)
        assert self.healthy(), "Stack degraded during stability window"
        assert before == {name: item["RestartCount"] for name, item in self.states().items()}, "Container restarted during stability window"
        (self.artifacts / "initial-logs.txt").write_text(self.compose("logs", "--no-color", "--tail", "1000"))
        # Recreate long-running services without removing volumes: catch ownership and persistence regressions.
        long_running = [name for name in self.states() if name not in ONESHOTS]
        self.compose("up", "-d", "--no-build", "--no-deps", "--force-recreate", *long_running)
        eventually(self.healthy, "restart with existing volumes", 600)
        self.probes(persisted=True)

    def cleanup(self) -> None:
        try:
            for name, args in [("containers.txt", ["ps", "--all"]), ("logs.txt", ["logs", "--no-color", "--tail", "1000"])]:
                (self.artifacts / name).write_text(self.compose(*args, check=False))
            ids = self.compose("ps", "--all", "--quiet", check=False).split()
            if ids:
                inspected = json.loads(command(["docker", "inspect", *ids]))
                states = {item["Name"]: {"state": item["State"], "restarts": item["RestartCount"]} for item in inspected}
                (self.artifacts / "states.json").write_text(json.dumps(states, indent=2))
        finally:
            self.compose("down", "--volumes", "--remove-orphans")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", choices=["docker-compose.yaml", "docker-compose.dev.yaml"])
    parser.add_argument("lane", choices=["config", *LANES])
    args = parser.parse_args()
    # Compose defines fixed container names and bind mounts. Never run destructive cleanup on a developer stack.
    if args.lane != "config" and os.environ.get("GITHUB_ACTIONS") != "true":
        parser.error("Run in a disposable GitHub Actions runner; fixed container names are not locally isolated.")
    smoke = Smoke(args.file, args.lane)
    try:
        smoke.run()
    finally:
        if args.lane != "config":
            smoke.cleanup()


if __name__ == "__main__":
    main()
