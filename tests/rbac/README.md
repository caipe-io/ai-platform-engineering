# Comprehensive RBAC Tests (`tests/rbac/`)

Cross-cutting RBAC test suite for the current architecture documented under
[`docs/docs/security/rbac/`](../../docs/docs/security/rbac/index.md).

## Layout

```text
tests/rbac/
├── conftest.py              # pytest persona fixtures (alice, bob, carol, dave, eve, frank)
├── rbac-matrix.yaml         # single source of truth — every gate × every persona
├── fixtures/                # shared helpers (TS + Py persona token mint, audit assertions, RAG seed, stub MCP)
├── unit/
│   ├── py/                  # pytest matrix driver + per-surface tests
│   └── ts/                  # Jest matrix driver (BFF routes)
└── e2e/                     # Playwright specs — one per user story
```

## Quick run

```bash
make test-rbac          # full suite (Jest + pytest + Playwright via the e2e compose stack)
make test-rbac-jest     # BFF unit only (~2 min)
make test-rbac-pytest   # backend unit only (~3 min)
make test-rbac-e2e      # Playwright only (~4 min)
```

The compose stack used by these tests is `docker-compose.dev.yaml` driven by
`COMPOSE_PROFILES`; there is no separate e2e compose file. `make test-rbac-up`
sets `E2E_RUN`, remaps Mongo to host port `28017`, and mounts the
`RBAC_FALLBACK_*` configuration. The UI remains on host port `3000` because the
Keycloak client redirect URI is pinned there. See the Makefile's RBAC section
for the complete environment contract.
