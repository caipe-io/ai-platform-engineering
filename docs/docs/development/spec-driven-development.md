# Agentic Software Development with Spec-Kit

CAIPE uses [Spec-Driven Development (SDD)](https://github.com/github/spec-kit/blob/main/spec-driven.md) for all feature work. Specifications are the source of truth — code is their generated expression. This guide explains how to use spec-kit to go from idea to production.

## Why spec-kit?

AI agents own the full development loop in CAIPE — not just copilot-style suggestions, but writing, testing, and deploying code with minimal per-step human guidance. Reaching Level 6+ autonomy requires more than a capable model; it requires the model to carry **institutional context**: what the system is, what principles govern it, what "done" looks like, and how to work within the team's conventions.

Spec-kit is a GitHub-native framework built around SDD that solves this:

**1. It inverts the usual relationship between docs and code.**
In traditional development, documentation drifts from reality the moment code is written. Spec-kit reverses this: specs live in the repo, are version-controlled alongside code, and are the artifact that agents read before generating anything. When requirements change, you update the spec and regenerate — not the other way around. This is what makes Level 6+ autonomy durable rather than brittle.

**2. It provides agent-agnostic, multi-tool skill distribution.**
CAIPE contributors use Claude Code, Cursor, Kiro, VS Code Copilot, and others. Spec-kit generates the right command format for every tool from a single Markdown source (`.specify/templates/commands/`). One edit propagates to all tools via `make generate-agent-commands`. This removes a whole class of drift and maintenance burden.

**3. It is the community convergence point for structured AI development.**
Spec-kit is actively maintained by GitHub, has a published [spec-driven methodology](https://github.com/github/spec-kit/blob/main/spec-driven.md), and integrates with the emerging [agentskills.io](https://agentskills.io/specification) standard. Adopting it puts CAIPE on the same trajectory as the broader open-source community rather than building a bespoke framework that diverges over time.

## How CAIPE uses spec-kit

### Project structure

```text
.specify/                           # Spec-kit configuration (edit here)
├── CONSTITUTION.md                 # Governing principles
├── ARCHITECTURE.md                 # System architecture
├── TESTING.md                      # Quality gates
├── SKILLS.md                       # Skills inventory
├── SPECS.md                        # Spec conventions
├── CHANGELOG.md                    # Version history
├── memory/
│   └── constitution.md             # Symlink → ../CONSTITUTION.md
├── specs -> ../../docs/docs/specs  # Symlink to published specs
└── templates/
    ├── spec-template.md            # Feature spec template
    ├── plan-template.md            # Implementation plan template
    ├── tasks-template.md           # Task list template
    ├── checklist-template.md       # Quality checklist template
    ├── constitution-template.md    # Constitution template
    └── commands/                   # ★ Canonical skill sources
        ├── specify.md
        ├── plan.md
        ├── tasks.md
        ├── implement.md
        └── constitution.md

docs/docs/specs/                    # All specs (auto-published via Docusaurus)
├── <###-feature-name>/
│   ├── spec.md                     # Feature specification (PRD)
│   ├── plan.md                     # Implementation plan
│   ├── tasks.md                    # Executable task list
│   ├── research.md                 # Technology choices
│   ├── data-model.md               # Entity definitions
│   └── contracts/                  # API contracts
└── index.md                        # Overview page
```

### Specs are auto-published

All specs live under `docs/docs/specs/` — not in a hidden directory. This means every spec, plan, and ADR is automatically published to the [CAIPE documentation site](https://caipe.io/). External contributors and users see the same design documents that agents and engineers work from.

### Skills for AI tools

Skills are authored once in `.specify/templates/commands/` and generated for supported agents:

| Tool | Commands location |
|------|------------------|
| **Claude Code** | `.claude/commands/speckit.*.md` |
| **Cursor** | `.cursor/commands/speckit.*.md` |

Run `make generate-agent-commands` to regenerate all agent command directories from the canonical templates.

> **Rule**: Never edit `.cursor/commands/` or `.claude/commands/` directly. Edit `.specify/templates/commands/` and regenerate.

### Living documentation

Agents read these files at the start of every session to load project context:

| File | Purpose |
|------|---------|
| [`.specify/memory/constitution.md`](https://github.com/caipe-io/ai-platform-engineering/blob/main/.specify/memory/constitution.md) | Governing principles (10 core principles) |
| [`.specify/ARCHITECTURE.md`](https://github.com/caipe-io/ai-platform-engineering/blob/main/.specify/ARCHITECTURE.md) | Repo layout, key decisions, data flow |
| [`.specify/TESTING.md`](https://github.com/caipe-io/ai-platform-engineering/blob/main/.specify/TESTING.md) | 7-gate quality framework |
| [`.specify/SKILLS.md`](https://github.com/caipe-io/ai-platform-engineering/blob/main/.specify/SKILLS.md) | Skills inventory and sourcing policy |
| [`.specify/SPECS.md`](https://github.com/caipe-io/ai-platform-engineering/blob/main/.specify/SPECS.md) | Spec/plan conventions and lifecycle |

## Quick start: your first feature

The spec-kit pipeline takes you from idea to implementation in four commands. Run these in any supported AI tool (Claude Code, Cursor, etc.).

### Prerequisites

1. Clone the repo and set up your [development environment](./development-environment)
2. Create a feature branch with the `prebuild/` prefix (required for CI):

```bash
git checkout -b prebuild/feat/my-feature
```

### Step 1 — Specify what you want to build

```text
/speckit.specify Add user authentication with OAuth2
```

This creates `docs/docs/specs/<###>-user-auth/spec.md` with:
- User stories and acceptance scenarios
- Functional requirements and success criteria
- Non-functional requirements and constraints

The agent fills gaps with reasonable defaults and flags critical ambiguities (max 3) for your input.

### Step 2 — Plan how to build it

```text
/speckit.plan
```

Reads the spec and produces `docs/docs/specs/<###>-user-auth/plan.md` with:
- Tech stack decisions and rationale
- Constitution compliance check (verifies against `.specify/CONSTITUTION.md`)
- Project structure and directory layout
- Design decisions

Also generates `research.md` (technology choices and alternatives) and `contracts/` (API/interface definitions) if applicable.

### Step 3 — Break it into tasks

```text
/speckit.tasks
```

Generates `docs/docs/specs/<###>-user-auth/tasks.md` — a dependency-ordered, checkbox-formatted task list organized by user story:

```text
Phase 1: Setup
- [ ] T001 Create project structure per implementation plan

Phase 2: Foundational
- [ ] T002 Set up database schema in src/models/schema.py

Phase 3: User Story 1 (P1)
- [ ] T005 [P] [US1] Create User model in src/models/user.py
- [ ] T006 [P] [US1] Implement auth middleware in src/middleware/auth.py
- [ ] T007 [US1] Wire up login endpoint in src/routes/auth.py
```

Each task has an ID, file path, and parallelization marker `[P]`. Tasks are organized so User Story 1 is a shippable MVP.

### Step 4 — Implement

```text
/speckit.implement
```

Executes tasks phase by phase: setup, then each user story in priority order. The agent writes code, runs tests, checks off tasks, and validates against the spec's acceptance criteria.

## Spec lifecycle

```text
idea → spec.md → plan.md → tasks.md → implementation → production
         │           │           │
      /speckit    /speckit    /speckit
      .specify     .plan       .tasks
```

### Spec numbering

Specs are numbered sequentially: `001`, `002`, `003`, ... The `/speckit.specify` command automatically determines the next number by scanning existing specs.

Current numbering:
- **001–082**: Architecture decision records (migrated from `docs/docs/changes/`)
- **083–091**: Feature specifications
- **092+**: New specs

### Spec directory layout

Each numbered spec directory can contain:

```text
docs/docs/specs/<###-feature-name>/
├── spec.md          # Feature specification (PRD) — REQUIRED
├── plan.md          # Implementation plan
├── tasks.md         # Executable, dependency-ordered task list
├── research.md      # Technical research (library choices, benchmarks)
├── data-model.md    # Entity and schema definitions
├── contracts/       # API contracts, event schemas
│   ├── rest-api.md
│   └── events.md
├── quickstart.md    # Key validation scenarios
└── checklists/      # Quality validation checklists
    └── requirements.md
```

## Branching conventions

All branches must use the `prebuild/` prefix to trigger CI:

```text
prebuild/feat/add-auth          # New feature
prebuild/fix/null-pointer       # Bug fix
prebuild/docs/update-architecture  # Documentation
prebuild/chore/dependency-update   # Maintenance
```

Branches without the `prebuild/` prefix will **not** produce testable Docker images or Helm charts. See the [Constitution](https://github.com/caipe-io/ai-platform-engineering/blob/main/.specify/memory/constitution.md) for full CI pipeline details.

## Bug handling

Bugs are classified into three tiers based on their relationship to specifications:

| Tier | Name | When | Spec action | Workflow |
|------|------|------|-------------|----------|
| 1 | Spec violation | Code doesn't match its spec | None — spec is correct | Fix code, reference existing spec |
| 2 | Spec gap | Bug reveals uncovered edge case | Update existing spec | Amend spec, then fix code |
| 3 | Design flaw | Bug reveals architectural issue | New spec required | Full `/speckit.specify` pipeline |

**Tier 1** — One commit: `fix(<scope>): <description>`.

**Tier 2** — Two commits: `docs: add missing edge case to spec`, then `fix: handle edge case`.

**Tier 3** — Full spec-kit pipeline starting with `/speckit.specify`.

## Amending the constitution

If CAIPE's principles need to change (e.g., adding a new architectural pattern or quality gate):

```text
/speckit.constitution
```

Amendments require:
1. A specification describing the change and its rationale
2. Review and approval via PR
3. Migration plan for existing agents and configurations

## Quality gates

Before any PR merges, these must pass:

```bash
make lint            # Ruff linting (Python)
make test            # Backend, runtime, and integration tests
make caipe-ui-tests  # UI Jest tests
```

See [`.specify/TESTING.md`](https://github.com/caipe-io/ai-platform-engineering/blob/main/.specify/TESTING.md) for the complete 7-gate quality framework.

## Agent autonomy levels

CAIPE targets **Level 6** (Harness Engineering), where agents operate with live system access and feedback loops while humans work on the system itself:

| Level | Name | Description | Human Role |
|-------|------|-------------|------------|
| 1 | Tab Complete | AI suggests next character inputs | Reviews every change |
| 2 | Agent IDE | User chats with AI assistant for changes | Reviews most changes |
| 3 | Context Engineering | Optimize prompts to AI coding tools | Reviews architecture |
| 4 | Compounding Engineering | Add update prompt feedback loop | Reviews outputs |
| 5 | MCP and Skills | Give coding tool access to live systems | Reviews incidents |
| **6** | **Harness Engineering** | **Add live data to update feedback loop** | **Works on the system** |
| 7 | Background Agents | Enable agents to get and complete work autonomously | Approves work units |

Based on [The 8 Levels of Agentic Engineering](https://www.bassimeledath.com/blog/levels-of-agentic-engineering) by Bassim Eledath and [Harness Engineering](https://openai.com/index/harness-engineering/) by OpenAI.

## References

- [Spec-Driven Development](https://github.com/github/spec-kit/blob/main/spec-driven.md) — the methodology CAIPE implements
- [agentskills.io](https://agentskills.io/specification) — the skills standard
- [spec-kit](https://github.com/github/spec-kit) — the upstream framework
- [`.specify/memory/constitution.md`](https://github.com/caipe-io/ai-platform-engineering/blob/main/.specify/memory/constitution.md) — CAIPE's governing principles
- [Contributing Guide](../contributing/index.md) — contribution workflow and standards
