---
sidebar_position: 4
---

# UI Development

## Prerequisites

- Node.js 20+
- npm
- Docker Compose for full-stack development

## Start The UI

```bash
cd ui
npm install
npm run dev
```

Open `http://localhost:3000`.

## Start The Backends

```bash
COMPOSE_PROFILES=dynamic-agents,caipe-mongodb docker compose -f docker-compose.dev.yaml up
```

Set local UI env vars:

```bash
DYNAMIC_AGENTS_URL=http://localhost:8100
MONGODB_URI=mongodb://admin:changeme@localhost:27017/caipe?authSource=admin
MONGODB_DATABASE=caipe
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=development-secret-change-me
SKIP_AUTH=true
```

## Useful Commands

```bash
cd ui
npm run lint
npm run build
npm test
```

Use route files under `ui/src/app/api` as the source of truth for BFF behavior.

Use the [selection control decision table](./selection-controls.md) before
adding a select, combobox, listbox, or picker.
