# Local Iteration Loop (Hot Reload)

This page documents how to iterate on Python services without rebuilding Docker
images.

## TL;DR

All Python services in `docker-compose.dev.yaml` already **bind-mount their source
code** from the host into `/app`. So edits to `.py` files on your host are
immediately visible inside the container. The only question is: how does the
running process pick them up?

Two options:

| Option | When to use | Cost |
|--------|-------------|------|
| **`docker restart <service>`** | The default. Fast (3–5s), no extra deps. | Manual restart per edit. |
| **`DEV_HOT_RELOAD=true`** (opt-in) | When you're iterating heavily on one service. | uvicorn `--reload` / `watchfiles` watcher; slightly higher idle CPU. |

## Restart-only loop (default)

```bash
# Edit any file under ai_platform_engineering/...
$EDITOR ai_platform_engineering/integrations/slack_bot/utils/identity_linker.py

# Pick up the change (no rebuild!):
docker restart slack-bot
# or, equivalently:
docker compose -f docker-compose.dev.yaml restart slack-bot
```

This works because every Python service mounts its source over the image's
`/app` directory. The Dockerfile is only needed to install OS packages and the
Python virtualenv — both unaffected by source edits.

## True hot-reload (opt-in)

Set `DEV_HOT_RELOAD=true` in your shell (or in `.env`) **before** bringing up
the service. The first start will install the watcher and re-exec on every
saved file:

```bash
export DEV_HOT_RELOAD=true
COMPOSE_PROFILES="slack-bot,caipe-documentdb,rbac" \
  docker compose -f docker-compose.dev.yaml up -d slack-bot

# Edit a file — service auto-restarts within ~1s:
$EDITOR ai_platform_engineering/integrations/slack_bot/app.py

# Watch the reload:
docker logs -f slack-bot
```

### Per-service mechanism

| Service | How `DEV_HOT_RELOAD=true` works |
|---------|----------------------------------|
| `dynamic-agents` | Sets `DEBUG=true`, which the existing `main.py` already maps to `uvicorn(reload=True)` |
| `rag_server` | `uvicorn --reload --reload-dir /app/server/src/server,/app/common/src/common` |
| `slack-bot` | `uv sync` (incl. `dev` group) + `watchfiles --filter python 'python -m app' /app` (Bolt is not ASGI, so uvicorn `--reload` doesn't apply) |

### Caveats

- **Dependency changes** (new entries in `pyproject.toml` / `uv.lock`) still
  require a rebuild — the watcher only re-imports Python source.
- **C extensions / native libs** can't be reloaded; restart the container.
- **Lifespan/startup-only state** (DB connections, MCP handshakes) is
  rebuilt on each reload, so you'll see the full startup banner each time.
- **Slack-bot socket mode** drops the websocket on each reload; Slack will
  reconnect within a couple of seconds, but mid-message events may be lost.

## When you DO need a rebuild

You only need `docker compose build <service>` (or `up -d --build`) when:

1. You changed `pyproject.toml` / `uv.lock` (new pip dep).
2. You changed the `Dockerfile`.
3. You changed `caipe-ui` (Next.js — built into a static `.next/` directory at
   image build time; not bind-mounted).
4. You changed any Go-based MCP server (compiled into the image).

## Verifying a bind-mount is live

Quick sanity check that the file inside the container is the same as on disk:

```bash
docker exec slack-bot sha256sum /app/utils/identity_linker.py
sha256sum ai_platform_engineering/integrations/slack_bot/utils/identity_linker.py
# The two hashes should be identical.
```
