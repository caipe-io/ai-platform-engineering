---
name: release-readiness-check
description: Verify all prerequisites are met before a release by checking PRs, CI/CD status, environment health, and blocking issues across GitHub, ArgoCD, and Jira. Use before cutting a release, deploying to production, or during release planning.
---

# Release Readiness Check

For this repository, use the maintained
[feature regression matrix](https://github.com/caipe-io/ai-platform-engineering/blob/main/docs/docs/development/caipe-regression-suite.md)
as the acceptance plan. In a source checkout, `.agents/skills/caipe-regression-suite/SKILL.md`
provides the execution procedure. Reuse the user's approved target and scope;
readiness review alone does not authorize deployments or additional test writes.

Orchestrate GitHub, ArgoCD, and Jira agents to perform a comprehensive pre-release verification covering code readiness, environment health, and issue resolution.

## Instructions

### Phase 1: Code Readiness (GitHub Agent)
1. **Check open PRs targeting release branch**:
   - Any unmerged PRs that should be included?
   - Draft PRs that may be blocking?
2. **CI/CD status on the release branch**:
   - All required checks passing?
   - Test coverage above threshold?
   - Linting and formatting passing?
3. **Recent commits**:
   - Last commit date on the release branch
   - Any commits since the last tag/release?
   - Conventional commit compliance
4. **Release artifacts**:
   - Changelog generated?
   - Version bumped appropriately?
   - Docker images built and tagged?

### Phase 2: Environment Health (ArgoCD Agent)
1. **Staging environment**:
   - All applications synced and healthy?
   - No pending syncs or failed operations?
   - Running the correct release candidate version?
2. **Production environment baseline**:
   - Current production version
   - All applications healthy before deploying?
   - Any recent incidents or rollbacks?
3. **Helm chart versions**:
   - Charts updated with new version?
   - Pre-release chart testing completed?

### Phase 3: Issue Resolution (Jira Agent)
1. **Blocking issues**:
   - Any issues labeled `release-blocker` or `p0`?
   - All issues in the release fixVersion resolved?
2. **Testing status**:
   - QA sign-off tickets completed?
   - Matching-candidate matrix results, expanded per enabled runtime, workflow, skill, legacy binding and bot provider/context?
   - Every assertion marked PASS, FAIL, BLOCKED, NOT_RUN or justified NOT_APPLICABLE, with evidence kind, artifact references and cleanup results?
   - Performance test results?
3. **Documentation**:
   - Release notes drafted?
   - Breaking changes documented?
   - ADR created for architectural changes?

### Phase 4: Release Verdict
Compile all checks into a Go/No-Go decision with clear justification.

## Output Format

```markdown
## Release Readiness Report
**Release**: v2.4.0
**Target Date**: February 10, 2026
**Verdict**: GO / NO-GO / CONDITIONAL

---

### Readiness Checklist
| Category | Check | Status | Details |
|----------|-------|--------|---------|
| **Code** | All PRs merged | PASS | 0 open PRs targeting main |
| **Code** | CI checks passing | PASS | All 12 checks green |
| **Code** | Conventional commits | PASS | All commits compliant |
| **Code** | Version bumped | PASS | v2.4.0 in pyproject.toml |
| **Env** | Staging healthy | PASS | All 15 apps synced |
| **Env** | Staging on RC | PASS | Running v2.4.0-rc.2 |
| **Env** | Production baseline | PASS | All apps healthy |
| **Issues** | No release blockers | FAIL | 1 blocker open |
| **Issues** | QA sign-off | PASS | QA-234 completed |
| **Issues** | Release notes | WARN | Draft exists, not finalized |

### Summary: 8/10 PASS | 1 FAIL | 1 WARN

### Blocking Issues
| Issue | Summary | Priority | Assignee | Status |
|-------|---------|----------|----------|--------|
| PLAT-567 | Auth token refresh fails on session timeout | P0 | @dev1 | In Progress |

**Impact**: This blocks the release. Auth regression would affect all users.
**ETA**: Fix PR #892 is in review, expected merge within 4 hours.

### Warnings
1. **Release notes not finalized** - Draft exists in PLAT-560, needs final review

### Release Comparison (v2.3.0 -> v2.4.0)
- **Commits**: 47
- **PRs Merged**: 12
- **Contributors**: 5
- **New Features**: 3
- **Bug Fixes**: 7
- **Breaking Changes**: 1 (documented in ADR-015)

### Recommended Actions
1. **MUST**: Resolve PLAT-567 and merge fix before release
2. **SHOULD**: Finalize release notes in PLAT-560
3. **THEN**: Tag v2.4.0 and trigger production deployment pipeline

### Rollback Plan
- **Previous stable version**: v2.3.0
- **Rollback method**: ArgoCD sync to v2.3.0 tag
- **Estimated rollback time**: ~5 minutes
```

## Examples

- "Are we ready for a release?"
- "Check release readiness for v2.4.0"
- "Is staging healthy and can we deploy to production?"
- "Are there any release blockers in Jira?"
- "Show me the pre-release checklist status"

## Guidelines

- A single failing critical check makes the verdict NO-GO
- Missing required live coverage is NO-GO; healthy pods, catalog checks, mocked tests and a first model reply cannot establish full feature or backward-compatibility acceptance
- Warnings make the verdict CONDITIONAL (can proceed with acknowledgment)
- Always include a rollback plan in the readiness report
- Check for breaking changes and verify they have corresponding ADRs in `docs/docs/changes/`
- If Helm charts are modified, verify pre-release chart testing was completed
- Include the commit/PR diff count so reviewers understand the release scope
- Never skip the staging health check - production deploys require a healthy staging baseline
- Include DCO sign-off verification for all commits in the release
