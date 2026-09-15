# CAIPE Evaluator: API Access & Configuration Philosophy

This document outlines the standardized configuration philosophy, access topologies, and environment variable management for CAIPE and the RAG Evaluator.

---

## 1. Core Architectural Principle: Code Defaults vs. Environment Overrides

To ensure maximum predictability and prevent hardcoded cluster-specific DNS names from leaking into Python codebases:

### Rule 1: Code Defaults MUST Point ONLY to `localhost:<port>`
All Python microservices and evaluation scripts in source code must default to the local developer baseline (`localhost:<port>`).
* **RAG Server**: `http://localhost:9446`
* **Dynamic Agents**: `http://localhost:8001`
* **Evaluator REST API**: `http://localhost:8000`
* **Next.js UI BFF**: `http://localhost:3000`
* **PostgreSQL**: `localhost:5432`

Source code should **never** hardcode cluster-internal domain names like `http://caipe-caipe-ui:3000` or `http://caipe-rag-server:9446` as internal Python `Field(default=...)` constants.

---

### Rule 2: Deployment Topologies are Managed Exclusively by Helm & `setup-caipe.sh`

Any shift in environment (local standalone, Docker Compose, Kubernetes cluster, or remote CI) is controlled strictly via **configuration injection**:

| Environment | Managed By | RAG URL Configured | Dynamic Agents URL Configured |
|---|---|---|---|
| **Local Dev (Python/Pip)** | Default code constants | `http://localhost:9446` | `http://localhost:8001` |
| **Docker Compose** | `docker-compose.yaml` / `.env` | `http://caipe-ui:3000/api/rag` | `http://caipe-ui:3000/api/dynamic-agents` |
| **Kubernetes (Helm)** | Helm `values.yaml` / templates | `http://{{ .Release.Name }}-caipe-ui:3000/api/rag` | `http://{{ .Release.Name }}-caipe-ui:3000/api/dynamic-agents` |
| **Kubernetes (`setup-caipe.sh`)** | Deployment automation flags | Injected via Helm values / post-deploy env | Injected via Helm values / post-deploy env |
| **Remote CLI / Laptop** | `CAIPE_API_URL` environment variable | `https://<domain>/api/rag` | `https://<domain>/api/dynamic-agents` |

---

## 2. The Three Access Topologies

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. LOCAL STANDALONE DEV                                                     │
│                                                                             │
│ [Evaluator Script] ──(defaults)──> http://localhost:9446 (RAG)             │
│                    ──(defaults)──> http://localhost:8001 (Dynamic Agents)   │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. IN-CLUSTER KUBERNETES (Managed via Helm values.yaml / templates)         │
│                                                                             │
│ [Evaluator Pod] ──(RAG_SERVER_URL)──> http://caipe-caipe-ui:3000/api/rag    │
│                 ──(AGENT_URL)───────> http://caipe-caipe-ui:3000/api/dynamic-agents
│                 ──(CAIPE_SA_*)──────> https://<domain>/realms/caipe/token  │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. REMOTE ACCESS VIA INGRESS (Managed via CAIPE_API_URL / export)           │
│                                                                             │
│ [Laptop / CI Script] ──(CAIPE_API_URL)──> https://<domain>/api/rag          │
│                                         > https://<domain>/api/dynamic-agents
│                                         > https://<domain>/api/rag-evaluator│
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Standardized Architecture & Access Matrix

| Service | 1. Local Standalone Dev (`config.py` default) | 2. Docker Compose (`docker-compose.yaml`) | 3. In-Cluster Kubernetes (Default via UI BFF) | 4. Remote Client via Ingress |
|---|---|---|---|---|
| **Evaluator API** | `http://localhost:8000` | `http://caipe-ui:3000/api/rag-evaluator` | `http://caipe-caipe-ui:3000/api/rag-evaluator` | `https://<domain>/api/rag-evaluator` |
| **RAG Server** | `http://localhost:9446` | `http://caipe-ui:3000/api/rag` | `http://caipe-caipe-ui:3000/api/rag` | `https://<domain>/api/rag` |
| **Dynamic Agents** | `http://localhost:8001` | `http://caipe-ui:3000/api/dynamic-agents` | `http://caipe-caipe-ui:3000/api/dynamic-agents` | `https://<domain>/api/dynamic-agents` |

> [!NOTE]
> **Internal Service-to-Service Access**:
> The Evaluator pod inside Kubernetes is exposed directly via `caipe-rag-evaluator:8000` to the Next.js UI BFF. When external clients (browser or remote CLI) call the evaluator, they call `https://<domain>/api/rag-evaluator` on the UI BFF, which proxies to `http://caipe-rag-evaluator:8000`. In return, when the evaluator makes outbound calls to RAG and Dynamic Agents, it routes back through the UI BFF (`http://caipe-caipe-ui:3000/api/rag` and `http://caipe-caipe-ui:3000/api/dynamic-agents`).

