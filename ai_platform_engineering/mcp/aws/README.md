# mcp-aws

AWS MCP Server that exposes `aws_cli_execute` and `eks_kubectl_execute` as
[Model Context Protocol](https://modelcontextprotocol.io) tools over HTTP/SSE.

## Tools

| Tool | Description |
|------|-------------|
| `aws_cli_execute` | Execute read-only AWS CLI commands and explicitly enabled write operations. The operation allowlist is configurable; OAuth2 identity is passed to the target role as a session tag, and IAM policies authorize the account, region, action, and resources. |
| `eks_kubectl_execute` | Execute kubectl commands against an EKS cluster. Handles `aws eks update-kubeconfig` automatically. Secret data is redacted from output before returning to the LLM. |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_MODE` | `STDIO` | Transport mode: `stdio`, `sse`, or `http` |
| `MCP_HOST` | `localhost` | Bind host (HTTP/SSE mode) |
| `MCP_PORT` | `8000` | Bind port (HTTP/SSE mode) |
| `MCP_AUTH_MODE` | `none` | Set to `oauth2` in HTTP deployments to validate the user bearer token before any tool call. |
| `JWKS_URI` | — | OpenID Connect JWKS URL used when `MCP_AUTH_MODE=oauth2`. |
| `AUDIENCE` | — | Required JWT audience when `MCP_AUTH_MODE=oauth2`. |
| `ISSUER` | — | Required JWT issuer when `MCP_AUTH_MODE=oauth2`. |
| `MCP_AUTH_USERNAME_CLAIM` | `preferred_username` | JWT claim used as the trusted identity value for the STS session tag. Configure this for your identity provider. |
| `AWS_ALLOWED_WRITE_COMMANDS` | `ec2.stop-instances` | Comma-separated AWS `service.operation` names that may use the tagged target role, for example `ec2.stop-instances,ec2.start-instances`. |
| `AWS_IDENTITY_SESSION_TAG` | `username` | STS session tag key containing the configured identity claim. The target role trust and permission policies must use the same key. |
| `AWS_ACCOUNT_LIST` | — | Comma-separated `name:account_id` pairs for cross-account profiles |
| `CROSS_ACCOUNT_ROLE_NAME` | `caipe-read-only` | IAM role to assume in each account |
| `AWS_CLI_MAX_EXECUTION_TIME` | `30` | Timeout (seconds) for AWS CLI commands |
| `KUBECTL_MAX_EXECUTION_TIME` | `45` | Timeout (seconds) for kubectl commands |
| `AWS_CLI_MAX_OUTPUT_SIZE` | `20000` | Maximum output size (bytes) before truncation |
| `RESTRICT_KUBECTL_SECRETS` | `true` | Block `kubectl get/describe secret(s)` |
| `RESTRICT_KUBECTL_PROXY` | `true` | Block `kubectl proxy` |
| `RESTRICT_KUBECTL_EXEC` | `false` | Block `kubectl exec` |

A write request is accepted only when its `service.operation` is listed in
`AWS_ALLOWED_WRITE_COMMANDS`. The server requires OAuth2, reads the configured
identity claim from the JWT validated by `MCPAuthMiddleware`, and passes that
value to STS using `AWS_IDENTITY_SESSION_TAG`. The target role must be listed in
`AWS_ACCOUNT_LIST`, and its trust policy must allow the session tag. Its IAM
permissions define which enabled actions can run and which accounts, regions,
and resources they can affect. For owner-based access, compare the resource tag
with the caller session tag in IAM and configure administrator exceptions there.
The write path passes arguments directly to the AWS CLI without a shell.

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
