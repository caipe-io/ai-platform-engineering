# Description

Please provide a meaningful description of what this change will do, or is for.
Bonus points for including links to related issues, other PRs, or technical
references.

Note that by _not_ including a description, you are asking reviewers to do extra
work to understand the context of this change, which may lead to your PR taking
much longer to review, or result in it not being reviewed at all.

Please ensure commits conform to the [Commit Guideline](https://www.conventionalcommits.org/en/v1.0.0/)


## Type of Change

- [ ] Bugfix
- [ ] New Feature
- [ ] Breaking Change
- [ ] Refactor
- [ ] Documentation
- [ ] Other (please describe)

## Temporary Helm Charts (Optional)

For chart changes, you can test temporary versions before merging:
- **Base repo contributors:** Create a branch starting with `prebuild/` for automatic prebuilds
- **Fork contributors:** Ask a maintainer to add the `helm-prerelease` label
- Temporary charts are published to `ghcr.io/caipe-io/charts` with PR-specific versions
- Cleanup happens automatically when the PR closes or label is removed

## Checklist

- [ ] I have read the [contributing guidelines](CONTRIBUTING.md)
- [ ] Existing issues have been referenced (where applicable)
- [ ] I have verified this change is not present in other open pull requests
- [ ] Functionality is documented
- [ ] New selection controls follow the [selection-control decision table](https://github.com/caipe-io/ai-platform-engineering/blob/main/docs/docs/ui/selection-controls.md), or the custom interaction is justified
- [ ] All code style checks pass
- [ ] New code contribution is covered by automated tests
- [ ] All new and existing tests pass
