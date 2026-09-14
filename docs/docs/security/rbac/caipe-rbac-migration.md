# CAIPE RBAC Helm Migration Guide

<!-- markdownlint-disable MD013 -->

**Audience:** platform engineers upgrading the `caipe/rbac` GitOps deployment from the platform-apps-deployment repository to the newest RBAC-capable CAIPE Helm chart.

This guide is based on comparing:

- Local runtime `.env` keys in `ai-platform-engineering/.env`
- The newest local CAIPE chart source under `charts/ai-platform-engineering`
- The live GitOps values under `/Users/sraradhy/outshift/platform-apps-deployment/applications/caipe/rbac/a`

Do not copy raw `.env` values into Git. The local `.env` file contains credential-looking values. Use it only as a key inventory, move production values into Vault or another External Secrets backend, and rotate any secret that was exposed outside local-only storage.

## Current GitOps State

The `caipe/rbac` ApplicationSet currently deploys:

```yaml
chart_name: ai-platform-engineering
chart_repo_url: ghcr.io/cnoe-io/pre-release-helm-charts
chart_version: 0.5.1-rc.25
namespace: caipe-rbac
```

This is the legacy location for the currently pinned RC. New prerelease and
release charts are published to the same canonical package as every other
lifecycle: `ghcr.io/caipe-io/charts/ai-platform-engineering`. Change the
repository and version together after the selected chart version exists in the
new organization; do not publish new charts to `pre-release-helm-charts`.

The deployment already enables the RBAC runtime stack:

- `tags.keycloak: true`
- `openfga.enabled: true`
- `openfgaAuthzBridge.enabled: true`
- `agentgateway.enabled: true`
- `tags.dynamic-agents: true`
- `tags.slack-bot: true`
- `tags.webex-bot: true`
- `global.skillScanner.enabled: true`
- `global.langgraphRedis.enabled: true`

The existing values render successfully with both the pinned OCI chart and the local chart source. The remaining work is mostly production hardening, explicit secret wiring, and replacing local `.env`-only features with Vault-backed Kubernetes configuration.

## Required Migration Changes

### 1. Wire Keycloak Client Secrets Explicitly

The newest chart expects production installs to reconcile real client secrets for the `caipe-ui`, `caipe-platform`, Slack bot, and Webex bot Keycloak clients. This prevents the dev placeholder secrets in the realm import from staying live.

Add explicit secret sources for the UI and platform clients:

```yaml
keycloak:
  uiClient:
    externalSecret:
      enabled: true
      secretStoreRef:
        name: vault-eticloud
        kind: ClusterSecretStore
      remoteRef:
        key: projects/caipe/rbac/caipe-ui
        property: KEYCLOAK_CAIPE_UI_CLIENT_SECRET

  platformClient:
    externalSecret:
      enabled: true
      secretStoreRef:
        name: vault-eticloud
        kind: ClusterSecretStore
      remoteRef:
        key: projects/caipe/rbac/caipe-ui
        property: KEYCLOAK_ADMIN_CLIENT_SECRET
```

The UI BFF also needs the same platform client secret for Keycloak Admin REST calls. If you adopt the new conventional secret name, set:

```yaml
caipe-ui:
  keycloakAdminClient:
    secretName: caipe-platform-secret
    secretKey: OIDC_CLIENT_SECRET
    clientId: caipe-platform
```

If you keep a custom in-cluster Secret name, set both values to the same Secret:

```yaml
keycloak:
  platformClient:
    secretRef: my-platform-client-secret

caipe-ui:
  keycloakAdminClient:
    secretName: my-platform-client-secret
    secretKey: OIDC_CLIENT_SECRET
    clientId: caipe-platform
```

### 2. Enable Strict Production Gates

After all four Keycloak client secrets are sourced from Vault or pre-created Kubernetes Secrets, enable strict mode:

```yaml
keycloak:
  strictClientSecrets: true
```

This makes the Keycloak init jobs fail if any dev placeholder client secret is still accepted.

The MongoDB chart also has a production password gate. Because `caipe/rbac` already uses MongoDB ExternalSecrets, enabling the gate should not block render:

```yaml
mongodb:
  strictPasswords: true
```

### 3. Port Credential Store Settings From `.env`

The local `.env` enables the Connections and Secrets credential store. To make the feature work in `caipe/rbac`, add the non-sensitive config to CAIPE UI and Dynamic Agents:

```yaml
caipe-ui:
  config:
    CAIPE_CREDENTIALS_ENABLED: "true"
    CREDENTIAL_STORE_BACKEND: "mongodb-envelope"
    CREDENTIAL_KEY_PROVIDER: "aws-kms"
    CREDENTIAL_KMS_CMK_ID: "<kms-key-alias-or-arn>"
    CREDENTIAL_KMS_REGION: "us-west-2"
    CREDENTIAL_SERVICE_AUDIENCE: "caipe-credential-service"
    CREDENTIAL_BOOTSTRAP_OAUTH_CONNECTORS: "true"

dynamic-agents:
  config:
    CAIPE_CREDENTIALS_ENABLED: "true"
    CREDENTIAL_API_URL: "http://a-caipe-rbac-argoapp-caipe-ui:3000/api/credentials"
    CREDENTIAL_SERVICE_AUDIENCE: "caipe-credential-service"
```

