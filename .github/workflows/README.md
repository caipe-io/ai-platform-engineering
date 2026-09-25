# GitHub Actions Workflows

This directory contains automated workflows for the AI Platform Engineering project.

## Available Workflows

See the `.github/workflows/` directory for the full list of CI/CD workflows.

### PR size labels

- **[Review] PR Size Label** (`pr-size-label.yml`): advisory `size/XS`–`size/XXL`
  labels for open PRs, including forks. Reads PR metadata only; checks out the trusted
  workflow revision with credentials persistence disabled.
- **Manual backfill after merge:** run on `main`; leave `pr_number` empty for all
  open PRs, or enter a number to refresh one PR.
- **Configuration:** `.github/pr-size/config.json` defines buckets, label metadata,
  and generated-file globs. Changes take effect from the trusted base revision.
- **Errors:** incomplete file lists and PRs above 3,000 files keep their current
  labels. Other API failures are logged per PR; rerun the workflow after recovery.
  Concurrent changes trigger at most three reconciliation attempts.
- **Tests:** `pr-size-labels-test.yml` runs calculation and mocked API regression
  tests without a write token. Local command: `node --test .github/pr-size/*.test.js`.

## General Information

### Monitoring Workflows

View workflow runs:
1. Go to the **Actions** tab in your GitHub repository
2. Select the workflow you want to monitor
3. View logs for detailed execution information

### Common Issues & Troubleshooting

**Issue**: Workflow fails at checkout step
- Verify the repository URL and branch names are correct
- Check that the repository is accessible

**Issue**: Permission denied when pushing to ghcr.io
- Verify that the repository has package write permissions enabled
- Go to Settings → Actions → General → Workflow permissions
- Select "Read and write permissions"

**Issue**: Build command fails
- Check that the correct runtime versions are being used (Node.js, Python, etc.)
- Verify the build commands match what's in package.json or project files
- Review build logs for specific error messages

**Issue**: Dockerfile not found
- Ensure the Dockerfile exists at the expected path
- Update the `file` parameter in the Docker build step to point to the correct location

### Security Best Practices

All workflows in this repository follow security best practices:
- ✅ Uses GitHub's OIDC token for authentication (no long-lived credentials)
- ✅ Generates attestations for supply chain security (where applicable)
- ✅ Implements build caching for faster subsequent builds
- ✅ Multi-platform builds ensure compatibility across architectures
- ✅ Minimal permissions granted via `permissions` blocks
- ✅ No secrets hardcoded in workflow files

### Adding New Workflows

To add a new workflow:

1. **Create workflow file**: Create a new `.yml` file in `.github/workflows/`
2. **Define triggers**: Specify when the workflow should run (push, PR, schedule, etc.)
3. **Add jobs and steps**: Define what the workflow should do
4. **Set permissions**: Grant only necessary permissions
5. **Test locally**: Use tools like [act](https://github.com/nektos/act) to test locally
6. **Document**: Add documentation to this README
7. **Update docs**: Add relevant documentation to `docs/docs/changes/`

### Workflow File Structure

```yaml
name: Workflow Name

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]
  workflow_dispatch:

env:
  # Environment variables

jobs:
  job-name:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    
    steps:
      - name: Checkout code
        uses: actions/checkout@v4
      
      - name: Run tests
        run: make test
      
      # Additional steps...
```

### Useful Resources

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [GitHub Actions Marketplace](https://github.com/marketplace?type=actions)
- [Workflow Syntax Reference](https://docs.github.com/en/actions/reference/workflow-syntax-for-github-actions)
- [GitHub Container Registry Documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [act - Local GitHub Actions](https://github.com/nektos/act)

---

**Last Updated:** October 30, 2025  
**Maintainer:** Platform Engineering Team

