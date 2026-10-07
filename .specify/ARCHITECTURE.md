# Architecture

## Overview

AI Platform Engineering (CAIPE) is a multi-agent system for platform engineers, enabling AI-powered automation of DevOps and SRE tasks through specialized agents that integrate with tools like ArgoCD, AWS, Jira, Splunk, PagerDuty, and more.

CAIPE follows the **Spec-Driven Development (SDD)** methodology from [GitHub's spec-kit](https://github.com/github/spec-kit). Specifications are the source of truth; code is the output.

## Repository Layout

```text
.
├── docs/
│   └── docs/                        # Docusaurus documentation site
│       └── specs/                   # ★ ALL specs and ADRs (auto-published)
│           ├── <###-feature-name>/  # Per-feature spec directory
│           │   ├── spec.md          # Feature specification (PRD)
│           │   ├── plan.md          # Implementation plan
│           │   ├── research.md      # Technical research notes
│           │   ├── data-model.md    # Data model definitions
│           │   ├── contracts/       # API and interface contracts
│           │   ├── quickstart.md    # Validation scenarios
│           │   └── tasks.md         # Executable task list
│           └── index.md             # Specs overview page
│
├── .specify/                        # Spec-kit source of truth (edit here)
│   ├── memory/
│   │   └── constitution.md          # Governing principles
│   ├── ARCHITECTURE.md              # This file — high-level architecture
│   ├── TESTING.md                   # Quality gates and test strategy
│   ├── SKILLS.md                    # Skills inventory and conventions
│   ├── SPECS.md                     # Specs and plans conventions
│   ├── CHANGELOG.md                 # Version history
│   ├── templates/                   # Spec-kit document templates
│   │   ├── constitution-template.md
│   │   ├── spec-template.md
│   │   ├── plan-template.md
│   │   ├── tasks-template.md
│   │   ├── checklist-template.md
│   │   └── commands/                # ★ CANONICAL skill/command templates
│   │       ├── specify.md
│   │       ├── plan.md
│   │       ├── tasks.md
│   │       ├── implement.md
│   │       ├── constitution.md
│   └── specs -> ../docs/docs/specs   # Symlink to published specs
│
├── ai_platform_engineering/         # Python backend
│   ├── agents/                      # Individual domain agents
│   │   ├── argocd/                  # ArgoCD agent + MCP server
│   │   ├── aws/                     # AWS agent + MCP server
│   │   ├── github/                  # GitHub agent + MCP server
│   │   ├── jira/                    # Jira agent + MCP server
│   │   ├── splunk/                  # Splunk agent + MCP server
│   │   └── ...                      # Other domain agents
│   ├── multi_agents/                # Multi-agent orchestration
│   │   ├── platform_engineer/       # Platform Engineer supervisor
│   │   └── supervisor/              # Supervisor base classes
│   ├── knowledge_bases/             # RAG and knowledge management
│   │   └── rag/                     # RAG server, ingestors, graphrag, ontology
│   ├── mcp/                         # MCP integrations
│   └── utils/                       # Shared utilities
│
├── ui/                              # CAIPE UI (Next.js 16 + React 19)
│   ├── .specify/                    # UI-specific spec kit
│   ├── src/                         # Source code
│   └── ...
│
├── charts/                          # Helm charts for K8s deployment
│   └── ai-platform-engineering/
├── docker-compose/                  # Docker Compose configurations
├── integration/                     # Integration tests
└── scripts/                         # Build and utility scripts
```

> **Rule**: Never manually edit files in the generated agent directories (`.cursor/commands/`). Edit `.specify/templates/commands/*.md` instead.

## Key Architectural Decisions

### 1. Multi-Agent System with Domain Specialization

Each external system (ArgoCD, AWS, Jira, Splunk, PagerDuty) has a dedicated agent that encapsulates domain knowledge, MCP tools, and prompt engineering for that system. The Supervisor agent orchestrates collaboration across agents.

**Implication**: Adding a new integration means creating a new agent package under `ai_platform_engineering/agents/`, not extending an existing agent.

### 2. Specification-First (Spec-Driven Development)

Specifications live in `docs/docs/specs/<###-feature-name>/` and are the source of truth. They are automatically published to the Docusaurus documentation site. Code is the output — not the source. This follows the [Spec-Driven Development](https://github.com/github/spec-kit/blob/main/spec-driven.md) methodology from GitHub's spec-kit.

**Implication**: Before any code is written, a `spec.md` must exist. Before implementation begins, a `plan.md` and `tasks.md` must exist.

### 3. A2A Protocol for Agent Communication

All inter-agent communication uses Google's Agent-to-Agent (A2A) protocol with SSE streaming. Agent Cards describe capabilities and are discovered by the Supervisor at runtime.

**Implication**: Every agent must expose an A2A-compliant HTTP endpoint and publish an Agent Card.

### 4. MCP for Tool Access

Agents access external systems exclusively through MCP (Model Context Protocol) servers. MCP servers handle pagination, rate limiting, and response size constraints.

**Implication**: Direct API calls to external systems from agent logic are prohibited; all access goes through MCP tools.

### 5. LangGraph for Agent Execution

All agents use LangGraph for graph-based execution with support for checkpoints, interrupts, and human-in-the-loop workflows. Redis-backed persistence enables production deployments.

**Implication**: Agent state must be serializable and checkpoint-compatible.

### 6. Institutional Memory in `.specify/`

The `.specify/` directory is the persistent memory of the project. It is maintained by both humans and AI agents. Key properties:

- Always reflects the current state of architecture and decisions
- Referenced by agent tool configurations to load context on demand
- Version-controlled alongside code

### 7. Progressive Autonomy

The architecture is designed to scale from Level 1 (Tab Complete) to Level 7 (Background Agents) without restructuring, following [The 8 Levels of Agentic Engineering](https://www.bassimeledath.com/blog/levels-of-agentic-engineering) by Bassim Eledath and [Harness Engineering](https://openai.com/index/harness-engineering/) by OpenAI.

## Data Flow: Spec to Code

```text
Engineer/PM idea
      │
      ▼
/speckit.specify <description>
      │ creates
      ▼
docs/docs/specs/<###>/spec.md  ←── constitution + skills provide constraints
      │
      ▼
/speckit.plan <tech choices>
      │ creates
      ▼
docs/docs/specs/<###>/plan.md
docs/docs/specs/<###>/research.md
docs/docs/specs/<###>/data-model.md
docs/docs/specs/<###>/contracts/
      │
      ▼
/speckit.tasks
      │ creates
      ▼
docs/docs/specs/<###>/tasks.md  ──► parallelizable task groups marked [P]
      │
      ▼
/speckit.implement
      │ executes
      ▼
Source code + tests  ──► CI quality gates (TESTING.md)
      │ passes
      ▼
Pull Request  ──► Engineer review against spec acceptance criteria
```

## Quality Gates

See [TESTING.md](./TESTING.md) for the complete quality gate definitions. At minimum:

- `make lint` passes (Ruff for Python)
- `make test` passes (pytest for all agent and supervisor tests)
- `make caipe-ui-tests` passes (Jest for UI)
- No secrets detected in committed code

## Related Documents

- [memory/constitution.md](./memory/constitution.md) — Governing principles
- [TESTING.md](./TESTING.md) — Quality gates
- [SKILLS.md](./SKILLS.md) — Skills inventory
- [SPECS.md](./SPECS.md) — Specs and plans conventions
- [GitHub Spec Kit](https://github.com/github/spec-kit) — Upstream SDD framework
- [agentskills.io](https://agentskills.io/specification) — Skills standard
