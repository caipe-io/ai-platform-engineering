---
sidebar_position: 3
---

# Configuration

## Core Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `DYNAMIC_AGENTS_URL` | Yes for chat | Server-side Dynamic Agents URL |
| `MONGODB_URI` | Yes for persistence | MongoDB connection string |
| `MONGODB_DATABASE` | No | MongoDB database name, default `caipe` |
| `NEXTAUTH_URL` | Yes when auth enabled | Public UI URL for auth callbacks |
| `NEXTAUTH_SECRET` | Yes when auth enabled | Session encryption secret |
| `SSO_ENABLED` | No | Enable SSO flow |
| `SKIP_AUTH` | No | Local development auth bypass |
| `RAG_SERVER_URL` | No | RAG backend URL |

## Local Development

```bash
cd ui
npm install

DYNAMIC_AGENTS_URL=http://localhost:8100 \
MONGODB_URI=mongodb://admin:changeme@localhost:27017/caipe?authSource=admin \
NEXTAUTH_URL=http://localhost:3000 \
NEXTAUTH_SECRET=development-secret-change-me \
SKIP_AUTH=true \
npm run dev
```

## Docker Compose

```bash
COMPOSE_PROFILES=caipe-ui,dynamic-agents,caipe-mongodb docker compose -f docker-compose.dev.yaml up
```

The compose files wire `DYNAMIC_AGENTS_URL` and `MONGODB_URI` for the packaged
services. Override them in `.env` only when pointing at external services.

## Helm

```yaml
caipe-ui:
  config:
    DYNAMIC_AGENTS_URL: http://ai-platform-engineering-dynamic-agents:8001
    MONGODB_DATABASE: caipe
  existingSecret: caipe-runtime-secrets
```

`existingSecret` or `externalSecrets` should provide sensitive values such as
`MONGODB_URI`, OAuth client secrets, and `NEXTAUTH_SECRET`.

## Initial Skills

- Set `caipe-ui.appConfig.skills` in Helm values, or `skills` in the YAML file
  referenced by `APP_CONFIG_PATH`, to provide initial skills:

  ```yaml
  skills:
    - id: example-skill
      name: Example Skill
      description: Summarize a supplied document
      content: |
        Summarize the supplied document and list its main decisions.
  ```

- The UI seeds skills once per database at server startup. A completion record
  in `startup_seeds` preserves subsequent edits and deletions across upgrades.
- Omit `skills` to select image packaged templates using `BUILTIN_SKILL_IDS`
  (`none` disables them; empty selects all). Set `skills: []` to initialize
  without any skills. After initialization, use the Skills UI to add more.
- Packaged defaults live in the UI image, and `agent_skills` supplies the
  persisted catalog. Template imports remain available explicitly.
- The chart omits legacy mounts referencing the `skill-templates` ConfigMap
  on upgrade. Remove those obsolete entries from deployment overrides.
