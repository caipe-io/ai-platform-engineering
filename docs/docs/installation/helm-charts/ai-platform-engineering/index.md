---
id: ai-platform-engineering-chart
sidebar_label: ai-platform-engineering
---

:::caution Auto-generated
This page is auto-generated from the Helm chart source. Do not edit directly.
Regenerate with `make docs-helm-charts`.
:::

# ai-platform-engineering

Parent chart to deploy CAIPE — dynamic agents, per-agent MCP servers, RBAC, and the UI

| | |
|---|---|
| **Version** | `0.5.68` |
| **Type** | application |

## Quick Start

```bash
# Add and install the chart
helm install ai-platform-engineering oci://ghcr.io/cnoe-io/charts/ai-platform-engineering --version 0.5.68

# Upgrade an existing release
helm upgrade ai-platform-engineering oci://ghcr.io/cnoe-io/charts/ai-platform-engineering --version 0.5.68
```

## Customizing Values

Override default values using `--set` flags or a custom values file:

```bash
# Override individual values
helm install ai-platform-engineering oci://ghcr.io/cnoe-io/charts/ai-platform-engineering --version 0.5.68 \
  --set replicaCount=2

# Use a custom values file
helm install ai-platform-engineering oci://ghcr.io/cnoe-io/charts/ai-platform-engineering --version 0.5.68 \
  -f custom-values.yaml

# Show all configurable values
helm show values oci://ghcr.io/cnoe-io/charts/ai-platform-engineering --version 0.5.68
```

## Reading the Values Table