---

## 4. Direct Service vs. UI BFF Routing & Decision to Drop Direct Service Access

Evaluating RAG and Dynamic Agents through the **Next.js UI BFF Proxy** (`http://caipe-ui:3000`) versus directly hitting internal backend pods (`rag-server:9446` or `dynamic-agents:8001`) differs fundamentally in session management and authorization:

| Dimension | Direct Backend Pod (`dynamic-agents:8001` / `rag-server:9446`) | In-Cluster UI BFF (`caipe-ui:3000`) *(Standard)* |
|---|---|---|
| **Conversation Session Lifecycle** | ❌ **Unsupported / 404**: `dynamic-agents` has no `/api/chat/conversations` route. It has **no session management logic** and expects an external orchestrator to persist session documents in MongoDB. | ✅ **Supported**: Next.js BFF (`/api/chat/conversations`) creates MongoDB conversation records and writes OpenFGA ownership tuples. |
| **OpenFGA Agent Authorization** | ⚠️ **Partial**: Evaluates `agent:<id>#can_use` only if the caller sends full Bearer claims; cannot manage or verify session ownership (`conversation#write`). | ✅ **Full**: Enforces `agent:<id>#can_use`, verifies conversation ownership (`requireConversationWriteAccess`), team/tenant grants (`X-Tenant-Id`), and handles session read/write sharing. |
| **OpenFGA RAG Authorization** | ⚠️ **Coarse**: Checks raw API tokens but lacks fine-grained object filters for custom tools and tenant scopes. | ✅ **Full**: Injects per-user datasource filters (`data_source#can_read`), enforces `can_search`, and validates custom tools. |
| **Ephemeral MCP Tools** | ❌ **Orphan Risk**: Direct RAG calls bypass tool reconciliation hooks and lifecycle cleanup in the BFF. | ✅ **Managed**: Custom evaluator MCP tools are registered via `/api/rag/v1/mcp/custom-tools` with automatic TTL cleanup. |
| **SSE Streaming Protocol** | Directly streams from FastAPI `/stream/start`. | Transparently proxied with headers via `/api/v1/chat/stream/start`. |

### Architectural Decision: Dropping In-Cluster Direct Service Access
In earlier iterations, workloads optionally used direct service access (e.g. `http://caipe-dynamic-agents:8001` or `http://rag-server:9446`). **We have dropped direct in-cluster service access in favor of standardized UI BFF routing for the following architectural reasons**:

1. **Lack of Session Management in Direct Services**:
   `dynamic_agents/` is a stateless execution engine focused purely on LangGraph graph execution, tool invocation, and LLM inference. It deliberately does not manage conversation document storage, chat histories, or session persistence. Bypassing the BFF breaks conversation initialization and causes `404 Not Found` errors when clients call `/api/chat/conversations`.
2. **Centralized Policy Enforcement Point (PEP)**:
   The Next.js UI BFF (`ui/src/app/api/`) acts as the single Policy Enforcement Point. Routing all traffic through the BFF guarantees that OpenFGA ReBAC rules (agent usage, conversation write ownership, and datasource read constraints) are evaluated uniformly.
3. **Elimination of Architectural Fragmentation**:
   Standardizing on BFF routing means client tools, CLI scripts, background evaluators, and browser frontends all use the identical API hierarchy (`/api/rag`, `/api/dynamic-agents`, `/api/rag-evaluator`). There is zero DNS or port fragmentation between local, Docker Compose, and Kubernetes environments.

---

## 5. Summary of Standardized Environment Variables

| Variable | Local Default | Helm / Cluster Value | Remote Script Usage |
|---|---|---|---|
| `CAIPE_API_URL` | `http://localhost:8000` | `http://caipe-caipe-ui:3000` | `https://<domain>` |
| `RAG_SERVER_URL` | `http://localhost:9446` | `http://caipe-caipe-ui:3000/api/rag` | `https://<domain>/api/rag` |
| `AGENT_URL` | `http://localhost:8001` | `http://caipe-caipe-ui:3000/api/dynamic-agents` | `https://<domain>/api/dynamic-agents` |
| `EVALUATOR_OIDC_CLIENT_ID` | `None` | `caipe-platform` (from secret) | Client ID for machine token (alias: `CAIPE_SA_CLIENT_ID`) |
| `EVALUATOR_OIDC_CLIENT_SECRET` | `None` | `<secret>` (from secret) | Client Secret for machine token (alias: `CAIPE_SA_CLIENT_SECRET`) |
| `EVALUATOR_OIDC_TOKEN_URL` | `None` | `https://<domain>/realms/caipe/protocol/openid-connect/token` | Keycloak token endpoint (alias: `CAIPE_SA_TOKEN_URL`) |
| `EVALUATOR_OIDC_ISSUER` | `None` | `https://<domain>/realms/caipe` | Keycloak realm URL |

