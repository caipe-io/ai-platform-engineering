---
sidebar_position: 2
sidebar_label: Specification
title: "2026-02-06: Runtime Environment Variables & RAG_SERVER_URL Alignment"
---

# Runtime Environment Variables & RAG_SERVER_URL Alignment

## Status

**Accepted** — 2026-02-06


## Motivation

### Problem 1: Build-time inlining of NEXT_PUBLIC_* variables

Next.js statically replaces `process.env.NEXT_PUBLIC_*` references at **build time**. In a Docker deployment, the image is built once (in CI) and deployed to multiple environments with different env vars. Because the values are inlined during `next build`, any `NEXT_PUBLIC_*` variable set at container runtime is ignored on the client side — the UI sees whatever was (or wasn't) present at build time.

This caused a critical bug: `NEXT_PUBLIC_MONGODB_ENABLED=true` was set in the container, but the client-side UI saw `undefined` and fell back to localStorage mode.

### Problem 2: Inconsistent RAG server URL variable naming

The codebase had two different env var names for the same value:

- `RAG_SERVER_URL` — used by docker-compose, Helm values, and all backend services
- `RAG_URL` — used only by the UI's `config.ts` `getRagUrl()` function

Since `RAG_URL` was never set anywhere, the UI fell through to a hardcoded fallback (`http://rag-server:9446`), which fails in Docker Compose where the service name is `rag_server` (underscores).

### Problem 3: HEALTHCHECK baked into the Docker image

The `Dockerfile.caipe-ui` contained a `HEALTHCHECK` instruction. This is an anti-pattern because:

- Health checks should be managed by the orchestrator (Kubernetes liveness/readiness probes, Docker Compose `healthcheck:` section), not baked into the image
- The baked-in healthcheck used `wget` which adds unnecessary dependencies
- It made the container report `(unhealthy)` when the `/api/health` endpoint was slow to respond during startup


## Related

- PR: https://github.com/caipe-io/ai-platform-engineering/pull/778
- Next.js docs on environment variables: https://nextjs.org/docs/app/building-your-application/configuring/environment-variables


- Architecture: [architecture.md](./architecture.md)