| Column | Meaning |
|--------|---------|
| **Key** | Dot-separated path into `values.yaml` (e.g. `image.repository`) |
| **Type** | Go/Helm data type (`string`, `int`, `bool`, `object`, `list`) |
| **Default** | Value used when not overridden |
| **Description** | What the parameter controls |

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| agentgateway.enabled | bool | `true` |  |
| agentgateway.extraEnv | list | `[]` |  |
| agentgateway.extraEnvFrom | list | `[]` |  |
| agentgateway.image.pullPolicy | string | `"IfNotPresent"` |  |
| agentgateway.image.repository | string | `"cr.agentgateway.dev/agentgateway"` |  |
| agentgateway.image.tag | string | `"v1.1.0"` |  |
| agentgateway.skillScanner.enabled | bool | `false` |  |
| caipe-ui.config.APP_NAME | string | `"CAIPE"` |  |
| caipe-ui.config.CAIPE_CREDENTIALS_ENABLED | string | `"false"` |  |
| caipe-ui.config.CAIPE_ORG_DISPLAY_NAME | string | `"CAIPE"` |  |
| caipe-ui.config.CAIPE_ORG_KEY | string | `"caipe"` |  |
| caipe-ui.config.CAIPE_UNSAFE_RBAC_BYPASS | string | `"false"` |  |
| caipe-ui.config.CREDENTIAL_BOOTSTRAP_OAUTH_CONNECTORS | string | `"false"` |  |
| caipe-ui.config.CREDENTIAL_KEY_PROVIDER | string | `"local-cmk"` |  |
| caipe-ui.config.CREDENTIAL_KMS_CMK_ID | string | `""` |  |
| caipe-ui.config.CREDENTIAL_KMS_REGION | string | `""` |  |
| caipe-ui.config.CREDENTIAL_SERVICE_AUDIENCE | string | `"caipe-credential-service"` |  |
| caipe-ui.config.CREDENTIAL_STORE_BACKEND | string | `"mongodb-envelope"` |  |
| caipe-ui.config.DEFAULT_AGENT_ID | string | `""` |  |
| caipe-ui.config.DESCRIPTION | string | `"Where Humans and AI agents collaborate to deliver high quality outcomes."` |  |
| caipe-ui.config.ENABLE_SUBAGENT_CARDS | string | `"true"` |  |
| caipe-ui.config.ENV_BADGE | string | `""` |  |
| caipe-ui.config.IDENTITY_SYNC_LOGIN_AUTO_CREATE_TEAMS | string | `"false"` |  |
| caipe-ui.config.IDENTITY_SYNC_LOGIN_CLAIMS_ENABLED | string | `"false"` |  |
| caipe-ui.config.KEYCLOAK_REALM | string | `"caipe"` |  |
| caipe-ui.config.KEYCLOAK_RESOURCE_SERVER_ID | string | `"caipe-platform"` |  |
| caipe-ui.config.KEYCLOAK_URL | string | `""` |  |
| caipe-ui.config.LOGO_STYLE | string | `"default"` |  |
| caipe-ui.config.LOGO_URL | string | `"/logo.svg"` |  |
| caipe-ui.config.MONGODB_DATABASE | string | `"caipe"` |  |
| caipe-ui.config.NEXTAUTH_URL | string | `"http://localhost:3000"` |  |
| caipe-ui.config.NODE_ENV | string | `"production"` |  |
| caipe-ui.config.OPENFGA_HTTP | string | `""` |  |
| caipe-ui.config.OPENFGA_RECONCILE_ENABLED | string | `"true"` |  |
| caipe-ui.config.OPENFGA_STORE_NAME | string | `"caipe-openfga"` |  |
| caipe-ui.config.SCHEDULER_URL | string | `"http://caipe-scheduler:8080"` |  |
| caipe-ui.config.SHOW_POWERED_BY | string | `"false"` |  |
| caipe-ui.config.SKILLS_DIR | string | `"/app/data/skills"` |  |
| caipe-ui.config.SKILLS_HELPER_FILE | string | `"/app/data/skills-live-skills/caipe-skills.py"` |  |
| caipe-ui.config.SKILLS_HOOK_FILE | string | `"/app/data/skills-live-skills/caipe-catalog.sh"` |  |
| caipe-ui.config.SKILLS_LIVE_SKILLS_FILE | string | `"/app/data/skills-live-skills/live-skills.md"` |  |
| caipe-ui.config.SKILLS_UPDATE_SKILLS_FILE | string | `"/app/data/skills-live-skills/update-skills.md"` |  |
| caipe-ui.config.SKILL_SCANNER_URL | string | `""` |  |
| caipe-ui.config.SLACK_BOT_ADMIN_AUDIENCE | string | `"caipe-slack-bot-admin"` |  |
| caipe-ui.config.SLACK_BOT_ADMIN_URL | string | `""` |  |
| caipe-ui.config.SLACK_DEFAULT_AGENT_ID | string | `""` |  |
| caipe-ui.config.SLACK_DEFAULT_TEAM_SLUG | string | `""` |  |
| caipe-ui.config.SLACK_WORKSPACE_ALIAS | string | `"CAIPE"` |  |
| caipe-ui.config.SSO_ENABLED | string | `"false"` |  |
| caipe-ui.config.TAGLINE | string | `"Multi-Agent Workflow Automation"` |  |
| caipe-ui.config.WEBEX_BOT_ADMIN_AUDIENCE | string | `"caipe-webex-bot-admin"` |  |
| caipe-ui.config.WEBEX_BOT_ADMIN_CLIENT_ID | string | `"caipe-ui"` |  |
| caipe-ui.config.WEBEX_BOT_ADMIN_URL | string | `""` |  |
| caipe-ui.config.WEBEX_THREAD_CONTEXT_ENABLED | string | `"true"` |  |
| caipe-ui.config.WEBEX_THREAD_CONTEXT_MAX_CHARS | string | `"4000"` |  |
| caipe-ui.config.WEBEX_THREAD_CONTEXT_MAX_MESSAGES | string | `"10"` |  |
| caipe-ui.existingSecret | string | `""` |  |
| caipe-ui.externalSecrets.apiVersion | string | `"v1beta1"` |  |
| caipe-ui.externalSecrets.data | list | `[]` |  |
| caipe-ui.externalSecrets.enabled | bool | `false` |  |
| caipe-ui.externalSecrets.secretStoreRef.kind | string | `"ClusterSecretStore"` |  |
| caipe-ui.externalSecrets.secretStoreRef.name | string | `"vault"` |  |
| caipe-ui.image.pullPolicy | string | `"IfNotPresent"` |  |
| caipe-ui.image.repository | string | `"ghcr.io/caipe-io/caipe-ui"` |  |
| caipe-ui.image.tag | string | `""` |  |
| caipe-ui.ingress.annotations | object | `{}` |  |
| caipe-ui.ingress.className | string | `"nginx"` |  |
| caipe-ui.ingress.enabled | bool | `false` |  |
| caipe-ui.ingress.hosts[0].host | string | `"caipe-ui.local"` |  |
| caipe-ui.ingress.hosts[0].paths[0].path | string | `"/"` |  |
| caipe-ui.ingress.hosts[0].paths[0].pathType | string | `"Prefix"` |  |
| caipe-ui.ingress.tls | list | `[]` |  |
| caipe-ui.keycloakAdminClient.clientId | string | `"caipe-platform"` |  |
| caipe-ui.keycloakAdminClient.secretKey | string | `"OIDC_CLIENT_SECRET"` |  |
| caipe-ui.keycloakAdminClient.secretName | string | `"caipe-platform-secret"` |  |
| caipe-ui.mongodb.auth.database | string | `"caipe"` |  |
| caipe-ui.mongodb.auth.rootPassword | string | `"changeme"` |  |
| caipe-ui.mongodb.auth.rootUsername | string | `"admin"` |  |
| caipe-ui.mongodb.enabled | bool | `false` |  |
| caipe-ui.mongodb.externalSecrets.apiVersion | string | `"v1beta1"` |  |
| caipe-ui.mongodb.externalSecrets.data | list | `[]` |  |
| caipe-ui.mongodb.externalSecrets.enabled | bool | `false` |  |
| caipe-ui.mongodb.externalSecrets.secretStoreRef.kind | string | `"ClusterSecretStore"` |  |
| caipe-ui.mongodb.externalSecrets.secretStoreRef.name | string | `"vault"` |  |
| caipe-ui.mongodb.image.pullPolicy | string | `"IfNotPresent"` |  |
| caipe-ui.mongodb.image.repository | string | `"mongo"` |  |
| caipe-ui.mongodb.image.tag | string | `"7.0"` |  |
| caipe-ui.mongodb.nameOverride | string | `"mongodb"` |  |
| caipe-ui.mongodb.persistence.enabled | bool | `true` |  |
| caipe-ui.mongodb.persistence.size | string | `"10Gi"` |  |
| caipe-ui.mongodb.persistence.storageClass | string | `""` |  |
| caipe-ui.mongodb.service.port | int | `27017` |  |
| caipe-ui.mongodb.strictPasswords | bool | `false` |  |
| caipe-ui.nameOverride | string | `"caipe-ui"` |  |
| caipe-ui.oauthConnectors | list | `[]` |  |
| caipe-ui.oktaSync.enabled | bool | `false` |  |
| caipe-ui.oktaSync.oauth.clientId | string | `""` |  |
| caipe-ui.oktaSync.oauth.keyId | string | `""` |  |
| caipe-ui.oktaSync.orgUrl | string | `""` |  |
| caipe-ui.schedulerRunnerClient.clientId | string | `"caipe-scheduler-runner"` |  |
| caipe-ui.schedulerRunnerClient.secretKey | string | `"KC_SCHEDULER_CLIENT_SECRET"` |  |
| caipe-ui.schedulerRunnerClient.secretName | string | `""` |  |
| caipe-ui.service.port | int | `3000` |  |
| caipe-ui.skills.enabled | bool | `true` |  |
| caipe-ui.volumeMounts[0].mountPath | string | `"/app/data/skills"` |  |
| caipe-ui.volumeMounts[0].name | string | `"skill-templates"` |  |
| caipe-ui.volumeMounts[0].readOnly | bool | `true` |  |
| caipe-ui.volumeMounts[1].mountPath | string | `"/app/data/skills-live-skills"` |  |
| caipe-ui.volumeMounts[1].name | string | `"skills-live-skills"` |  |
| caipe-ui.volumeMounts[1].readOnly | bool | `true` |  |
| caipe-ui.volumes[0].configMap.name | string | `"skill-templates"` |  |
| caipe-ui.volumes[0].name | string | `"skill-templates"` |  |
| caipe-ui.volumes[1].configMap.name | string | `"skills-live-skills"` |  |
| caipe-ui.volumes[1].configMap.optional | bool | `true` |  |
| caipe-ui.volumes[1].name | string | `"skills-live-skills"` |  |
| dynamic-agents.agentContext.existingSecret.key | string | `"CAIPE_AGENT_CONTEXT_HMAC_SECRET"` |  |
| dynamic-agents.agentContext.existingSecret.name | string | `""` |  |
| dynamic-agents.config.AGENT_GATEWAY_MCP_SERVER_IDS | string | `"all"` |  |
| dynamic-agents.config.CAIPE_API_URL | string | `""` |  |
| dynamic-agents.config.CAIPE_CREDENTIALS_ENABLED | string | `"false"` |  |
| dynamic-agents.config.CREDENTIAL_API_URL | string | `""` |  |
| dynamic-agents.config.CREDENTIAL_SERVICE_AUDIENCE | string | `"caipe-credential-service"` |  |
| dynamic-agents.config.KEYCLOAK_URL | string | `""` |  |
| dynamic-agents.config.MONGODB_DATABASE | string | `"caipe"` |  |
| dynamic-agents.config.OIDC_ISSUER | string | `""` |  |
| dynamic-agents.config.OPENFGA_HTTP | string | `""` |  |
| dynamic-agents.config.OPENFGA_STORE_NAME | string | `"caipe-openfga"` |  |
| dynamic-agents.config.USE_IMPERSONATION_TOKENS | string | `"false"` |  |
| dynamic-agents.externalSecrets.apiVersion | string | `"v1beta1"` |  |
| dynamic-agents.externalSecrets.data | list | `[]` |  |
| dynamic-agents.externalSecrets.enabled | bool | `false` |  |
| dynamic-agents.externalSecrets.secretStoreRef.kind | string | `"ClusterSecretStore"` |  |
| dynamic-agents.externalSecrets.secretStoreRef.name | string | `"vault"` |  |
| dynamic-agents.image.pullPolicy | string | `"IfNotPresent"` |  |
| dynamic-agents.image.repository | string | `"ghcr.io/caipe-io/caipe-dynamic-agents"` |  |
| dynamic-agents.image.tag | string | `""` |  |
| dynamic-agents.nameOverride | string | `"dynamic-agents"` |  |
| dynamic-agents.service.metricsPort | int | `0` |  |
| dynamic-agents.service.port | int | `8001` |  |
| extraDeploy | list | `[]` |  |
| global.agentgateway.enabled | bool | `true` |  |
| global.agentgateway.extAuth.enabled | bool | `false` |  |
| global.agentgateway.extAuth.port | int | `9100` |  |
| global.agentgateway.extAuth.serviceName | string | `""` |  |
| global.agentgateway.extAuth.serviceNamespace | string | `""` |  |
| global.agentgateway.extAuth.timeout | string | `"10s"` |  |
| global.agentgateway.extraMcpTargets | list | `[]` |  |
| global.agentgateway.githubMcpServer.enabled | bool | `false` |  |
| global.agentgateway.githubMcpServer.existingSecret.key | string | `"GITHUB_PERSONAL_ACCESS_TOKEN"` |  |
| global.agentgateway.githubMcpServer.existingSecret.name | string | `""` |  |
| global.agentgateway.githubMcpServer.image.pullPolicy | string | `"IfNotPresent"` |  |
| global.agentgateway.githubMcpServer.image.repository | string | `"ghcr.io/github/github-mcp-server"` |  |
| global.agentgateway.githubMcpServer.image.tag | string | `"latest@sha256:5c83359327a0bacc3d34db730bea6557d39d341cee0bf6c58c9a896e33150e80"` |  |
| global.agentgateway.githubMcpServer.pathPrefix | string | `"/mcp/github-mcp-server"` |  |
| global.agentgateway.githubMcpServer.port | int | `8082` |  |
| global.agentgateway.installIstioCrds | bool | `false` |  |
| global.agentgateway.knowledgeBaseTarget.enabled | bool | `true` |  |
| global.agentgateway.knowledgeBaseTarget.host | string | `"rag-server.{{ .Release.Namespace }}.svc.cluster.local"` |  |
| global.agentgateway.knowledgeBaseTarget.pathPrefix | string | `"/mcp/knowledge-base"` |  |
| global.agentgateway.knowledgeBaseTarget.port | int | `9446` |  |
| global.agentgateway.knowledgeBaseTarget.protocol | string | `"StreamableHTTP"` |  |
| global.agentgateway.knowledgeBaseTarget.providerTokenAuth | bool | `true` |  |
| global.agentgateway.proxyPort | int | `8080` |  |
| global.agentgateway.routingMode | string | `"static"` |  |
| global.agentgateway.static.configBridge.authzHost | string | `""` |  |
| global.agentgateway.static.configBridge.enabled | bool | `true` |  |
| global.agentgateway.static.configBridge.extraEnv | list | `[]` |  |
| global.agentgateway.static.configBridge.image.pullPolicy | string | `"IfNotPresent"` |  |
| global.agentgateway.static.configBridge.image.repository | string | `"ghcr.io/caipe-io/agentgateway-config-bridge"` |  |
| global.agentgateway.static.configBridge.image.tag | string | `""` |  |
| global.agentgateway.static.configBridge.pollSeconds | int | `5` |  |
| global.agentgateway.static.configBridge.ui.existingSecret.key | string | `"AGENTGATEWAY_TARGETS_TOKEN"` |  |
| global.agentgateway.static.configBridge.ui.existingSecret.name | string | `""` |  |
| global.agentgateway.static.configBridge.ui.externalSecret.data | list | `[]` |  |
| global.agentgateway.static.configBridge.ui.externalSecret.enabled | bool | `false` |  |
| global.agentgateway.static.configBridge.ui.url | string | `""` |  |
| global.agentgateway.static.jwtAuth.audiences | list | `[]` |  |
| global.agentgateway.static.jwtAuth.enabled | bool | `false` |  |
| global.agentgateway.static.jwtAuth.issuer | string | `""` |  |
| global.agentgateway.static.jwtAuth.jwksUrl | string | `""` |  |
| global.createLlmSecret | bool | `false` |  |
| global.externalSecrets.apiVersion | string | `"v1beta1"` |  |
| global.externalSecrets.enabled | bool | `false` |  |
| global.image | object | `{"channel":"","tag":""}` | Global image tag override. When set, overrides the default appVersion-based image tag for ALL subcharts (MCP servers, dynamic agents, UI, etc.) in a single place. Individual subchart `image.tag` values still take highest precedence. |
| global.llmSecrets.create | bool | `false` |  |
| global.llmSecrets.secretName | string | `"llm-secret"` |  |
| global.mcp.vpa.controlledResources[0] | string | `"cpu"` |  |
| global.mcp.vpa.controlledResources[1] | string | `"memory"` |  |
| global.mcp.vpa.controlledValues | string | `"RequestsAndLimits"` |  |
| global.mcp.vpa.enabled | bool | `false` |  |
| global.mcp.vpa.maxAllowed | object | `{}` |  |
| global.mcp.vpa.minAllowed.cpu | string | `"50m"` |  |
| global.mcp.vpa.minAllowed.memory | string | `"128Mi"` |  |
| global.mcp.vpa.updateMode | string | `"InPlaceOrRecreate"` |  |
| global.metrics.enabled | bool | `true` |  |
| global.openfga.httpUrl | string | `""` |  |
| global.openfga.storeName | string | `"caipe-openfga"` |  |
| global.rag.enableGraphRag | bool | `true` |  |
| global.rag.ingestorOidc.clientId | string | `"caipe-platform"` |  |
| global.rag.ingestorOidc.clientSecretRef.key | string | `"OIDC_CLIENT_SECRET"` |  |
| global.rag.ingestorOidc.clientSecretRef.name | string | `"caipe-platform-secret"` |  |
| global.rag.ingestorOidc.discoveryUrl | string | `"http://{{ .Release.Name }}-keycloak:8080/realms/caipe/.well-known/openid-configuration"` |  |
| global.rag.ingestorOidc.issuer | string | `""` |  |
| global.rag.ingestorOidc.jwksUrl | string | `"http://{{ .Release.Name }}-keycloak:8080/realms/caipe/protocol/openid-connect/certs"` |  |
| global.rag.ingestorOidc.scope | string | `""` |  |
| global.rag.openfga.httpUrl | string | `""` |  |
| global.scheduler.enabled | bool | `false` |  |
| global.scheduler.serviceTokenSecretKey | string | `"token"` |  |
| global.scheduler.serviceTokenSecretName | string | `"caipe-scheduler-service-token"` |  |
| global.storage | object | `{"s3":{"bucket":"","endpointUrl":"","region":""}}` | Shared object storage for CAIPE. Set the bucket ONCE here and every subchart that needs durable object storage derives from it:   * audit-service writes audit logs under its `audit` prefix   * dynamic-agents writes multimodal attachment blobs under `attachments` Same bucket/region, ambient (IRSA) credentials via each subchart's serviceAccount role-arn. A subchart's own storage value still wins when set. |
| global.vpa.controlledResources[0] | string | `"cpu"` |  |
| global.vpa.controlledResources[1] | string | `"memory"` |  |
| global.vpa.controlledValues | string | `"RequestsAndLimits"` |  |
| global.vpa.enabled | bool | `false` |  |
| global.vpa.maxAllowed | object | `{}` |  |
| global.vpa.minAllowed.cpu | string | `"50m"` |  |
| global.vpa.minAllowed.memory | string | `"128Mi"` |  |
| global.vpa.updateMode | string | `"InPlaceOrRecreate"` |  |
| keycloak.admin.password | string | `""` |  |
| keycloak.admin.secretRef | string | `""` |  |
| keycloak.admin.username | string | `"admin"` |  |
| keycloak.externalSecrets.apiVersion | string | `"v1beta1"` |  |
| keycloak.externalSecrets.data | list | `[]` |  |
| keycloak.externalSecrets.enabled | bool | `false` |  |
| keycloak.externalSecrets.secretStoreRef.kind | string | `"ClusterSecretStore"` |  |
| keycloak.externalSecrets.secretStoreRef.name | string | `"vault"` |  |
| keycloak.features.adminFineGrainedAuthz | bool | `true` |  |
| keycloak.features.tokenExchange | bool | `true` |  |
| keycloak.idp.accessGroup | string | `""` |  |
| keycloak.idp.adminGroup | string | `""` |  |
| keycloak.idp.alias | string | `""` |  |
| keycloak.idp.clientId | string | `""` |  |
| keycloak.idp.displayName | string | `""` |  |
| keycloak.idp.enabled | bool | `false` |  |
| keycloak.idp.issuer | string | `""` |  |
| keycloak.idp.secretRef | string | `""` |  |
| keycloak.image.pullPolicy | string | `"IfNotPresent"` |  |
| keycloak.image.repository | string | `"quay.io/keycloak/keycloak"` |  |
| keycloak.image.tag | string | `"26.3"` |  |
| keycloak.platformClient.secretRef | string | `"caipe-platform-secret"` |  |
| keycloak.realm.name | string | `"caipe"` |  |
| keycloak.realm.sslRequired | string | `"external"` |  |
| keycloak.resources.limits.cpu | string | `"1"` |  |
| keycloak.resources.limits.memory | string | `"1Gi"` |  |
| keycloak.resources.requests.cpu | string | `"250m"` |  |
| keycloak.resources.requests.memory | string | `"512Mi"` |  |
| keycloak.schedulerTokenExchange.botClientId | string | `"caipe-scheduler-runner"` |  |
| keycloak.schedulerTokenExchange.enabled | bool | `true` |  |
| keycloak.schedulerTokenExchange.secretRef | string | `""` |  |
| keycloak.service.port | int | `8080` |  |
| keycloak.service.type | string | `"ClusterIP"` |  |
| keycloak.tokenExchange.botClientId | string | `"caipe-slack-bot"` |  |
| keycloak.tokenExchange.enabled | bool | `true` |  |
| keycloak.webexTokenExchange.botClientId | string | `"caipe-webex-bot"` |  |
| keycloak.webexTokenExchange.enabled | bool | `true` |  |
| litellmMcp.affinity | object | `{}` |  |
| litellmMcp.config.LITELLM_API_TIMEOUT | string | `"120"` |  |
| litellmMcp.config.LITELLM_API_URL | string | `""` |  |
| litellmMcp.config.LITELLM_VERIFY_SSL | string | `"true"` |  |
| litellmMcp.config.SERVER_NAME | string | `"LITELLM"` |  |
| litellmMcp.enabled | bool | `false` |  |
| litellmMcp.existingSecret | string | `""` |  |
| litellmMcp.externalSecrets.apiVersion | string | `"v1beta1"` |  |
| litellmMcp.externalSecrets.data | list | `[]` |  |
| litellmMcp.externalSecrets.enabled | bool | `false` |  |
| litellmMcp.externalSecrets.refreshInterval | string | `"1h"` |  |
| litellmMcp.externalSecrets.secretStoreRef.kind | string | `"ClusterSecretStore"` |  |
| litellmMcp.externalSecrets.secretStoreRef.name | string | `"vault"` |  |
| litellmMcp.fullnameOverride | string | `""` |  |
| litellmMcp.image.pullPolicy | string | `"IfNotPresent"` |  |
| litellmMcp.image.repository | string | `"ghcr.io/caipe-io/mcp-litellm"` |  |
| litellmMcp.image.tag | string | `""` |  |
| litellmMcp.imagePullSecrets | list | `[]` |  |
| litellmMcp.livenessProbe.failureThreshold | int | `3` |  |
| litellmMcp.livenessProbe.initialDelaySeconds | int | `30` |  |
| litellmMcp.livenessProbe.periodSeconds | int | `10` |  |
| litellmMcp.livenessProbe.tcpSocket.port | string | `"http"` |  |
| litellmMcp.livenessProbe.timeoutSeconds | int | `5` |  |
| litellmMcp.nameOverride | string | `"litellm-mcp"` |  |
| litellmMcp.nodeSelector | object | `{}` |  |
| litellmMcp.podAnnotations | object | `{}` |  |
| litellmMcp.podLabels | object | `{}` |  |
| litellmMcp.podSecurityContext | object | `{}` |  |
| litellmMcp.readinessProbe.failureThreshold | int | `3` |  |
| litellmMcp.readinessProbe.initialDelaySeconds | int | `5` |  |
| litellmMcp.readinessProbe.periodSeconds | int | `5` |  |
| litellmMcp.readinessProbe.tcpSocket.port | string | `"http"` |  |
| litellmMcp.readinessProbe.timeoutSeconds | int | `3` |  |
| litellmMcp.replicaCount | int | `1` |  |
| litellmMcp.resources | object | `{}` |  |
| litellmMcp.revisionHistoryLimit | int | `3` |  |
| litellmMcp.secret.create | bool | `false` |  |
| litellmMcp.secret.data | object | `{}` |  |
| litellmMcp.secret.name | string | `""` |  |
| litellmMcp.securityContext | object | `{}` |  |
| litellmMcp.service.port | int | `8000` |  |
| litellmMcp.service.type | string | `"ClusterIP"` |  |
| litellmMcp.tolerations | list | `[]` |  |
| mcp-argocd.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-argocd.image.repository | string | `"ghcr.io/caipe-io/mcp-argocd"` |  |
| mcp-argocd.mcp.agentgateway.enabled | bool | `false` |  |
| mcp-argocd.mcp.agentgateway.protocol | string | `"StreamableHTTP"` |  |
| mcp-argocd.mcp.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-argocd.mcp.image.repository | string | `"ghcr.io/caipe-io/mcp-argocd"` |  |
| mcp-argocd.mcp.image.tag | string | `""` |  |
| mcp-argocd.mcp.mode | string | `"http"` |  |
| mcp-argocd.mcp.port | int | `8000` |  |
| mcp-argocd.nameOverride | string | `"mcp-argocd"` |  |
| mcp-aws.env.RESTRICT_KUBECTL_ATTACH | string | `"false"` | Block kubectl attach (attach to a running process inside a pod). Defaults to false (off). |
| mcp-aws.env.RESTRICT_KUBECTL_CP | string | `"false"` | Block kubectl cp (copy files out of pods). Defaults to false (off). |
| mcp-aws.env.RESTRICT_KUBECTL_EXEC | string | `"false"` | Block kubectl exec (shell access inside pods). Defaults to false (off); enable for stricter environments. |
| mcp-aws.env.RESTRICT_KUBECTL_PORT_FORWARD | string | `"false"` | Block kubectl port-forward (tunnel internal services). Defaults to false (off). |
| mcp-aws.env.RESTRICT_KUBECTL_PROXY | string | `"true"` | Block kubectl proxy, which exposes the entire Kubernetes API server. Defaults to true (on). |
| mcp-aws.env.RESTRICT_KUBECTL_SECRETS | string | `"true"` | Block kubectl get/describe secret(s) and redact Secret data from output. Defaults to true (on). |
| mcp-aws.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-aws.image.repository | string | `"ghcr.io/cnoe-io/agent-aws"` |  |
| mcp-aws.mcp.agentgateway.enabled | bool | `false` |  |
| mcp-aws.mcp.agentgateway.protocol | string | `"StreamableHTTP"` |  |
| mcp-aws.mcp.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-aws.mcp.image.repository | string | `"ghcr.io/caipe-io/mcp-aws"` |  |
| mcp-aws.mcp.image.tag | string | `""` |  |
| mcp-aws.mcp.mode | string | `"http"` |  |
| mcp-aws.mcp.port | int | `8000` |  |
| mcp-aws.nameOverride | string | `"mcp-aws"` |  |
| mcp-backstage.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-backstage.image.repository | string | `"ghcr.io/cnoe-io/agent-backstage"` |  |
| mcp-backstage.mcp.agentgateway.enabled | bool | `false` |  |
| mcp-backstage.mcp.agentgateway.protocol | string | `"StreamableHTTP"` |  |
| mcp-backstage.mcp.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-backstage.mcp.image.repository | string | `"ghcr.io/caipe-io/mcp-backstage"` |  |
| mcp-backstage.mcp.image.tag | string | `""` |  |
| mcp-backstage.mcp.mode | string | `"http"` |  |
| mcp-backstage.mcp.port | int | `8000` |  |
| mcp-backstage.nameOverride | string | `"mcp-backstage"` |  |
| mcp-confluence.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-confluence.image.repository | string | `"ghcr.io/cnoe-io/agent-confluence"` |  |
| mcp-confluence.mcp.agentgateway.enabled | bool | `false` |  |
| mcp-confluence.mcp.agentgateway.protocol | string | `"StreamableHTTP"` |  |
| mcp-confluence.mcp.env.TRANSPORT | string | `"streamable-http"` |  |
| mcp-confluence.mcp.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-confluence.mcp.image.repository | string | `"ghcr.io/sooperset/mcp-atlassian"` |  |
| mcp-confluence.mcp.image.tag | string | `"0.23.0"` |  |
| mcp-confluence.mcp.mode | string | `"http"` |  |
| mcp-confluence.mcp.port | int | `8000` |  |
| mcp-confluence.nameOverride | string | `"mcp-confluence"` |  |
| mcp-github.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-github.image.repository | string | `"ghcr.io/caipe-io/mcp-github"` |  |
| mcp-github.mcp.agentgateway.enabled | bool | `false` |  |
| mcp-github.mcp.agentgateway.protocol | string | `"StreamableHTTP"` |  |
| mcp-github.mcp.agentgateway.providerTokenAuth | bool | `true` |  |
| mcp-github.mcp.mode | string | `"stdio"` |  |
| mcp-github.mcp.useRemoteMcpServer | bool | `false` |  |
| mcp-github.nameOverride | string | `"mcp-github"` |  |
| mcp-gitlab.env.GIT_AUTHOR_EMAIL | string | `"ai-agent@cnoe.io"` |  |
| mcp-gitlab.env.GIT_AUTHOR_NAME | string | `"AI Agent"` |  |
| mcp-gitlab.env.GIT_COMMITTER_EMAIL | string | `"ai-agent@cnoe.io"` |  |
| mcp-gitlab.env.GIT_COMMITTER_NAME | string | `"AI Agent"` |  |
| mcp-gitlab.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-gitlab.image.repository | string | `"ghcr.io/cnoe-io/agent-gitlab"` |  |
| mcp-gitlab.mcp.agentgateway.enabled | bool | `false` |  |
| mcp-gitlab.mcp.agentgateway.protocol | string | `"StreamableHTTP"` |  |
| mcp-gitlab.mcp.agentgateway.providerTokenAuth | bool | `true` |  |
| mcp-gitlab.mcp.env.GITLAB_READ_ONLY_MODE | string | `"true"` |  |
| mcp-gitlab.mcp.env.HOST | string | `"0.0.0.0"` |  |
| mcp-gitlab.mcp.env.MAX_REQUESTS_PER_MINUTE | string | `"60"` |  |
| mcp-gitlab.mcp.env.MAX_SESSIONS | string | `"1000"` |  |
| mcp-gitlab.mcp.env.PORT | string | `"8000"` |  |
| mcp-gitlab.mcp.env.STREAMABLE_HTTP | string | `"true"` |  |
| mcp-gitlab.mcp.env.USE_PIPELINE | string | `"true"` |  |
| mcp-gitlab.mcp.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-gitlab.mcp.image.repository | string | `"zereight050/gitlab-mcp"` |  |
| mcp-gitlab.mcp.image.tag | string | `"2.1.46"` |  |
| mcp-gitlab.mcp.mode | string | `"http"` |  |
| mcp-gitlab.mcp.port | int | `8000` |  |
| mcp-gitlab.nameOverride | string | `"mcp-gitlab"` |  |
| mcp-jira.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-jira.image.repository | string | `"ghcr.io/cnoe-io/agent-jira"` |  |
| mcp-jira.mcp.agentgateway.enabled | bool | `false` |  |
| mcp-jira.mcp.agentgateway.protocol | string | `"StreamableHTTP"` |  |
| mcp-jira.mcp.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-jira.mcp.image.repository | string | `"ghcr.io/caipe-io/mcp-jira"` |  |
| mcp-jira.mcp.image.tag | string | `""` |  |
| mcp-jira.mcp.mode | string | `"http"` |  |
| mcp-jira.mcp.port | int | `8000` |  |
| mcp-jira.nameOverride | string | `"mcp-jira"` |  |
| mcp-komodor.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-komodor.image.repository | string | `"ghcr.io/cnoe-io/agent-komodor"` |  |
| mcp-komodor.mcp.agentgateway.enabled | bool | `false` |  |
| mcp-komodor.mcp.agentgateway.protocol | string | `"StreamableHTTP"` |  |
| mcp-komodor.mcp.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-komodor.mcp.image.repository | string | `"ghcr.io/caipe-io/mcp-komodor"` |  |
| mcp-komodor.mcp.image.tag | string | `""` |  |
| mcp-komodor.mcp.mode | string | `"http"` |  |
| mcp-komodor.mcp.port | int | `8000` |  |
| mcp-komodor.nameOverride | string | `"mcp-komodor"` |  |
| mcp-netutils.agentSecrets.requiresSecret | bool | `false` |  |
| mcp-netutils.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-netutils.image.repository | string | `"ghcr.io/cnoe-io/agent-netutils"` |  |
| mcp-netutils.mcp.agentgateway.enabled | bool | `false` |  |
| mcp-netutils.mcp.agentgateway.protocol | string | `"StreamableHTTP"` |  |
| mcp-netutils.mcp.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-netutils.mcp.image.repository | string | `"ghcr.io/caipe-io/mcp-netutils"` |  |
| mcp-netutils.mcp.image.tag | string | `""` |  |
| mcp-netutils.mcp.mode | string | `"http"` |  |
| mcp-netutils.mcp.port | int | `8000` |  |
| mcp-netutils.nameOverride | string | `"mcp-netutils"` |  |
| mcp-pagerduty.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-pagerduty.image.repository | string | `"ghcr.io/cnoe-io/agent-pagerduty"` |  |
| mcp-pagerduty.mcp.agentgateway.enabled | bool | `false` |  |
| mcp-pagerduty.mcp.agentgateway.protocol | string | `"StreamableHTTP"` |  |
| mcp-pagerduty.mcp.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-pagerduty.mcp.image.repository | string | `"ghcr.io/caipe-io/mcp-pagerduty"` |  |
| mcp-pagerduty.mcp.image.tag | string | `""` |  |
| mcp-pagerduty.mcp.mode | string | `"http"` |  |
| mcp-pagerduty.mcp.port | int | `8000` |  |
| mcp-pagerduty.nameOverride | string | `"mcp-pagerduty"` |  |
| mcp-slack.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-slack.image.repository | string | `"ghcr.io/cnoe-io/agent-slack"` |  |
| mcp-slack.mcp.agentgateway.enabled | bool | `false` |  |
| mcp-slack.mcp.agentgateway.protocol | string | `"StreamableHTTP"` |  |
| mcp-slack.mcp.command[0] | string | `"--transport"` |  |
| mcp-slack.mcp.command[1] | string | `"http"` |  |
| mcp-slack.mcp.env.SLACK_MCP_HOST | string | `"0.0.0.0"` |  |
| mcp-slack.mcp.env.SLACK_MCP_PORT | string | `"3001"` |  |
| mcp-slack.mcp.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-slack.mcp.image.repository | string | `"ghcr.io/korotovsky/slack-mcp-server"` |  |
| mcp-slack.mcp.image.tag | string | `"v1.2.3"` |  |
| mcp-slack.mcp.mode | string | `"http"` |  |
| mcp-slack.mcp.port | int | `3001` |  |
| mcp-slack.nameOverride | string | `"mcp-slack"` |  |
| mcp-splunk.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-splunk.image.repository | string | `"ghcr.io/cnoe-io/agent-splunk"` |  |
| mcp-splunk.mcp.agentgateway.enabled | bool | `false` |  |
| mcp-splunk.mcp.agentgateway.protocol | string | `"StreamableHTTP"` |  |
| mcp-splunk.mcp.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-splunk.mcp.image.repository | string | `"ghcr.io/caipe-io/mcp-splunk"` |  |
| mcp-splunk.mcp.image.tag | string | `""` |  |
| mcp-splunk.mcp.mode | string | `"http"` |  |
| mcp-splunk.mcp.port | int | `8000` |  |
| mcp-splunk.nameOverride | string | `"mcp-splunk"` |  |
| mcp-victorops.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-victorops.image.repository | string | `"ghcr.io/cnoe-io/agent-victorops"` |  |
| mcp-victorops.mcp.agentgateway.enabled | bool | `false` |  |
| mcp-victorops.mcp.agentgateway.protocol | string | `"StreamableHTTP"` |  |
| mcp-victorops.mcp.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-victorops.mcp.image.repository | string | `"ghcr.io/caipe-io/mcp-victorops"` |  |
| mcp-victorops.mcp.image.tag | string | `""` |  |
| mcp-victorops.mcp.mode | string | `"http"` |  |
| mcp-victorops.mcp.port | int | `8000` |  |
| mcp-victorops.nameOverride | string | `"mcp-victorops"` |  |
| mcp-webex-meetings.mcp.agentgateway.credential_sources[0].kind | string | `"provider_connection"` |  |
| mcp-webex-meetings.mcp.agentgateway.credential_sources[0].name | string | `"X-CAIPE-Provider-Token"` |  |
| mcp-webex-meetings.mcp.agentgateway.credential_sources[0].provider | string | `"webex"` |  |
| mcp-webex-meetings.mcp.agentgateway.credential_sources[0].target | string | `"header"` |  |
| mcp-webex-meetings.mcp.agentgateway.enabled | bool | `true` |  |
| mcp-webex-meetings.mcp.agentgateway.id | string | `"webex_meetings"` |  |
| mcp-webex-meetings.mcp.agentgateway.pathPrefix | string | `"/mcp/webex_meetings"` |  |
| mcp-webex-meetings.mcp.agentgateway.protocol | string | `"StreamableHTTP"` |  |
| mcp-webex-meetings.mcp.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-webex-meetings.mcp.image.repository | string | `"ghcr.io/caipe-io/mcp-webex-meetings"` |  |
| mcp-webex-meetings.mcp.image.tag | string | `""` |  |
| mcp-webex-meetings.mcp.mode | string | `"http"` |  |
| mcp-webex-meetings.mcp.port | int | `8000` |  |
| mcp-webex-meetings.mcpSecrets.requiresSecret | bool | `false` |  |
| mcp-webex-meetings.nameOverride | string | `"mcp-webex-meetings"` |  |
| mcp-webex.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-webex.image.repository | string | `"ghcr.io/cnoe-io/agent-webex"` |  |
| mcp-webex.mcp.agentgateway.enabled | bool | `false` |  |
| mcp-webex.mcp.agentgateway.protocol | string | `"StreamableHTTP"` |  |
| mcp-webex.mcp.image.pullPolicy | string | `"IfNotPresent"` |  |
| mcp-webex.mcp.image.repository | string | `"ghcr.io/caipe-io/mcp-webex"` |  |
| mcp-webex.mcp.image.tag | string | `""` |  |
| mcp-webex.mcp.mode | string | `"http"` |  |
| mcp-webex.mcp.port | int | `8000` |  |
| mcp-webex.nameOverride | string | `"mcp-webex"` |  |
| metrics.grafanaDashboard.enabled | bool | `true` |  |
| metrics.grafanaDashboard.labels.grafana_dashboard | string | `"1"` |  |
| metrics.path | string | `"/metrics"` |  |
| metrics.serviceMonitor.annotations | object | `{}` |  |
| metrics.serviceMonitor.enabled | bool | `false` |  |
| metrics.serviceMonitor.interval | string | `"30s"` |  |
| metrics.serviceMonitor.labels | object | `{}` |  |
| metrics.serviceMonitor.metricRelabelings | list | `[]` |  |
| metrics.serviceMonitor.relabelings | list | `[]` |  |
| metrics.serviceMonitor.scrapeTimeout | string | `"10s"` |  |
| openfga-authz-bridge.agentContext.existingSecret.key | string | `"CAIPE_AGENT_CONTEXT_HMAC_SECRET"` |  |
| openfga-authz-bridge.agentContext.existingSecret.name | string | `""` |  |
| openfga-authz-bridge.audit.enabled | bool | `true` |  |
| openfga-authz-bridge.audit.serviceUrl | string | `""` |  |
| openfga-authz-bridge.audit.subjectSalt | string | `"caipe-098-audit"` |  |
| openfga-authz-bridge.audit.tenantId | string | `"default"` |  |
| openfga-authz-bridge.image.pullPolicy | string | `"IfNotPresent"` |  |
| openfga-authz-bridge.image.repository | string | `"ghcr.io/caipe-io/openfga-authz-bridge"` |  |
| openfga-authz-bridge.image.tag | string | `""` |  |
| openfga-authz-bridge.openfga.httpUrl | string | `""` |  |
| openfga-authz-bridge.openfga.object | string | `"mcp_gateway:list"` |  |
| openfga-authz-bridge.openfga.relation | string | `"can_call"` |  |
| openfga-authz-bridge.openfga.storeName | string | `"caipe-openfga"` |  |
| openfga-authz-bridge.organizationKey | string | `"caipe"` |  |
| openfga-authz-bridge.restrictedMcpServers | list | `[]` |  |
| openfga-authz-bridge.tokenValidation.algorithms[0] | string | `"RS256"` |  |
| openfga-authz-bridge.tokenValidation.audiences | list | `[]` |  |
| openfga-authz-bridge.tokenValidation.issuer | string | `""` |  |
| openfga-authz-bridge.tokenValidation.jwksUrl | string | `""` |  |
| openfga.datastore.engine | string | `"memory"` |  |
| openfga.datastore.uriSecretRef.key | string | `"OPENFGA_DATASTORE_URI"` |  |
| openfga.datastore.uriSecretRef.name | string | `""` |  |
| openfga.enabled | bool | `false` |  |
| openfga.image.pullPolicy | string | `"IfNotPresent"` |  |
| openfga.image.repository | string | `"openfga/openfga"` |  |
| openfga.image.tag | string | `"v1.15.1"` |  |
| openfga.init.enabled | bool | `true` |  |
| openfga.init.seedTuples | list | `[]` |  |
| openfga.init.storeName | string | `"caipe-openfga"` |  |
| openfga.migrate.enabled | bool | `true` |  |
| openfgaAuthzBridge.enabled | bool | `false` |  |
| rag-stack | string | `nil` |  |
| rag-stack.agent-ontology.enabled | bool | `true` |  |
| rag-stack.agent-rag.enabled | bool | `true` |  |
| rag-stack.agent-rag.image.pullPolicy | string | `"IfNotPresent"` |  |
| rag-stack.agent-rag.image.repository | string | `"ghcr.io/caipe-io/caipe-rag-agent-rag"` |  |
| rag-stack.agent-rag.image.tag | string | `""` |  |
| rag-stack.milvus.enabled | bool | `true` |  |
| rag-stack.neo4j.enabled | bool | `true` |  |
| rag-stack.rag-redis.enabled | bool | `true` |  |
| rag-stack.rag-redis.image.pullPolicy | string | `"IfNotPresent"` |  |
| rag-stack.rag-redis.image.repository | string | `"redis"` |  |
| rag-stack.rag-redis.image.tag | string | `"7.2-alpine"` |  |
| rag-stack.rag-redis.persistence.enabled | bool | `false` |  |
| rag-stack.rag-server.enabled | bool | `true` |  |
| rag-stack.rag-server.env.CAIPE_UNSAFE_RBAC_BYPASS | string | `"false"` |  |
| rag-stack.rag-server.env.OPENFGA_STORE_NAME | string | `"caipe-openfga"` |  |
| rag-stack.rag-server.image.pullPolicy | string | `"IfNotPresent"` |  |
| rag-stack.rag-server.image.repository | string | `"ghcr.io/caipe-io/caipe-rag-server"` |  |
| rag-stack.rag-server.image.tag | string | `""` |  |
| scheduler.args | list | `[]` |  |
| scheduler.caipe.apiUrl | string | `"http://{{ .Release.Name }}-caipe-ui:3000"` |  |
| scheduler.caipe.chatPath | string | `"/api/v1/chat/invoke"` |  |
| scheduler.command | list | `[]` |  |
| scheduler.cronRunner.image.pullPolicy | string | `"IfNotPresent"` |  |
| scheduler.cronRunner.image.repository | string | `"ghcr.io/caipe-io/caipe-cron-runner"` |  |
| scheduler.cronRunner.image.tag | string | `""` |  |
| scheduler.fullnameOverride | string | `"caipe-scheduler"` |  |
| scheduler.image.pullPolicy | string | `"IfNotPresent"` |  |
| scheduler.image.repository | string | `"ghcr.io/caipe-io/caipe-scheduler"` |  |
| scheduler.image.tag | string | `""` |  |
| scheduler.mongo.database | string | `"caipe"` |  |
| scheduler.mongo.existingSecret | string | `""` |  |
| scheduler.mongo.existingSecretKey | string | `"uri"` |  |
| scheduler.mongo.uri | string | `""` |  |
| scheduler.serviceToken.existingSecret | string | `""` |  |
| scheduler.serviceToken.existingSecretKey | string | `"token"` |  |
| scheduler.serviceToken.value | string | `""` |  |
| schedulerMcp.auth.audience | string | `"caipe-platform"` |  |
| schedulerMcp.auth.issuer | string | `""` |  |
| schedulerMcp.auth.jwksUri | string | `""` |  |
| schedulerMcp.auth.mode | string | `"none"` |  |
| schedulerMcp.command[0] | string | `"mcp-server-scheduler"` |  |
| schedulerMcp.enabled | bool | `true` |  |
| schedulerMcp.env.MCP_HOST | string | `"0.0.0.0"` |  |
| schedulerMcp.env.MCP_MODE | string | `"streamable-http"` |  |
| schedulerMcp.env.MCP_PORT | string | `"8000"` |  |
| schedulerMcp.env.SCHEDULER_URL | string | `"http://caipe-scheduler:8080"` |  |
| schedulerMcp.image.pullPolicy | string | `"IfNotPresent"` |  |
| schedulerMcp.image.repository | string | `"ghcr.io/caipe-io/mcp-scheduler"` |  |
| schedulerMcp.image.tag | string | `""` |  |
| schedulerMcp.nameOverride | string | `"mcp-scheduler"` |  |
| schedulerMcp.resources | object | `{}` |  |
| schedulerMcp.service.port | int | `8000` |  |
| skillsLiveSkills | string | `""` |  |
| skillsLiveSkillsName | string | `""` | ------------------------------------------------------------------------- |
| slack-bot.botConfig | object | `{}` | Per-channel configuration rendered as YAML and volume-mounted at /etc/caipe/bot-config.yaml. Only mounted when non-empty. |
| slack-bot.config | object | `{"APP_NAME":"CAIPE","CAIPE_API_URL":"","SLACK_ADMIN_ALLOWED_CLIENT_IDS":"caipe-ui","SLACK_ADMIN_API_ENABLED":"true","SLACK_ADMIN_API_HOST":"0.0.0.0","SLACK_ADMIN_API_PORT":"3001","SLACK_ADMIN_JWT_AUDIENCE":"caipe-slack-bot-admin","SLACK_ADMIN_JWT_ISSUER":"","SLACK_AGENT_ROUTES_MODE":"db_prefer","SLACK_AUTO_ASSIGN_UNMAPPED_CHANNELS":"false","SLACK_BOT_MODE":"socket","SLACK_DEFAULT_AGENT_ID":"","SLACK_DEFAULT_TEAM_SLUG":"","SLACK_WORKSPACE_ALIAS":"CAIPE"}` | Flat key-value map of environment variables. Each key-value pair is injected as a flat environment variable via ConfigMap (envFrom → configMapRef). All non-sensitive env vars go here. |
| slack-bot.existingSecret | string | `"slack-bot-secrets"` | Reference to a pre-existing Kubernetes Secret. Should contain: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET, and optionally OAUTH2_CLIENT_SECRET. |
| slack-bot.externalSecrets | object | `{"apiVersion":"v1beta1","data":[],"enabled":false,"secretStoreRef":{"kind":"ClusterSecretStore","name":"vault"}}` | External Secrets configuration for sensitive data |
| slack-bot.image.pullPolicy | string | `"IfNotPresent"` |  |
| slack-bot.image.repository | string | `"ghcr.io/caipe-io/caipe-slack-bot"` |  |
| slack-bot.image.tag | string | `""` |  |
| slack-bot.resources.limits.cpu | string | `"500m"` |  |
| slack-bot.resources.limits.memory | string | `"512Mi"` |  |
| slack-bot.resources.requests.cpu | string | `"100m"` |  |
| slack-bot.resources.requests.memory | string | `"256Mi"` |  |
| tags.basic | bool | `false` |  |
| tags.caipe-ui | bool | `false` |  |
| tags.complete | bool | `false` |  |
| tags.dynamic-agents | bool | `false` |  |
| tags.keycloak | bool | `false` |  |
| tags.mcp-argocd | bool | `false` |  |
| tags.mcp-aws | bool | `false` |  |
| tags.mcp-backstage | bool | `false` |  |
| tags.mcp-confluence | bool | `false` |  |
| tags.mcp-github | bool | `false` |  |
| tags.mcp-gitlab | bool | `false` |  |
| tags.mcp-jira | bool | `false` |  |
| tags.mcp-komodor | bool | `false` |  |
| tags.mcp-netutils | bool | `false` |  |
| tags.mcp-pagerduty | bool | `false` |  |
| tags.mcp-slack | bool | `false` |  |
| tags.mcp-splunk | bool | `false` |  |
| tags.mcp-victorops | bool | `false` |  |
| tags.mcp-webex | bool | `false` |  |
| tags.mcp-webex-meetings | bool | `false` |  |
| tags.rag-stack | bool | `false` |  |
| tags.slack-bot | bool | `false` |  |
| tags.webex-bot | bool | `false` |  |
| webex-bot.botConfig | object | `{}` |  |
| webex-bot.bots | list | `[]` |  |
| webex-bot.config.APP_NAME | string | `"CAIPE"` |  |
| webex-bot.config.CAIPE_API_URL | string | `""` |  |
| webex-bot.config.KEYCLOAK_REALM | string | `"caipe"` |  |
| webex-bot.config.KEYCLOAK_URL | string | `""` |  |
| webex-bot.config.OPENFGA_HTTP | string | `""` |  |
| webex-bot.config.OPENFGA_STORE_NAME | string | `"caipe-openfga"` |  |
| webex-bot.config.WEBEX_ADMIN_ALLOWED_CLIENT_IDS | string | `"caipe-ui"` |  |
| webex-bot.config.WEBEX_ADMIN_API_ENABLED | string | `"false"` |  |
| webex-bot.config.WEBEX_ADMIN_API_HOST | string | `"0.0.0.0"` |  |
| webex-bot.config.WEBEX_ADMIN_API_PORT | string | `"3002"` |  |
| webex-bot.config.WEBEX_ADMIN_JWKS_URL | string | `""` |  |
| webex-bot.config.WEBEX_ADMIN_JWT_AUDIENCE | string | `"caipe-webex-bot-admin"` |  |
| webex-bot.config.WEBEX_ADMIN_JWT_ISSUER | string | `""` |  |
| webex-bot.config.WEBEX_AGENT_ROUTES_MODE | string | `"db_prefer"` |  |
| webex-bot.config.WEBEX_THREAD_CONTEXT_ENABLED | string | `"true"` |  |
| webex-bot.config.WEBEX_THREAD_CONTEXT_MAX_CHARS | string | `"4000"` |  |
| webex-bot.config.WEBEX_THREAD_CONTEXT_MAX_MESSAGES | string | `"10"` |  |
| webex-bot.config.WEBEX_WORKSPACE_ALIAS | string | `"CAIPE-WEBEX"` |  |
| webex-bot.existingSecret | string | `"webex-bot-secrets"` |  |
| webex-bot.externalSecrets.apiVersion | string | `"v1beta1"` |  |
| webex-bot.externalSecrets.data | list | `[]` |  |
| webex-bot.externalSecrets.enabled | bool | `false` |  |
| webex-bot.externalSecrets.secretStoreRef.kind | string | `"ClusterSecretStore"` |  |
| webex-bot.externalSecrets.secretStoreRef.name | string | `"vault"` |  |
| webex-bot.image.pullPolicy | string | `"IfNotPresent"` |  |
| webex-bot.image.repository | string | `"ghcr.io/caipe-io/caipe-webex-bot"` |  |
| webex-bot.image.tag | string | `""` |  |
| webex-bot.keycloakBot.clientSecretFromSecret.key | string | `"KC_WEBEX_BOT_CLIENT_SECRET"` |  |
| webex-bot.keycloakBot.clientSecretFromSecret.name | string | `""` |  |
| webex-bot.resources.limits.cpu | string | `"500m"` |  |
| webex-bot.resources.limits.memory | string | `"512Mi"` |  |
| webex-bot.resources.requests.cpu | string | `"100m"` |  |
| webex-bot.resources.requests.memory | string | `"256Mi"` |  |

