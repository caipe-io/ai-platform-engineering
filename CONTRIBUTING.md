# Contributing Guide

Thank you for considering contributing to this project! We welcome contributions from the community and are excited to collaborate with you.

## Prerequisites

| Tool | Purpose | Install |
|---|---|---|
| [uv](https://docs.astral.sh/uv/) | Python package manager | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| [Docker](https://docs.docker.com/get-docker/) | Container runtime | [docs.docker.com](https://docs.docker.com/get-docker/) |
| [Helm 3](https://helm.sh/docs/intro/install/) | Kubernetes package manager | `brew install helm` |
| [helm-docs](https://github.com/norwoodj/helm-docs) | Auto-generate chart READMEs from `values.yaml` | see below |

### Installing helm-docs

```bash
# macOS / Linux (Homebrew)
brew install helm-docs

# Any platform (Go)
go install github.com/norwoodj/helm-docs/cmd/helm-docs@latest

# Binary download (Linux / macOS / Windows)
# https://github.com/norwoodj/helm-docs/releases
```

After modifying `values.yaml` in any chart, regenerate the chart READMEs:

```bash
make helm-docs
```

## Commit Requirements

Both of these are enforced by CI on every pull request.

### Developer Certificate of Origin (DCO)

Every commit must carry a `Signed-off-by` trailer certifying the
[Developer Certificate of Origin](https://developercertificate.org/). The `DCO`
check fails the PR if any commit is missing one.

```bash
# Sign off as you commit
git commit -s -m "fix(ui): correct the widget alignment"
```

This appends a trailer matching your Git `user.name` and `user.email`:

```text
Signed-off-by: Your Name <you@example.com>
```

Forgot to sign off? Amend the last commit, or rewrite the whole branch:

```bash
git commit --amend -s --no-edit          # last commit only
git rebase --signoff main                # every commit on the branch
```

Then force-push the branch. Sign-off is a personal certification — only ever
sign off in your own name.

### Conventional Commits

Commit messages must follow
[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) in the
form `type(scope): description`. Use the same format for PR titles.

Allowed types (see `.github/workflows/conventional_commits.yml`):

`feat`, `fix`, `docs`, `style`, `refactor`, `test`, `build`, `perf`, `ci`,
`chore`, `revert`, `merge`, `wip`, `bump`, `release`

```text
feat(rag): add userinfo caching
fix(dynamic-agents): retry on transient Bedrock throttling
docs(charts): document the OpenFGA values
```

## Branch Naming

Prefix a branch with `prebuild/` when you want CI to build and publish
prebuild container images for the PR — for example
`prebuild/feat/rag-batch-job-status`. Images are pushed to their canonical
`ghcr.io/caipe-io/<component>` packages with temporary PR tags. Helm charts use
their canonical `oci://ghcr.io/caipe-io/charts/<chart>` packages with the same
temporary lifecycle. Prebuild artifacts are cleaned up when the PR closes.

Without the prefix the standard CI build runs instead, and no prebuild image is
published.

## Local Checks

Run the relevant checks before opening a PR. These are the same commands CI runs.

| Scope | Command |
|---|---|
| Python lint (Ruff) | `make lint` — `make lint-fix` to autofix |
| CAIPE UI unit tests | `make caipe-ui-tests` |
| CAIPE UI RBAC regression | `make caipe-ui-e2e-rbac` |
| Core Python tests | `make test-core` |
| Chart READMEs | `make helm-docs` after editing any `values.yaml` |

`make help` lists the full set of targets, including the per-component
`make test-mcp-*` suites.

## Pull Request (PR) Policy

1. **Fork the Repository**: Start by forking the repository and creating a new branch for your changes.
2. **Write Clear Commit Messages**: Follow the [Commit Requirements](#commit-requirements) above — sign-off and Conventional Commits are both enforced.
3. **Follow Coding Standards**: Adhere to the project's coding standards and guidelines.
4. **Testing**: Test your changes thoroughly before submitting a PR. See [Local Checks](#local-checks).
5. **PR Submission**:
    - Provide a clear description of the changes in the PR.
    - Reference any related issues or tickets.
6. **Approval Process**:
    - All PRs must be reviewed and approved by at least one maintainer.
    - Address any feedback promptly to ensure smooth progress.

## Code of Conduct

We are committed to fostering an open and welcoming environment. By participating in this project, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

Thank you for contributing!
