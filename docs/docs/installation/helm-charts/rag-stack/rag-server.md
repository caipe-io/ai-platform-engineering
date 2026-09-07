---
id: rag-server-chart
sidebar_label: rag-server
---

:::caution Auto-generated
This page is auto-generated from the Helm chart source. Do not edit directly.
Regenerate with `make docs-helm-charts`.
:::

# rag-server

RAG server

| | |
|---|---|
| **Version** | `0.5.68` |
| **Type** | application |

## Quick Start

```bash
# Add and install the chart
helm install rag-server oci://ghcr.io/cnoe-io/charts/rag-server --version 0.5.68

# Upgrade an existing release
helm upgrade rag-server oci://ghcr.io/cnoe-io/charts/rag-server --version 0.5.68
```

## Customizing Values

Override default values using `--set` flags or a custom values file:

```bash
# Override individual values
helm install rag-server oci://ghcr.io/cnoe-io/charts/rag-server --version 0.5.68 \
  --set replicaCount=2

# Use a custom values file
helm install rag-server oci://ghcr.io/cnoe-io/charts/rag-server --version 0.5.68 \
  -f custom-values.yaml

# Show all configurable values
helm show values oci://ghcr.io/cnoe-io/charts/rag-server --version 0.5.68
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
| enableGraphRag | bool | `true` |  |
| env | object | `{}` |  |
| envFrom | list | `[]` |  |
| extraVolumes | list | `[]` |  |
| fullnameOverride | string | `"rag-server"` |  |
| image.pullPolicy | string | `"IfNotPresent"` |  |
| image.repository | string | `"ghcr.io/caipe-io/caipe-rag-server"` |  |
| image.tag | string | `""` |  |
| imagePullSecrets | list | `[]` |  |
| initContainers | list | `[]` |  |
| livenessProbe.failureThreshold | int | `3` |  |
| livenessProbe.httpGet.path | string | `"/health"` |  |
| livenessProbe.httpGet.port | string | `"http"` |  |
| livenessProbe.periodSeconds | int | `10` |  |
| livenessProbe.timeoutSeconds | int | `5` |  |
| llmSecrets.secretName | string | `"llm-secret"` |  |
| nameOverride | string | `""` |  |
| nodeSelector | object | `{}` |  |
| podAnnotations | object | `{}` |  |
| podLabels | object | `{}` |  |
| podSecurityContext.runAsNonRoot | bool | `true` |  |
| readinessProbe.failureThreshold | int | `3` |  |
| readinessProbe.httpGet.path | string | `"/healthz"` |  |
| readinessProbe.httpGet.port | string | `"http"` |  |
| readinessProbe.periodSeconds | int | `5` |  |
| readinessProbe.timeoutSeconds | int | `3` |  |
| replicaCount | int | `1` |  |
| resources | object | `{}` |  |
| revisionHistoryLimit | int | `3` |  |
| securityContext.allowPrivilegeEscalation | bool | `false` |  |
| securityContext.capabilities.drop[0] | string | `"ALL"` |  |
| securityContext.readOnlyRootFilesystem | bool | `false` |  |
| securityContext.runAsNonRoot | bool | `true` |  |
| securityContext.runAsUser | int | `1001` |  |
| securityContext.seccompProfile.type | string | `"RuntimeDefault"` |  |
| service.port | int | `9446` |  |
| service.type | string | `"ClusterIP"` |  |
| serviceAccount.annotations | object | `{}` |  |
| serviceAccount.automount | bool | `false` |  |
| serviceAccount.create | bool | `false` |  |
| serviceAccount.name | string | `""` |  |
| startupProbe.failureThreshold | int | `30` |  |
| startupProbe.httpGet.path | string | `"/health"` |  |
| startupProbe.httpGet.port | string | `"http"` |  |
| startupProbe.initialDelaySeconds | int | `10` |  |
| startupProbe.periodSeconds | int | `10` |  |
| startupProbe.timeoutSeconds | int | `5` |  |
| tolerations | list | `[]` |  |
| vpa.controlledResources[0] | string | `"cpu"` |  |
| vpa.controlledResources[1] | string | `"memory"` |  |
| vpa.controlledValues | string | `"RequestsAndLimits"` |  |
| vpa.enabled | bool | `false` |  |
| vpa.maxAllowed | object | `{}` |  |
| vpa.minAllowed.cpu | string | `"50m"` |  |
| vpa.minAllowed.memory | string | `"128Mi"` |  |
| vpa.updateMode | string | `"InPlaceOrRecreate"` |  |
