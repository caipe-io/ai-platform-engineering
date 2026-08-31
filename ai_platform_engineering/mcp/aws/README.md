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

The server automatically uses `EcsContainer` when EKS Pod Identity injects a
container credential endpoint. When IRSA injects both `AWS_ROLE_ARN` and
`AWS_WEB_IDENTITY_TOKEN_FILE`, the server creates a web-identity source profile
and chains each cross-account profile through it. Static environment credentials
remain supported as a local-development fallback, but are not required on EKS.

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
  --build-arg AGENT_NAME=aws \
  --build-arg INSTALL_AWS_CLI=true \
  --build-arg INSTALL_KUBECTL=true \
  -f build/agents/Dockerfile.mcp \
  -t mcp-aws .
```
