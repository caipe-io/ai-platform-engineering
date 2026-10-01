# CAIPE Constitution

## Design Principles

### I. Worse is Better

Simplicity of implementation wins over simplicity of interface — [Richard Gabriel, 1989](https://en.wikipedia.org/wiki/Worse_is_better).

- Ship working software over perfecting it. Iterate in small increments.
- Avoid premature abstraction. Build the concrete thing first; extract patterns when they prove themselves.
- A system that is simple to build, deploy, and debug beats one that is theoretically elegant.
- Do not overcomplicate the implementation to achieve an elegant interface. A rough interface with a simple implementation is preferable.

### II. YAGNI

[You Aren't Gonna Need It](https://martinfowler.com/bliki/Yagni.html). Implement exactly what is needed now. Do not add functionality on the speculation that it might be useful later. Speculative features add maintenance burden and complexity with no guaranteed payoff.

### III. Rule of Three

Tolerate duplication until the third occurrence, then refactor. Delete dead code — version control is the safety net.

### IV. Composition over Inheritance

Favor composition and dependency injection over class hierarchies. Keep modules loosely coupled and independently testable.

### V. Specs as Source of Truth

All features start as a specification in `docs/docs/specs/<YYYY-MM-DD-feature-name>/`. Code serves the spec. The spec-driven workflow (specify → plan → tasks → implement) is the standard development process. Details in `.specify/SPECS.md`.

### VI. CI Gates Are Non-Negotiable

No code ships without passing lint and test gates. `.specify/TESTING.md` defines the quality gates for this repository.

### VII. Security by Default

- No secrets in source — environment injection only
- Validate all external inputs at system boundaries
- Defense in depth — do not trust any single layer to be the only safeguard
- Be wary of injecting external inputs into prompts and logic — treat them as untrusted
- External dependencies are reviewed for supply chain risk

## Coding Practices

- **Type hints** — all Python functions must have type hints for parameters and return values
- **Imports at top** — organized by stdlib / third-party / local
- **Error handling** — use specific exceptions, log with context, never swallow silently
- **Docstrings** — required on public functions and classes
- **Logging** — no `print()` in production code; use structured logging (`loguru`)
- **Constants** — named constants over magic numbers and strings

## Documentation

- **Component READMEs** — every component directory has a README explaining what it does, how to configure it, and how to run it
- **API and config docs** — public APIs, config schemas, and environment variables are documented where they are defined
- **Architecture decisions** — significant design choices are recorded in `.specify/ARCHITECTURE.md` or as ADRs in `docs/`
- **Code comments** — explain *why*, not *what*. No narration of obvious logic. Non-obvious tradeoffs, workarounds, and constraints get a comment.

## Tech Stack

| Layer | Technologies |
|-------|-------------|
| Backend | Python 3.14, LangGraph, LangChain |
| Frontend | Next.js, React, Tailwind CSS |
| Deployment | Docker, Kubernetes, Helm |
| Linting | Ruff (Python), ESLint (TypeScript) |
| Testing | pytest (Python), Jest (TypeScript) |
| Package managers | uv (Python), npm (TypeScript) |

Architecture decisions and protocol choices live in `.specify/ARCHITECTURE.md`.

## Git Conventions

- [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <description>`
- Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `build`, `ci`
- DCO sign-off required: `Signed-off-by: <Name> <email>`
- Branch prefix: `prebuild/<type>/<description>` — required for CI to build images

## References

- `.specify/ARCHITECTURE.md` — architecture and protocol decisions
- `.specify/TESTING.md` — quality gates and test strategy
- `.specify/SPECS.md` — spec conventions and workflow
- `AGENTS.md` — AI agent behavior and autonomy expectations

## Governance

This constitution sets guardrails, not architecture. Amendments require a PR with rationale.

**Version**: 1.0.0 | **Last Amended**: 2026-04-14
