# Dependency management policy

This policy covers third-party dependencies in Python services, the UI,
documentation, container images, Helm charts, and GitHub Actions.

## Adding or updating dependencies

- Reuse existing dependencies before introducing another package.
- Review upstream maintenance, security advisories, license compatibility, and required runtime versions.
- Pin Python and Node package versions according to `scripts/check_pinned_deps.py`; local workspace dependencies are exempt.
- Update the owning component's manifest and lockfile together. Use `uv` for Python and the component's existing package manager for Node packages.
- Keep changes focused and explain any compatibility or migration requirements in the PR.
- Run the relevant component checks listed in [Contributing](CONTRIBUTING.md) and obtain maintainer approval before merge.

## Update coverage

- [Dependabot](.github/dependabot.yml) checks GitHub Actions weekly.
- Python, Node, container, and chart updates currently require maintainer or contributor PRs; the Dependabot configuration does not cover them.
- CI checks package pins and Python lockfile consistency through
  [Check pinned dependencies](.github/workflows/check-pinned-deps.yml) and
  [uv lock sync check](.github/workflows/uv-lock-check.yml).
- Updates from automation follow the same review and validation requirements as human contributions.

## Vulnerability handling

- The [Grype workflow](.github/workflows/security-scan.yml) scans the repository and supports on-demand container scans.
- Review findings in GitHub Code Scanning and assess affected versions, reachability, severity, and available fixes.
- Submit a focused dependency upgrade when a fix is available. Otherwise, document
  the mitigation or remaining exposure in the appropriate tracking issue.
- Use the private reporting and coordination process in [SECURITY.md](SECURITY.md) when a finding would disclose a vulnerability.
- Do not assume that a successful scan or CI run establishes that all dependencies are free of vulnerabilities.

## Policy metadata

When these practices or the project contacts change, update
[security-insights.yml](security-insights.yml) and its review dates to match the
verified repository state.
