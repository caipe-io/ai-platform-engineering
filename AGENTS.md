# Agent Instructions

## Project Structure

```
ai_platform_engineering/   # Python backend
  mcp/                     # Per-tool MCP servers (GitHub, ArgoCD, etc.)
  dynamic_agents/          # Dynamic agents runtime (FastAPI, MongoDB, AG-UI/SSE)
  integrations/            # Slack and Webex bot integrations
  autonomous_agents/       # Scheduled and event-driven autonomous tasks
  audit_service/           # Audit-event service
  scheduler/               # Scheduler service
  cron-runner/             # Cron job runner
  knowledge_bases/rag/     # RAG server, ingestors, graphrag, ontology
  skills_middleware/       # Skill scanning / catalog middleware
  utils/                   # Shared utilities
ui/                        # Next.js frontend
docs/                      # Documentation site (Docusaurus)
docker-compose*.yaml       # Canonical Docker Compose configurations
tests/                     # Repo-level + RBAC tests
scripts/                   # Utility scripts
charts/                    # Helm charts
```

## Find the Canonical Implementation

Start with the narrowest owning module; do not add a parallel implementation
until you have checked the shared locations below.

| Need | Start here | Reuse before adding new code |
|---|---|---|
| UI page or API route | `ui/src/app/` | `ui/src/components/`, `ui/src/lib/`, `ui/src/store/` |
| UI component | `ui/src/components/` | `ui/src/components/ui/` and `ui/src/components/shared/`, then an existing component in the same feature area |
| UI selection control | `ui/src/components/ui/{select,searchable-picker}.tsx` | Follow `docs/docs/ui/selection-controls.md`; reuse a domain picker before adding a base or custom listbox |
| UI state or browser data | `ui/src/store/` | Existing store and `ui/src/lib/` helpers |
| MCP integration | `ai_platform_engineering/mcp/<provider>/` | `ai_platform_engineering/mcp/common/` |
| Slack or Webex behavior | `ai_platform_engineering/integrations/{slack_bot,webex_bot}/` | The BFF/API contract and shared auth utilities |
| Dynamic/custom-agent runtime | `ai_platform_engineering/dynamic_agents/` | Its `src/` modules and tests |
| RAG/ingestion | `ai_platform_engineering/knowledge_bases/rag/` | `common/`, `server/`, or `ingestors/` as applicable |
| Authentication, authorization, or audit helpers | `ai_platform_engineering/utils/{auth,audit_backends}/`, `ui/src/lib/authz/`, `ui/src/lib/rbac/`, and `ui/src/lib/audit/` | Use the existing domain boundary; do not add direct OpenFGA checks outside an approved adapter |

Tests live beside their component (`**/tests/`, `**/__tests__/`) unless they
exercise a cross-component contract. Repository-wide checks are in `tests/`;
RBAC integration and browser coverage is in `tests/rbac/` and `ui/e2e/rbac/`.

Each component has its own environment variables - see `env.example` in `ui/` and READMEs in `ai_platform_engineering/knowledge_bases/rag/`.

## Documentation

- **Architecture & concepts** - Keep updated in `docs/`
- **Configuration & code details** - Document in component READMEs
- **Agent instructions** - Keep this file (`AGENTS.md`) up-to-date

## Docs & Spec Rules

- Reading is as hard as writing.
- Optimize for the next reader.
- Prefer bullets over paragraphs.
- Prefer diagrams over long explanations.
- No wall of text.
- Remove words that do not change decisions.

## DCO Policy

AI agents operating in this repository **must** follow these rules on every commit:

1. **No AI sign-off** - `Signed-off-by` is a human DCO certification. AI agents must never invent, assume, or add this trailer on their own.
2. **Use an explicit human DCO on every commit** - Every commit must include the `Signed-off-by` trailer that the human contributor explicitly provided.
3. **Do not invent identities** - Use only a DCO identity explicitly provided by the human contributor.

## Git Guidelines

- **Conventional Commits for commits and PR titles** - Format: `type(scope): description`
  - Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`
  - Example: `feat(rag): add userinfo caching`
- **Branch naming** - Use `prebuild/` prefix for CI to build Docker images
  - Example: `prebuild/feat/rag-batch-job-status`
- **PR descriptions** - Follow the template in `.github/pull_request_template.md`

## Issue Tracking

This project uses **GitHub Issues** for issue tracking.

- Create follow-up work as GitHub Issues in `caipe-io/ai-platform-engineering`.
- Reference related issues in PR descriptions when applicable.
- Do not use repo-local Beads or `bd` issue tracking.

## Quality Gates

Before committing code changes, run relevant checks:
- Python: `uv run ruff check`, `uv run pytest` (always use `uv run` to ensure virtual env)
- UI: `nvm use` first (if available), then `npm run lint`, `npm run build`

## Docker Compose First Install

When changing `docker-compose.yaml`, `docker-compose.dev.yaml`, `.env.example`,
release image tags, Compose profiles, Keycloak/OpenFGA/RAG defaults, or
first-launch UX, follow `.claude/skills/docker-compose-first-install/SKILL.md`.
The `docker-compose.yaml` + `.env.example` path must work for a first-time OSS
user with the minimal profiles:

```bash
mcp-servers,caipe-ui-prod,rbac,dynamic-agents,rag,caipe-mongodb,web_ingestor
```

Do not add Slack/Webex bots to that default path.

## Code Style

- **Imports at top** - All imports must be at the top of the file, unless otherwise specified
- **Type hints required** - Python functions should have type hints for parameters and return values
- **Error handling** - Use specific exceptions, log errors with context, don't silently swallow exceptions
- **Comments** - Explain current intent or an invariant. Do not add tool/model provenance or rely on historical spec IDs as the explanation.

## Test Data and Generic Examples

- Never use real or deployment-specific names in tests, fixtures, examples, docs, seeds, screenshots, or generic source defaults.
- This includes company and product names, people, email addresses, bot identities, cluster names, environment names, customer names, and internal project names.
- Use neutral identifiers such as `primary`, `secondary`, `example`, `test-user`, and `example-bot`.
- Use reserved domains such as `example.com`, `example.org`, and `example.test` for URLs and email addresses.
- Environment-specific identities belong only in environment-owned deployment configuration, never in reusable source or tests.

## Active Technologies
- TypeScript (Next.js, React) + Zustand (state management), Next.js App Router (093-fix-audit-chat-active-preserve)
- MongoDB (server-side via API), Zustand store (client-side) (093-fix-audit-chat-active-preserve)
- Python + Slack Bolt, Slack SDK, httpx (SSE streaming), Pydantic (config models), requests, loguru, PyYAML — no new dependencies (100-slack-agui-migration)
- MongoDB (LangGraph checkpointer on dynamic agents side; Slack bot is stateless beyond in-memory TTL caches) (100-slack-agui-migration)
- Service accounts: dynamic Keycloak confidential clients + OpenFGA `service_account` tuples + Mongo `service_accounts` collection; BFF (Next.js) orchestrates create/rotate/revoke/scope; caller-keyed tool authz added to the OpenFGA ext_authz bridge (2026-06-05-service-accounts)
