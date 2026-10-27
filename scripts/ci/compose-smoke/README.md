# Compose smoke tests

`test-compose.yml` tests both canonical Compose files without repository secrets,
LLM API keys, model downloads, or third-party accounts.

## Coverage

| Lane | Runtime checks |
| --- | --- |
| Configuration | Minimal OSS profiles and all profiles render for both files |
| Platform | MongoDB, production UI, Dynamic Agents, autonomous scheduler, audit service, Keycloak/Postgres, OpenFGA/Postgres, init jobs, authorization bridge, config bridge, AgentGateway |
| RAG | Redis, etcd, MinIO, Milvus, RAG server, web ingestor; real Keycloak client-credentials authentication and OpenFGA initialization |
| Graph | Neo4j Cypher write/read; also the separate ontology database where declared |
| Tracing | Langfuse web/worker, Postgres, Redis, ClickHouse, MinIO |

- Every declared container health check must pass. Init jobs must exit **zero**.
- Services without health checks get endpoint or functional checks where available;
  Langfuse worker is checked for process stability only.
- Check UI, agent readiness, scheduler, audit, OIDC discovery/token issuance,
  OpenFGA model seeding, and the gateway admin API.
- Write/read MongoDB, audit events, Redis, S3 objects, and Neo4j data.
- RAG startup keeps its Milvus insert/search/delete initialization tests enabled.
- Require successful authenticated web-ingestor registration and Redis metadata.
- Observe a 30-second stability window, rejecting restarts and degraded health.
- Recreate long-running containers without removing volumes, then repeat probes
  and read the original test data. This tests same-image persistence, **not** a
  previous-release upgrade migration.
- Preserve bounded container logs and status as artifacts, then remove the
  disposable Compose project's containers and named volumes.

## No LLM credentials

- Start from `.env.example`, with a CI-only `NEXTAUTH_SECRET`.
- Do not provide paid-provider keys or disable authorization.
- The RAG lane adds a tiny Ollama-compatible HTTP fixture and points **only its
  embeddings configuration** at that fixture. Deterministic 64-dimensional
  vectors exercise the real storage startup path, not retrieval quality.
- No chat, inference, autonomous task execution, or external crawl is requested.

## Execution

- PRs and pushes changing Compose, example env, build/deployment configuration,
  auth seeds, or the smoke harness run all lanes. Manual dispatch and a weekly
  schedule also run all lanes; the schedule catches mutable image regressions.
- Each file/lane pair gets a fresh runner. Limit concurrency to four jobs.
- Build services that declare `build` from the checked-out revision; otherwise
  use the images declared by Compose. Production app services without `build`
  therefore exercise published releases, not unbuilt PR application code.
- Keep canonical commands, users, health checks, dependencies, and storage mounts.
  Split lanes avoid the UI/Langfuse port conflict and limit peak memory.
- Runtime execution is restricted to disposable GitHub Actions runners because
  the canonical files use fixed container names and host bind mounts. Do not
  bypass the guard on a developer machine with an existing stack.

Run harness checks without Docker:

```bash
uv run pytest scripts/ci/compose-smoke/test_smoke.py
uv run ruff check scripts/ci/compose-smoke
```

## Explicit limits

- This is broad service smoke coverage, not a successful all-profiles deployment.
- External MCP integrations, Slack/Webex bots, credential-dependent ingestors,
  ontology inference, and optional DocumentDB receive configuration validation
  only. They need dedicated integration environments or additional fixtures.
- Real LLM quality, agent routing, authenticated browser flows, and full document
  ingestion remain the responsibility of their existing integration suites.
- A valid Compose configuration does not guarantee an image can be pulled or a
  process can start; the runtime jobs deliberately fail on those errors.
