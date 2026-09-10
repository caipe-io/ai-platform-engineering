---
id: autonomous-agents-chart
sidebar_label: autonomous-agents
---

:::caution Auto-generated
This page is auto-generated from the Helm chart source. Do not edit directly.
Regenerate with `make docs-helm-charts`.
:::

# autonomous-agents

A Helm chart for Autonomous Agents - Standalone scheduler that fires tasks (cron / interval / webhook) at the CAIPE supervisor over A2A

| | |
|---|---|
| **Version** | `0.4.10-dev.1` |
| **Type** | application |

## Quick Start

```bash
# Add and install the chart
helm install autonomous-agents oci://ghcr.io/cnoe-io/charts/autonomous-agents --version 0.4.10-dev.1

# Upgrade an existing release
helm upgrade autonomous-agents oci://ghcr.io/cnoe-io/charts/autonomous-agents --version 0.4.10-dev.1
```

## Customizing Values

Override default values using `--set` flags or a custom values file:

```bash
# Override individual values
helm install autonomous-agents oci://ghcr.io/cnoe-io/charts/autonomous-agents --version 0.4.10-dev.1 \
  --set replicaCount=2

# Use a custom values file
helm install autonomous-agents oci://ghcr.io/cnoe-io/charts/autonomous-agents --version 0.4.10-dev.1 \
  -f custom-values.yaml

# Show all configurable values
helm show values oci://ghcr.io/cnoe-io/charts/autonomous-agents --version 0.4.10-dev.1
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
| affinity | object | `{}` |  |
| config.CHAT_HISTORY_OWNER_EMAIL | string | `"autonomous@system"` |  |
| config.CHAT_HISTORY_PUBLISH_ENABLED | string | `"false"` |  |
| config.CORS_ORIGINS | string | `""` |  |
| config.DYNAMIC_AGENTS_URL | string | `""` |  |
| config.MONGODB_DATABASE | string | `"caipe"` |  |
| config.SUPERVISOR_URL | string | `""` |  |
| existingSecret | string | `""` |  |
| externalSecrets.apiVersion | string | `"v1beta1"` |  |
| externalSecrets.data | list | `[]` |  |
| externalSecrets.enabled | bool | `false` |  |
| externalSecrets.secretStoreRef.kind | string | `"ClusterSecretStore"` |  |
| externalSecrets.secretStoreRef.name | string | `"vault"` |  |
| fullnameOverride | string | `""` |  |
| image.pullPolicy | string | `"Always"` |  |
| image.repository | string | `"ghcr.io/caipe-io/caipe-autonomous-agents"` |  |
| image.tag | string | `""` |  |
| imagePullSecrets | list | `[]` |  |
| ingress.annotations | object | `{}` |  |
| ingress.className | string | `"nginx"` |  |
| ingress.enabled | bool | `false` |  |
| ingress.hosts[0].host | string | `"autonomous-agents.local"` |  |
| ingress.hosts[0].paths[0].path | string | `"/api/v1/hooks"` |  |
| ingress.hosts[0].paths[0].pathType | string | `"Prefix"` |  |
| ingress.tls | list | `[]` |  |
| livenessProbe.failureThreshold | int | `3` |  |
| livenessProbe.httpGet.path | string | `"/health"` |  |
| livenessProbe.httpGet.port | string | `"http"` |  |
| livenessProbe.initialDelaySeconds | int | `30` |  |
| livenessProbe.periodSeconds | int | `10` |  |
| livenessProbe.timeoutSeconds | int | `5` |  |
| llmSecret | string | `""` |  |
| nameOverride | string | `""` |  |
| nodeSelector | object | `{}` |  |
| podAnnotations | object | `{}` |  |
| podLabels | object | `{}` |  |
| podSecurityContext.runAsNonRoot | bool | `true` |  |
| readinessProbe.failureThreshold | int | `3` |  |
| readinessProbe.httpGet.path | string | `"/health"` |  |
| readinessProbe.httpGet.port | string | `"http"` |  |
| readinessProbe.initialDelaySeconds | int | `5` |  |
| readinessProbe.periodSeconds | int | `5` |  |
| readinessProbe.timeoutSeconds | int | `3` |  |
| replicaCount | int | `1` |  |
| resources | object | `{}` |  |
| revisionHistoryLimit | int | `3` |  |
| securityContext.allowPrivilegeEscalation | bool | `false` |  |
| securityContext.capabilities.drop[0] | string | `"ALL"` |  |
| securityContext.readOnlyRootFilesystem | bool | `true` |  |
| securityContext.runAsNonRoot | bool | `true` |  |
| securityContext.runAsUser | int | `1001` |  |
| securityContext.seccompProfile.type | string | `"RuntimeDefault"` |  |
| service.port | int | `8002` |  |
| service.type | string | `"ClusterIP"` |  |
| serviceAccount.annotations | object | `{}` |  |
| serviceAccount.automount | bool | `true` |  |
| serviceAccount.create | bool | `true` |  |
| serviceAccount.name | string | `""` |  |
| tolerations | list | `[]` |  |
| volumeMounts[0].mountPath | string | `"/tmp"` |  |
| volumeMounts[0].name | string | `"tmp"` |  |
| volumes[0].emptyDir | object | `{}` |  |
| volumes[0].name | string | `"tmp"` |  |
| vpa.controlledResources[0] | string | `"cpu"` |  |
| vpa.controlledResources[1] | string | `"memory"` |  |
| vpa.controlledValues | string | `"RequestsAndLimits"` |  |
| vpa.enabled | bool | `false` |  |
| vpa.maxAllowed | object | `{}` |  |
| vpa.minAllowed.cpu | string | `"50m"` |  |
| vpa.minAllowed.memory | string | `"128Mi"` |  |
| vpa.updateMode | string | `"InPlaceOrRecreate"` |  |
