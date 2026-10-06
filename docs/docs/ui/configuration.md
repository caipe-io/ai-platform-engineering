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

## Skills configuration

- Set `caipe-ui.appConfig.skills` in Helm values, or `skills` in the YAML file
  referenced by `APP_CONFIG_PATH`, to manage skills through configuration, like agents:

  ```yaml
  skills:
    - id: example-skill
      name: Example Skill
      description: Summarize a supplied document
      content: |
        Summarize the supplied document and list its main decisions.
  ```

- Startup applies configured additions and changes to MongoDB. Removing a skill from YAML removes its config-driven database record. These skills are read-only in the UI; clone one to create an editable user-owned copy.
- Omit `skills` on a fresh database to seed only the tool-free **Hello World** example once. This ordinary database skill can be edited or deleted in the UI; restarts do not restore it.
- Set `skills: []` to suppress the default on a fresh database and remove previously config-driven skills. User-created and explicitly imported skills remain managed through the UI.
- System gateway instructions (`live-skills` and `update-skills`) initialize from release assets in a separate `system_skills` collection on every startup. App-config and ordinary skill APIs cannot change them, even through an ordinary skill with the same ID.
- Packaged defaults live in the UI image, and `agent_skills` supplies the
  persisted catalog. Template imports remain available explicitly.
- The chart omits legacy mounts referencing the `skill-templates` and `skills-live-skills` ConfigMaps
  on upgrade. Remove those obsolete entries from deployment overrides.

### Existing installations

- In the admin migration UI, preview and apply **Move packaged skill catalog into MongoDB**.
- The migration inserts missing ordinary packaged catalog skills. It preserves edited records, restricted visibility, and imported copies. System gateway instructions initialize separately on startup.
- If `app-config.yaml` provides `skills`, the migration applies that declarative list instead. YAML controls matching records, including their content and global visibility. A missing configured file fails the migration without marking it complete.
- The packaged catalog migration runs once. New databases already initialized by startup are left unchanged; later restarts and upgrades do not recreate deleted ordinary skills.
- Coding-agent helper scripts ship in the UI image; they do not need a ConfigMap or database seed.
