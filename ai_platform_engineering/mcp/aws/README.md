# mcp-aws

AWS MCP Server that exposes `aws_cli_execute` and `eks_kubectl_execute` as
[Model Context Protocol](https://modelcontextprotocol.io) tools over HTTP/SSE.

## Tools

| Tool | Description |
|------|-------------|
| `aws_cli_execute` | Execute read-only AWS CLI commands (`describe-*`, `list-*`, `get-*`). Write/destructive operations are blocked by default. Supports cross-account profiles via `AWS_ACCOUNT_LIST`. |
| `eks_kubectl_execute` | Execute kubectl commands against an EKS cluster. Handles `aws eks update-kubeconfig` automatically. Secret data is redacted from output before returning to the LLM. |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_MODE` | `STDIO` | Transport mode: `stdio`, `sse`, or `http` |
| `MCP_HOST` | `localhost` | Bind host (HTTP/SSE mode) |
| `MCP_PORT` | `8000` | Bind port (HTTP/SSE mode) |
| `AWS_ACCOUNT_LIST` | — | Comma-separated `name:account_id` pairs for cross-account profiles |
| `CROSS_ACCOUNT_ROLE_NAME` | `caipe-read-only` | IAM role to assume in each account |
| `AWS_CREDENTIAL_SOURCE` | auto | Optional AWS CLI credential source override: `Environment`, `EcsContainer`, or `Ec2InstanceMetadata` |
| `AWS_CLI_MAX_EXECUTION_TIME` | `30` | Timeout (seconds) for AWS CLI commands |
| `KUBECTL_MAX_EXECUTION_TIME` | `45` | Timeout (seconds) for kubectl commands |
| `AWS_CLI_MAX_OUTPUT_SIZE` | `20000` | Maximum output size (bytes) before truncation |
| `RESTRICT_KUBECTL_SECRETS` | `true` | Block `kubectl get/describe secret(s)` |
| `RESTRICT_KUBECTL_PROXY` | `true` | Block `kubectl proxy` |
| `RESTRICT_KUBECTL_EXEC` | `false` | Block `kubectl exec` |

### Workload identity

Cross-account profiles select their base credentials in this order:

1. An explicit `AWS_CREDENTIAL_SOURCE` override.
2. `EcsContainer` when `AWS_CONTAINER_CREDENTIALS_FULL_URI` or
   `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` is set, including EKS Pod Identity.
   This takes precedence over legacy IRSA settings that may still be present.
3. An IRSA source profile when both `AWS_ROLE_ARN` and
   `AWS_WEB_IDENTITY_TOKEN_FILE` are set. Setting only one fails startup with a
   configuration error unless an override or container provider is selected.
4. `Environment` for local or legacy static credentials.

IRSA profiles chain through a generated web-identity source profile. EKS workload
identity does not require static access keys in environment variables. These
settings apply when `AWS_ACCOUNT_LIST` generates cross-account profiles; without
an account list, the AWS CLI uses its existing credential chain.

When IRSA is selected, its token-file path must not start or end with whitespace,
and account names cannot use the reserved source profile name
`mcp-workload-identity`. IRSA settings are ignored when an explicit credential
source or container provider is selected.

## Running locally

```bash
cd ai_platform_engineering/agents/aws/mcp
uv run mcp-aws
```

## Docker

Built via the shared `build/agents/Dockerfile.mcp` with `AGENT_NAME=aws`,
`INSTALL_AWS_CLI=true`, and `INSTALL_KUBECTL=true`:

```bash
docker build \
  --pull --no-cache-filter runtime \
  --build-arg AGENT_NAME=aws \
  --build-arg INSTALL_AWS_CLI=true \
  --build-arg INSTALL_KUBECTL=true \
  -f build/agents/Dockerfile.mcp \
  -t mcp-aws .
```

Release and prebuild workflows read the install flags from `.github/agents.json`.
AWS builds pull current base images and rebuild the `runtime` stage without
Docker layer caching, while retaining the Python dependency builder cache.
Each new tag therefore refreshes AWS CLI v2 (`aws-cli-2`) and the latest patch
of kubectl 1.36 (`kubectl-1.36-default`) available in the Wolfi package repository.
This tracks repository availability rather than immediately installing every
upstream release. Kubectl minor upgrades require an explicit package change to
preserve compatibility with target clusters.

The image build runs `aws --version` and `kubectl version --client=true` as the
runtime user. A missing or unusable binary fails the build, and the installed
versions appear in the build log. Existing images retain their installed
versions until rebuilt and deployed.
