---
name: review-specific-pr
description: Perform a comprehensive code review of a specific GitHub Pull Request. Analyzes code changes, checks for bugs, security issues, test coverage, and coding standards compliance. Use when a user provides a PR URL or asks to review a specific pull request.
---

# Review a Specific PR

Given a GitHub PR URL or identifier, perform a thorough code review covering correctness, security, performance, testing, and style.

## Input

Requires a PR URL in the format \`https://github.com/{owner}/{repo}/pull/{number}\` or \`{owner}/{repo}#{number}\`.

## Instructions

### Phase 1: Context Gathering
1. **Fetch PR metadata** - title, description, author, branch, labels, linked issues
2. **Fetch the diff** - all changed files with additions and deletions
3. **Fetch CI/CD status** - check suite results, individual check runs
4. **Fetch existing reviews and comments** - prior feedback from other reviewers
5. **Fetch linked issues** - understand the intent behind the changes

### Phase 2: Code Analysis
Analyze each changed file for:

1. **Correctness & Logic**
   - Off-by-one errors, null/undefined handling, race conditions
   - Proper error handling and edge cases
   - Correct use of async/await patterns
   - State management issues

2. **Security**
   - Hardcoded credentials, API keys, tokens (NEVER allowed per project rules)
   - SQL injection, XSS, CSRF vulnerabilities
   - Insecure cryptographic algorithms (no MD5, SHA-1, DES, RC4)
   - Proper input validation and sanitization
   - Certificate handling (check expiration, key strength, signature algorithms)

3. **Performance**
   - Unnecessary re-renders (React), N+1 queries, unbounded loops
   - Memory leaks (event listeners, subscriptions not cleaned up)
   - Missing pagination for large datasets (OOM protection)
   - Expensive operations in hot paths

4. **Testing**
   - Are new code paths covered by tests?
   - Are edge cases tested?
   - Do existing tests still pass?
   - Integration test coverage for agent interactions

5. **Style & Standards**
   - Conventional commit format in PR title
   - DCO sign-off present in commits
   - Python: Black formatting, Ruff compliance, type hints, Google-style docstrings
   - TypeScript/React: Proper typing, component patterns
   - Import organization (stdlib, third-party, local-package, local-relative)

6. **Architecture**
   - Does the change follow existing patterns in the codebase?
   - Are new dependencies justified?
   - Is the change scope appropriate (not too large)?
   - Breaking changes properly documented?

### Phase 3: Review Output
Categorize findings by severity:
- **Critical** - Must fix before merge (bugs, security, data loss)
- **Major** - Should fix before merge (significant quality issues)
- **Minor** - Nice to have improvements (style, readability)
- **Praise** - Well-done patterns worth calling out

## Output Format

\`\`\`markdown
## PR Review: #{number} - {title}

**Author**: @{author} | **Branch**: {head} -> {base}
**Changed Files**: {count} | **Additions**: +{added} | **Deletions**: -{removed}
**CI Status**: Passing/Failing | **Reviews**: {status}

### Summary
[1-2 paragraph overview of what this PR does and overall assessment]

### Verdict: Approve / Request Changes / Comment

---

### Critical Issues (must fix)
#### 1. [File: path/to/file.py, Line 42]
**Issue**: Missing null check before accessing \`response.data\`
**Impact**: Will throw TypeError in production when API returns empty response
**Suggestion**:
\\\`\\\`\\\`python
if response and response.data:
    process(response.data)
\\\`\\\`\\\`

### Major Issues (should fix)
...

### Minor Suggestions
...

### What Looks Good
- Clean separation of concerns in the new agent module
- Good test coverage for the happy path

### Checklist
- [ ] Conventional commit title
- [ ] DCO sign-off on all commits
- [ ] Tests added/updated
- [ ] No hardcoded credentials
- [ ] Type hints present
- [ ] Docstrings for public APIs
\`\`\`

## Examples

- "Review the PR at https://github.com/caipe-io/ai-platform-engineering/pull/42"
- "Can you do a code review of caipe-io/ai-platform-engineering#123"
- "Review PR #567 in the ai-platform-engineering repo"

## Guidelines

- Always read the full diff, not just file names
- Check if the PR description adequately explains the "why" not just the "what"
- Verify that the PR size is reasonable (flag PRs with >500 lines changed as potentially too large)
- When finding security issues, reference the specific codeguard rule (e.g., no hardcoded credentials, no banned crypto algorithms)
- If tests are missing, suggest specific test cases rather than just saying "add tests"
- Be constructive - balance criticism with praise for good patterns
- Check for breaking changes that may need an ADR in \`docs/docs/changes/\`