## Dependencies

| Name | Version | Condition / Tags |
|------|---------|------------------|
| mcp-argocd (mcp-server) | `0.5.68` | tags: mcp-argocd, basic, complete |
| mcp-aws (mcp-server) | `0.5.68` | tags: mcp-aws, complete |
| mcp-backstage (mcp-server) | `0.5.68` | tags: mcp-backstage, basic, complete |
| mcp-confluence (mcp-server) | `0.5.68` | tags: mcp-confluence, complete |
| mcp-github (mcp-server) | `0.5.68` | tags: mcp-github, basic, complete |
| mcp-gitlab (mcp-server) | `0.5.68` | tags: mcp-gitlab, complete |
| mcp-jira (mcp-server) | `0.5.68` | tags: mcp-jira, complete |
| mcp-komodor (mcp-server) | `0.5.68` | tags: mcp-komodor, complete |
| mcp-pagerduty (mcp-server) | `0.5.68` | tags: mcp-pagerduty, complete |
| mcp-slack (mcp-server) | `0.5.68` | tags: mcp-slack, complete |
| mcp-splunk (mcp-server) | `0.5.68` | tags: mcp-splunk, complete |
| mcp-victorops (mcp-server) | `0.5.68` | tags: mcp-victorops |
| mcp-webex (mcp-server) | `0.5.68` | tags: mcp-webex, complete |
| mcp-webex-meetings (mcp-server) | `0.5.68` | tags: mcp-webex-meetings, complete |
| mcp-netutils (mcp-server) | `0.5.68` | tags: mcp-netutils, complete |
| rag-stack | `0.5.68` | tags: rag-stack, complete |
| caipe-ui | `0.5.68` | tags: caipe-ui |
| audit-service | `0.5.68` |  |
| dynamic-agents | `0.5.68` | tags: dynamic-agents |
| scheduler | `0.5.68` | `global.scheduler.enabled` |
| mongodb (caipe-ui-mongodb) | `0.5.68` | `caipe-ui.mongodb.enabled` |
| skill-scanner | `0.5.68` | `global.skillScanner.enabled` |
| slack-bot | `0.5.68` | tags: slack-bot |
| webex-bot | `0.5.68` | tags: webex-bot |
| keycloak | `0.5.68` | tags: keycloak |
| openfga | `0.5.68` | `openfga.enabled` |
| openfga-authz-bridge | `0.5.68` | `openfgaAuthzBridge.enabled` |
| agentgateway | `0.5.68` | `agentgateway.enabled` |
