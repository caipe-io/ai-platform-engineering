# Privileged workflow policy

## Size labels

- `pr-size-label.json` targets only `.github/workflows/pr-size-label.yml`.
- Allows its two existing events; preserves fork labels and manual backfill.
- No actor restriction: external contributors must still receive labels.
- Runs trusted code at `github.workflow_sha`; never runs PR code.
- This file is a reviewed request body, **not an automatically applied policy**.

GitHub moved default `pull_request_target` enforcement to **December 2, 2026**.
See the [updated announcement](https://github.blog/changelog/2026-09-17-workflow-execution-protections-in-github-actions-generally-available/).

## Administrator rollout

1. Inspect existing policies, including inherited policies:
   `gh api 'repos/{owner}/{repo}/actions/policies?has_parents=true'`.
2. Inspect each applicable policy before making changes. Do not replace unrelated
   rules or assume a repository policy overrides an inherited restriction.
3. With repository Administration write access, create the reviewed policy:

   ```bash
   gh api --method POST 'repos/{owner}/{repo}/actions/policies' \
     --input .github/actions-policies/pr-size-label.json
   ```

   If an equivalent policy already exists, compare it and update that policy by
   ID instead of creating a duplicate. Where available, evaluate mode can precede
   activation; it does not replace the final active-policy check.
4. Read the policy back and inspect execution-policy insights. Verify internal and
   fork PR events plus manual backfill. Confirm unrelated workflows retain their
   existing policy treatment. Record the policy ID and run URLs on the PR.

Reference: [Actions policies REST API](https://docs.github.com/en/rest/actions/policies#create-a-repository-actions-policy).

## Validation and handoff

- Run `node --test .github/pr-size/*.test.js` and zizmor on the size-label workflow.
- Verify policy JSON targets only `.github/workflows/pr-size-label.yml` and allows
  only `pull_request_target` and `workflow_dispatch`.
- Keep the existing trusted workflow-SHA checkout, disabled credential persistence,
  and minimum label permissions. No PR code, artifacts, or cache are consumed.
- Retain the justified `dangerous-triggers` exception in `.github/zizmor.yml`.
- Administrator activation and internal/fork PR plus manual-backfill run evidence
  are required before #2834 can close. Merging this file does not apply a policy.
- Inspect inherited restrictions before activation; a local allowlist must not be
  presented as overriding an inherited denial. Record the policy ID and run URLs.