Then add the OAuth connector bootstrap keys to `caipe-ui.externalSecrets.data`. Use production callback URLs, not the localhost values from `.env`.

```yaml
caipe-ui:
  externalSecrets:
    data:
      - secretKey: GITHUB_CLIENT_ID
        remoteRef:
          key: projects/caipe/rbac/credential-oauth-connectors
          property: GITHUB_CLIENT_ID
      - secretKey: GITHUB_CLIENT_SECRET
        remoteRef:
          key: projects/caipe/rbac/credential-oauth-connectors
          property: GITHUB_CLIENT_SECRET
      - secretKey: GITHUB_REDIRECT_URI
        remoteRef:
          key: projects/caipe/rbac/credential-oauth-connectors
          property: GITHUB_REDIRECT_URI
```

Repeat the same pattern for:

| Provider | Required keys |
| --- | --- |
| GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_REDIRECT_URI` |
| Confluence / Atlassian | `CONFLUENCE_CLIENT_ID`, `CONFLUENCE_CLIENT_SECRET`, `CONFLUENCE_REDIRECT_URI` |
| Webex | `WEBEX_CLIENT_ID`, `WEBEX_CLIENT_SECRET`, `WEBEX_REDIRECT_URI` |
| PagerDuty | `PAGERDUTY_CLIENT_ID`, `PAGERDUTY_CLIENT_SECRET`, `PAGERDUTY_REDIRECT_URI`, `PAGERDUTY_SCOPES` |
| GitLab | `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET`, `GITLAB_REDIRECT_URI` |

Production redirect URI examples:

```text
https://grid.rbac.outshift.io/api/credentials/oauth/github/callback
https://grid.rbac.outshift.io/api/credentials/oauth/atlassian/callback
https://grid.rbac.outshift.io/api/credentials/oauth/webex/callback
https://grid.rbac.outshift.io/api/credentials/oauth/pagerduty/callback
https://grid.rbac.outshift.io/api/credentials/oauth/gitlab/callback
```

### 4. Share Agent Context HMAC Secret

`CAIPE_AGENT_CONTEXT_HMAC_SECRET` lets Dynamic Agents and the caipe-ui BFF sign
short-lived `agent_id` context on AgentGateway MCP calls; the openfga-authz-bridge
verifies the signature before enforcing per-agent `allowed_tools`. See
[Agent context HMAC](./agent-context-hmac.md) for the full flow.

Add the secret to the Kubernetes Secret consumed by all three components. For
the default `setup-caipe.sh` install, `caipe-ui-secret` holds the value and Helm
wires both subcharts:

```yaml
dynamic-agents:
  agentContext:
    existingSecret:
      name: caipe-ui-secret
      key: CAIPE_AGENT_CONTEXT_HMAC_SECRET

openfga-authz-bridge:
  agentContext:
    existingSecret:
      name: caipe-ui-secret
      key: CAIPE_AGENT_CONTEXT_HMAC_SECRET
```

External Secrets / Vault example (store once, reference from the same secret
name dynamic-agents and the bridge already use):

```yaml
caipe-ui:
  externalSecrets:
    data:
      - secretKey: CAIPE_AGENT_CONTEXT_HMAC_SECRET
        remoteRef:
          key: projects/caipe/rbac/caipe-ui
          property: CAIPE_AGENT_CONTEXT_HMAC_SECRET
```

Local dev: set the variable in root `.env` (documented in `.env.example` next to
`AGENT_GATEWAY_URL`). Compose passes it to dynamic-agents and openfga-authz-bridge.

### 5. Make RBAC Bypass and RAG OpenFGA Settings Explicit

The newest chart source makes the unsafe RBAC bypass and RAG OpenFGA settings explicit. Keep them explicit in `caipe/rbac`. RAG's team-scoped datasource/KB authorization is always on (not configurable) — only the OpenFGA connection and the bypass escape hatch are settings:

```yaml
caipe-ui:
  config:
    CAIPE_UNSAFE_RBAC_BYPASS: "false"

rag-stack:
  rag-server:
    env:
      OPENFGA_HTTP: "http://a-caipe-rbac-argoapp-openfga:8080"
      OPENFGA_STORE_NAME: "caipe-openfga"
      CAIPE_UNSAFE_RBAC_BYPASS: "false"
