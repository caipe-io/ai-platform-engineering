# CAS integration branch

Review small changes independently; validate them together before merging to main.

```text
Small change PRs -> prebuild/feat/cas-authz -> draft integration PR -> main
                              |
                              +-> prebuild images -> dev validation
```

## Working agreement

- Branch each change from `prebuild/feat/cas-authz` and target that branch in its PR.
- Require maintainer review, DCO and relevant passing checks before merging a change.
  Main's branch-protection rules do not automatically apply to this branch.
- Keep the integration PR to `main` open and draft until the combined work is validated.
- Merge `main` into the integration branch periodically; do not rebase or force-push
  the shared branch. Refresh child branches when needed.
- Keep deployment-specific configuration and identities out of this repository.

## Builds and testing

- The draft integration PR drives the existing `prebuild/*` workflows. Merging a
  child PR updates its head and triggers builds for applicable changed components.
- Use the integration PR's published artifact list, not a child PR's image tags,
  when testing the combined changes. Tags follow `<stable-version>-feat-cas-authz-<count>`.
- Record image digests and the integration commit in validation notes. Not every
  component is rebuilt on every update; use the published per-component references.
- For a rerun, use **[Prebuild] Manual PR Fanout** with the integration PR number.
  This still applies component-change detection; it is not a force-build of the stack.
- A successful image build is not proof of passing tests or successful dev validation.
- Keep the integration PR open while using its temporary artifacts; closing PRs can
  trigger prebuild cleanup. Remove this working agreement when integration is complete.

## Initial work

- Review agent-grant lifecycle changes in [#2827](https://github.com/caipe-io/ai-platform-engineering/pull/2827).
- Address session/token consistency separately; do not mix it into grant lifecycle.
- Continue CAS migration in small reviews, including the Admin access-decision view
  tracked in [#2828](https://github.com/caipe-io/ai-platform-engineering/issues/2828).

This branch is an integration vehicle, not a claim that CAS migration is complete.