```

### 6. Move AgentGateway Ingress to Native Chart Values

`caipe/rbac` currently creates `gateway.grid.rbac.outshift.io` through `extraDeploy` as a temporary workaround. The chart now exposes `agentgateway.ingress`.

When the target chart version includes the ingress template, replace the custom `extraDeploy` Ingress with:

```yaml
agentgateway:
  enabled: true
  ingress:
    enabled: true
    className: nginx-internal
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt
      nginx.ingress.kubernetes.io/ssl-redirect: "true"
      nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
      nginx.ingress.kubernetes.io/enable-cors: "true"
      nginx.ingress.kubernetes.io/cors-allow-origin: "https://grid.rbac.outshift.io"
      nginx.ingress.kubernetes.io/cors-allow-methods: "GET, POST, PUT, DELETE, OPTIONS"
      nginx.ingress.kubernetes.io/cors-allow-headers: "DNT,Keep-Alive,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range,Authorization"
      nginx.ingress.kubernetes.io/cors-allow-credentials: "true"
    hosts:
      - host: gateway.grid.rbac.outshift.io
        paths:
          - path: /
            pathType: Prefix
    tls:
      - secretName: gateway-grid-rbac-tls
        hosts:
          - gateway.grid.rbac.outshift.io
```

Remove only the old AgentGateway Ingress from `extraDeploy`; keep unrelated resources such as the OpenFGA datastore ExternalSecret and PostgreSQL resources.

## Suggested Rollout Order

1. Add missing Vault properties for Keycloak client secrets, credential OAuth connectors, and `CAIPE_AGENT_CONTEXT_HMAC_SECRET`.
2. Add the new ExternalSecret mappings while keeping `keycloak.strictClientSecrets: false`.
3. Sync ArgoCD and verify all ExternalSecrets become `Ready=True`.
4. Verify Keycloak auth reconcile jobs update `caipe-ui`, `caipe-platform`, `caipe-slack-bot`, and `caipe-webex-bot`.
5. Enable `keycloak.strictClientSecrets: true` and `mongodb.strictPasswords: true`.
6. Enable credential store config and OAuth connector bootstrap.
7. Migrate AgentGateway ingress from `extraDeploy` to native `agentgateway.ingress` after confirming the deployed chart includes that template.

## Render Verification

From the `ai-platform-engineering` repo:

```bash
helm template a-caipe-rbac-argoapp \
  oci://ghcr.io/cnoe-io/pre-release-helm-charts/ai-platform-engineering \
  --version 0.5.1-rc.25 \
  -n caipe-rbac \
  -f /Users/sraradhy/outshift/platform-apps-deployment/applications/caipe/rbac/a/values.yaml
```

For local chart source validation:

```bash
helm template a-caipe-rbac-argoapp \
  charts/ai-platform-engineering \
  -n caipe-rbac \
  -f /Users/sraradhy/outshift/platform-apps-deployment/applications/caipe/rbac/a/values.yaml
```

Both commands should render without errors before opening a PR.

## Runtime Verification

After ArgoCD sync:

```bash
kubectl -n caipe-rbac get pods
kubectl -n caipe-rbac get externalsecret,secret | grep -E 'keycloak|caipe-platform|caipe-ui|openfga'
```

Check Keycloak reconciliation logs:

```bash
kubectl -n caipe-rbac logs job/<auth-reconcile-job-name> | grep -E 'client_secret|Strict mode'
```

Check that the UI has the expected non-sensitive config:

```bash
kubectl -n caipe-rbac get configmap a-caipe-rbac-argoapp-caipe-ui-config -o yaml \
  | grep -E 'CAIPE_CREDENTIALS_ENABLED|OPENFGA_RECONCILE_ENABLED|CAIPE_UNSAFE_RBAC_BYPASS|DYNAMIC_AGENTS_URL'
```

Check that Dynamic Agents receives the shared secret source without printing the value:

```bash
kubectl -n caipe-rbac get deploy a-caipe-rbac-argoapp-dynamic-agents -o yaml \
  | grep -E 'a-caipe-rbac-argoapp-caipe-ui-secret|CAIPE_AGENT_CONTEXT_HMAC_SECRET'
```

Finally, exercise the user-facing flows:

- Log in through `https://grid.rbac.outshift.io`.
- Open Admin -> ReBAC and confirm OpenFGA checks work.
- Open Admin -> Connections and confirm OAuth connector rows exist.
- Create or invoke a Dynamic Agent that uses a protected MCP server.
- Run a Slack and Webex route reload from the Admin UI.

## Rollback

If the first strict-mode sync fails, revert only:

```yaml
keycloak:
  strictClientSecrets: false

mongodb:
  strictPasswords: false
```

Leave the new ExternalSecret mappings in place. Fix the missing Vault property or Secret name, re-sync, then re-enable strict mode.

If credential bootstrap causes startup failures, temporarily disable:

```yaml
caipe-ui:
  config:
    CREDENTIAL_BOOTSTRAP_OAUTH_CONNECTORS: "false"
```

Keep `CAIPE_CREDENTIALS_ENABLED` enabled if the credential API itself is healthy; disabling only bootstrap lets operators repair connector configuration through the Admin UI.
